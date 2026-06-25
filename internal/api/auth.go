package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/synergyplus/synergyplus/internal/store"
)

// ctxKey is the private context key type for request-scoped values.
type ctxKey int

const userIDKey ctxKey = iota

// HashAPIKey returns the sha256 hex digest of a raw API key — the exact value
// stored in app.api_keys.key_hash (CONTRACT §3). The portal must store keys the
// same way for auth to succeed.
func HashAPIKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// authMiddleware validates the Bearer token against app.api_keys (non-revoked)
// and stashes the resolved user_id in the request context. /healthz is exempt
// (handled by the router before this wraps). Returns 401 on any failure.
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		userID, err := s.store.UserIDForKeyHash(r.Context(), HashAPIKey(raw))
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "invalid or revoked api key")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "auth lookup failed")
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// userID extracts the authenticated user_id placed by authMiddleware.
func userID(ctx context.Context) string {
	v, _ := ctx.Value(userIDKey).(string)
	return v
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(prefix):])
	return tok, tok != ""
}
