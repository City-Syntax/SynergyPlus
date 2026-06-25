package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/synergyplus/synergyplus/internal/queue"
	"github.com/synergyplus/synergyplus/internal/store"
)

// Server holds the apiserver's dependencies and implements the CONTRACT §3 HTTP
// surface. The store is the Postgres source of truth; the expander materializes
// batches into queue rows.
type Server struct {
	store    *store.Store
	expander *queue.Expander
	cfg      Config
	log      *slog.Logger
}

// NewServer constructs a Server.
func NewServer(s *store.Store, expander *queue.Expander, cfg Config, log *slog.Logger) *Server {
	return &Server{store: s, expander: expander, cfg: cfg, log: log}
}

// Router builds the chi router: /healthz is open; everything under /v1 is behind
// the Bearer-token auth middleware (CONTRACT §3).
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/v1", func(r chi.Router) {
		r.Use(s.authMiddleware)
		r.Post("/simulations", s.handleCreateSimulation)
		r.Get("/simulations/{id}", s.handleGetSimulation)
		r.Post("/batches", s.handleCreateBatch)
		r.Get("/batches/{id}", s.handleGetBatch)
		r.Get("/batches/{id}/simulations", s.handleListBatchSimulations)
		r.Get("/results/{simId}", s.handleGetResult)
	})

	return r
}

// --- response helpers ---------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
