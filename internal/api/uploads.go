package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/synergyplus/synergyplus/internal/storage"
	"github.com/synergyplus/synergyplus/internal/store"
)

// storageObject is the api-layer view of a listed result object (decoupled from
// the storage package so handlers can be tested with a fake presignClient).
type storageObject struct {
	Key  string
	Size int64
}

// PresignerAdapter wraps *storage.Presigner to satisfy presignClient (it adapts
// the returned []storage.Object slice to the api-local storageObject type).
type PresignerAdapter struct{ P *storage.Presigner }

// NewPresignerAdapter wraps p, returning nil if p is nil so a missing presigner
// stays a nil interface (the handlers then return 503).
func NewPresignerAdapter(p *storage.Presigner) presignClient {
	if p == nil {
		return nil
	}
	return &PresignerAdapter{P: p}
}

func (a *PresignerAdapter) PresignPut(ctx context.Context, bucket, key string) (string, error) {
	return a.P.PresignPut(ctx, bucket, key)
}

func (a *PresignerAdapter) PresignGet(ctx context.Context, bucket, key string) (string, error) {
	return a.P.PresignGet(ctx, bucket, key)
}

func (a *PresignerAdapter) ExpiresIn() time.Duration { return a.P.ExpiresIn() }

func (a *PresignerAdapter) List(ctx context.Context, bucket, prefix string) ([]storageObject, error) {
	objs, err := a.P.List(ctx, bucket, prefix)
	if err != nil {
		return nil, err
	}
	out := make([]storageObject, len(objs))
	for i, o := range objs {
		out[i] = storageObject{Key: o.Key, Size: o.Size}
	}
	return out, nil
}

// --- POST /v1/uploads ---------------------------------------------------------

type createUploadRequest struct {
	Kind     string `json:"kind"`     // "model" | "weather"
	Filename string `json:"filename"` // basename, used in the content-addressed key
	SHA256   string `json:"sha256,omitempty"`
}

type createUploadResponse struct {
	URL       string            `json:"url"`
	Ref       string            `json:"ref"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers,omitempty"`
	ExpiresIn int               `json:"expiresIn"` // seconds
}

// basenameSanitize replaces any character outside [A-Za-z0-9._-] so a crafted
// filename can't inject extra path segments or query into the object key (C2).
// path.Base already strips directory components; this guards the rest.
var basenameSanitize = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// handleCreateUpload mints a short-lived presigned PUT into the kind's bucket at
// a content-addressed key, and returns the s3:// ref to submit (ACCEPTANCE
// A1/A3/A4/A6). The PUT is scoped to that exact bucket+key (A5/C2).
func (s *Server) handleCreateUpload(w http.ResponseWriter, r *http.Request) {
	if s.presigner == nil {
		writeError(w, http.StatusServiceUnavailable, "presigned uploads not configured (no S3 endpoint)")
		return
	}
	var req createUploadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	var bucket string
	switch req.Kind {
	case "model":
		bucket = s.cfg.BucketModels
	case "weather":
		bucket = s.cfg.BucketWeather
	default:
		writeError(w, http.StatusBadRequest, `kind must be "model" or "weather"`)
		return
	}

	base := path.Base(strings.TrimSpace(req.Filename))
	base = basenameSanitize.ReplaceAllString(base, "_")
	if base == "" || base == "." || base == "/" {
		writeError(w, http.StatusBadRequest, "filename is required")
		return
	}

	// Content-addressed key: dedupes byte-identical uploads and feeds the
	// content-hash cache. The caller scopes via their key; the key itself binds
	// the URL to one object (A5/C2). Fall back to a per-user prefix when no
	// digest is supplied so distinct users can't collide on basename alone.
	var key string
	if req.SHA256 != "" {
		key = "uploads/" + req.SHA256 + "-" + base
	} else {
		key = "uploads/" + userID(r.Context()) + "/" + base
	}

	url, err := s.presigner.PresignPut(r.Context(), bucket, key)
	if err != nil {
		s.log.Error("presign put failed", "err", err)
		writeError(w, http.StatusInternalServerError, "could not mint upload url")
		return
	}

	writeJSON(w, http.StatusOK, createUploadResponse{
		URL:       url,
		Ref:       "s3://" + bucket + "/" + key,
		Method:    http.MethodPut,
		ExpiresIn: int(s.presigner.ExpiresIn().Seconds()),
	})
}

// --- GET /v1/results/{simId}/artifacts ---------------------------------------

type artifactEntry struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size,omitempty"`
}

type listArtifactsResponse struct {
	Artifacts []artifactEntry `json:"artifacts"`
}

// handleListArtifacts lists short-lived presigned GET URLs for every object
// under the result's s3://results/<hash>/ prefix (ACCEPTANCE A2). Returns 404
// if the sim isn't the caller's (authz; A5/C3) — indistinguishable from a
// missing sim so we don't leak existence.
func (s *Server) handleListArtifacts(w http.ResponseWriter, r *http.Request) {
	if s.presigner == nil {
		writeError(w, http.StatusServiceUnavailable, "presigned downloads not configured (no S3 endpoint)")
		return
	}
	simID := chi.URLParam(r, "simId")
	sim, err := s.store.GetSimulation(r.Context(), simID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "simulation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	// Authz: the sim must belong to the calling user (A5/C3).
	if sim.UserID != userID(r.Context()) {
		writeError(w, http.StatusNotFound, "simulation not found")
		return
	}
	if sim.ContentHash == nil {
		writeError(w, http.StatusNotFound, "no result yet")
		return
	}

	res, err := s.store.GetResult(r.Context(), *sim.ContentHash)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no result yet")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}

	bucket, prefix := resultPrefix(res, *sim.ContentHash, s.cfg.BucketResults)
	objs, err := s.presigner.List(r.Context(), bucket, prefix)
	if err != nil {
		s.log.Error("list artifacts failed", "err", err)
		writeError(w, http.StatusInternalServerError, "could not list artifacts")
		return
	}

	artifacts := make([]artifactEntry, 0, len(objs))
	for _, obj := range objs {
		url, err := s.presigner.PresignGet(r.Context(), bucket, obj.Key)
		if err != nil {
			s.log.Error("presign get failed", "key", obj.Key, "err", err)
			writeError(w, http.StatusInternalServerError, "could not mint download url")
			return
		}
		name := strings.TrimPrefix(obj.Key, prefix)
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			name = path.Base(obj.Key)
		}
		artifacts = append(artifacts, artifactEntry{Name: name, URL: url, Size: obj.Size})
	}

	writeJSON(w, http.StatusOK, listArtifactsResponse{Artifacts: artifacts})
}

// resultPrefix derives the (bucket, prefix) holding a result's artifacts. It
// prefers the stored artifact_uri (s3://results/<hash>/) and falls back to the
// CONTRACT §4 convention results/<content_hash>/.
func resultPrefix(res *store.Result, contentHash, defaultBucket string) (bucket, prefix string) {
	if res.ArtifactURI != nil && strings.HasPrefix(*res.ArtifactURI, "s3://") {
		b, key := parseS3URI(*res.ArtifactURI)
		if b != "" {
			if key != "" && !strings.HasSuffix(key, "/") {
				key += "/"
			}
			return b, key
		}
	}
	return defaultBucket, contentHash + "/"
}

// parseS3URI splits s3://bucket/key into (bucket, key). Returns empty strings if
// not an s3:// URI.
func parseS3URI(uri string) (bucket, key string) {
	rest, ok := strings.CutPrefix(uri, "s3://")
	if !ok {
		return "", ""
	}
	bucket, key, _ = strings.Cut(rest, "/")
	return bucket, key
}
