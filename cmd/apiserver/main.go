// Command apiserver is the SynergyPlus API gateway (CONTRACT §3). It validates
// API keys against Postgres, accepts simulation and batch submissions (writing
// queue rows, resolving the content-hash cache, expanding batches sync/async),
// serves status and results, and runs the Reaper goroutine that requeues
// expired leases. Submissions are Postgres rows, not Kubernetes objects (v0.2,
// ADR-0006). On boot it applies db/migrations/*.sql idempotently.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/synergyplus/synergyplus/internal/api"
	"github.com/synergyplus/synergyplus/internal/queue"
	"github.com/synergyplus/synergyplus/internal/storage"
	"github.com/synergyplus/synergyplus/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	cfg := api.LoadConfig()
	if cfg.DatabaseURL == "" {
		log.Error("DATABASE_URL is required")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("connect to postgres", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	migrationsDir := store.ResolveMigrationsDir()
	log.Info("applying migrations", "dir", migrationsDir)
	if err := st.Migrate(ctx, migrationsDir); err != nil {
		log.Error("migrate", "err", err)
		os.Exit(1)
	}

	expander := queue.NewExpander(st, log)
	reaper := queue.NewReaper(st, log)
	go reaper.Run(ctx)

	// Presigned-URL minting (optional): requires S3 endpoint + creds. When
	// unconfigured the /v1/uploads and /v1/results/{id}/artifacts endpoints
	// return 503; all other endpoints work regardless.
	var presigner *storage.Presigner
	if cfg.S3Endpoint != "" && cfg.S3AccessKey != "" {
		presigner, err = storage.New(storage.Config{
			Endpoint:       cfg.S3Endpoint,
			PublicEndpoint: cfg.S3PublicEndpoint,
			AccessKey:      cfg.S3AccessKey,
			SecretKey:      cfg.S3SecretKey,
			Region:         cfg.S3Region,
			Expiry:         cfg.PresignExpiry,
		})
		if err != nil {
			log.Error("init presigner", "err", err)
			os.Exit(1)
		}
		public := cfg.S3PublicEndpoint
		if public == "" {
			public = cfg.S3Endpoint
		}
		log.Info("presigned URLs enabled", "public_endpoint", public, "expiry", cfg.PresignExpiry)
	} else {
		log.Warn("presigned URLs disabled (S3_ENDPOINT/S3_ACCESS_KEY unset)")
	}

	srv := api.NewServer(st, expander, api.NewPresignerAdapter(presigner), cfg, log)
	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("apiserver listening", "addr", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
