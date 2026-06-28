package api

import (
	"os"
	"strings"
	"time"
)

// Config is the apiserver configuration, read from environment (CONTRACT §6).
type Config struct {
	Addr        string // APISERVER_ADDR, default :8090
	DatabaseURL string // DATABASE_URL

	// MaxBatchVariants caps how many variants one batch may declare
	// (SP_MAX_BATCH_VARIANTS, default 10000). Bounds resource use so a single
	// request can't queue unbounded real EnergyPlus runs (audit #8). Generous
	// enough for the documented "thousands of variants" sweeps.
	MaxBatchVariants int

	// AllowedEngineVersions is the set of EnergyPlus versions submissions may
	// target (SP_ALLOWED_ENGINE_VERSIONS, comma-separated). Empty means accept
	// any version — kept flexible for local/dev where no RunnerPool list exists.
	// Prevents M-1: a typo'd version that no RunnerPool serves would otherwise
	// queue forever with no error.
	AllowedEngineVersions map[string]struct{}

	// --- Object storage / presigned URLs (CONTRACT §4/§6, presigned-URLs) ----
	S3Endpoint       string        // S3_ENDPOINT (in-cluster, used for listing)
	S3PublicEndpoint string        // S3_PUBLIC_ENDPOINT (client-reachable; signs URLs, A4)
	S3AccessKey      string        // S3_ACCESS_KEY
	S3SecretKey      string        // S3_SECRET_KEY
	S3Region         string        // S3_REGION
	BucketModels     string        // S3_BUCKET_MODELS
	BucketWeather    string        // S3_BUCKET_WEATHER
	BucketResults    string        // S3_BUCKET_RESULTS
	PresignExpiry    time.Duration // SP_PRESIGN_EXPIRY_SECONDS (default 300s, ≤900s; A6)
}

// LoadConfig reads configuration from the environment, applying CONTRACT §6
// defaults.
func LoadConfig() Config {
	expiry := time.Duration(envInt("SP_PRESIGN_EXPIRY_SECONDS", 300)) * time.Second
	if expiry <= 0 || expiry > 15*time.Minute {
		expiry = 5 * time.Minute // clamp to the ≤15m bound (A6)
	}
	return Config{
		Addr:                  envDefault("APISERVER_ADDR", ":8090"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		MaxBatchVariants:      envInt("SP_MAX_BATCH_VARIANTS", 10000),
		AllowedEngineVersions: parseVersionSet(os.Getenv("SP_ALLOWED_ENGINE_VERSIONS")),

		S3Endpoint:       os.Getenv("S3_ENDPOINT"),
		S3PublicEndpoint: os.Getenv("S3_PUBLIC_ENDPOINT"),
		S3AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:      os.Getenv("S3_SECRET_KEY"),
		S3Region:         envDefault("S3_REGION", "us-east-1"),
		BucketModels:     envDefault("S3_BUCKET_MODELS", "models"),
		BucketWeather:    envDefault("S3_BUCKET_WEATHER", "weather"),
		BucketResults:    envDefault("S3_BUCKET_RESULTS", "results"),
		PresignExpiry:    expiry,
	}
}

// EngineVersionAllowed reports whether v may be submitted. An empty allow-list
// accepts any version.
func (c Config) EngineVersionAllowed(v string) bool {
	if len(c.AllowedEngineVersions) == 0 {
		return true
	}
	_, ok := c.AllowedEngineVersions[v]
	return ok
}

// parseVersionSet splits a comma-separated env value into a set, trimming
// whitespace and dropping empties.
func parseVersionSet(raw string) map[string]struct{} {
	set := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(part); v != "" {
			set[v] = struct{}{}
		}
	}
	return set
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}
