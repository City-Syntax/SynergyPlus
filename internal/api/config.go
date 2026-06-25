package api

import (
	"os"
	"strings"
)

// Config is the apiserver configuration, read from environment (CONTRACT §6).
type Config struct {
	Addr        string // APISERVER_ADDR, default :8090
	DatabaseURL string // DATABASE_URL
	PerUserCap  int    // SP_PER_USER_CAP (informational here; enforced in claim query)

	// AllowedEngineVersions is the set of EnergyPlus versions submissions may
	// target (SP_ALLOWED_ENGINE_VERSIONS, comma-separated). Empty means accept
	// any version — kept flexible for local/dev where no RunnerPool list exists.
	// Prevents M-1: a typo'd version that no RunnerPool serves would otherwise
	// queue forever with no error.
	AllowedEngineVersions map[string]struct{}
}

// LoadConfig reads configuration from the environment, applying CONTRACT §6
// defaults.
func LoadConfig() Config {
	return Config{
		Addr:                  envDefault("APISERVER_ADDR", ":8090"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		PerUserCap:            envInt("SP_PER_USER_CAP", 50),
		AllowedEngineVersions: parseVersionSet(os.Getenv("SP_ALLOWED_ENGINE_VERSIONS")),
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
