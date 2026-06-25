package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/synergyplus/synergyplus/internal/queue"
	"github.com/synergyplus/synergyplus/internal/store"
)

// --- request/response DTOs (CONTRACT §3) --------------------------------------

type artifactRef struct {
	Ref    string `json:"ref"`
	SHA256 string `json:"sha256,omitempty"`
}

type createSimulationRequest struct {
	EngineVersion  string          `json:"engineVersion"`
	Model          artifactRef     `json:"model"`
	Weather        artifactRef     `json:"weather"`
	Priority       *int            `json:"priority,omitempty"`
	ExtractionSpec json.RawMessage `json:"extractionSpec,omitempty"`
}

type createBatchRequest struct {
	EngineVersion string `json:"engineVersion"`
	Weather       artifactRef `json:"weather"`
	Variants      []struct {
		Model artifactRef `json:"model"`
		Name  string      `json:"name,omitempty"`
	} `json:"variants"`
	Priority       *int            `json:"priority,omitempty"`
	MaxParallelism *int            `json:"maxParallelism,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	ExtractionSpec json.RawMessage `json:"extractionSpec,omitempty"`
}

// --- POST /v1/simulations -----------------------------------------------------

func (s *Server) handleCreateSimulation(w http.ResponseWriter, r *http.Request) {
	var req createSimulationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.EngineVersion == "" || req.Model.Ref == "" || req.Weather.Ref == "" {
		writeError(w, http.StatusBadRequest, "engineVersion, model.ref and weather.ref are required")
		return
	}
	if !s.cfg.EngineVersionAllowed(req.EngineVersion) {
		writeError(w, http.StatusBadRequest, "unsupported engineVersion")
		return
	}
	priority := normalizePriority(req.Priority)

	hash := queue.ContentHash(req.Model.SHA256, req.Weather.SHA256, req.EngineVersion)

	// Resolve cache: a hit (with real input digests) is recorded succeeded and
	// never queued (ADR-0007 applied to single runs too).
	state := "queued"
	if req.Model.SHA256 != "" && req.Weather.SHA256 != "" {
		hit, err := s.store.HasResult(r.Context(), hash)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "cache lookup failed")
			return
		}
		if hit {
			state = "succeeded"
		}
	}

	id, gotState, err := s.store.InsertSimulation(r.Context(), store.InsertSimulationParams{
		UserID:         userID(r.Context()),
		EngineVersion:  req.EngineVersion,
		Priority:       priority,
		ModelRef:       req.Model.Ref,
		WeatherRef:     req.Weather.Ref,
		ModelSHA256:    optStr(req.Model.SHA256),
		WeatherSHA256:  optStr(req.Weather.SHA256),
		ExtractionSpec: rawJSON(req.ExtractionSpec),
		ContentHash:    hash,
		State:          state,
	})
	if err != nil {
		s.log.Error("insert simulation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create simulation")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id, "state": gotState})
}

// --- GET /v1/simulations/{id} -------------------------------------------------

func (s *Server) handleGetSimulation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sim, err := s.store.GetSimulation(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "simulation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}

	resp := map[string]any{"id": sim.ID, "state": sim.State}
	// Surface verdict + result inline when the run has a cached/completed result.
	if sim.ContentHash != nil {
		res, err := s.store.GetResult(r.Context(), *sim.ContentHash)
		if err == nil {
			resp["verdict"] = res.Verdict
			resp["result"] = resultPayload(res)
		}
	}
	if sim.Error != nil {
		resp["error"] = *sim.Error
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- POST /v1/batches ---------------------------------------------------------

func (s *Server) handleCreateBatch(w http.ResponseWriter, r *http.Request) {
	var req createBatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.EngineVersion == "" || req.Weather.Ref == "" || len(req.Variants) == 0 {
		writeError(w, http.StatusBadRequest, "engineVersion, weather.ref and at least one variant are required")
		return
	}
	if !s.cfg.EngineVersionAllowed(req.EngineVersion) {
		writeError(w, http.StatusBadRequest, "unsupported engineVersion")
		return
	}
	uid := userID(r.Context())
	priority := normalizePriority(req.Priority)

	// Idempotency: a prior batch with the same key returns the existing one.
	if req.IdempotencyKey != "" {
		if existing, err := s.store.FindBatchByIdempotencyKey(r.Context(), uid, req.IdempotencyKey); err == nil {
			writeJSON(w, http.StatusAccepted, map[string]string{"batchId": existing.ID, "state": existing.State})
			return
		} else if !errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, "idempotency lookup failed")
			return
		}
	}

	// total is fixed here and never rewritten; the rollup trigger owns counts/state.
	batchID, err := s.store.CreateBatch(r.Context(), uid, len(req.Variants), optStr(req.IdempotencyKey))
	if err != nil {
		// Unique-violation on idempotency_key from a concurrent submit: re-fetch.
		if req.IdempotencyKey != "" {
			if existing, ferr := s.store.FindBatchByIdempotencyKey(r.Context(), uid, req.IdempotencyKey); ferr == nil {
				writeJSON(w, http.StatusAccepted, map[string]string{"batchId": existing.ID, "state": existing.State})
				return
			}
		}
		s.log.Error("create batch failed", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create batch")
		return
	}

	variants := make([]queue.Variant, len(req.Variants))
	for i, v := range req.Variants {
		variants[i] = queue.Variant{ModelRef: v.Model.Ref, ModelSHA256: v.Model.SHA256, Name: v.Name}
	}
	spec := queue.ExpandSpec{
		BatchID:        batchID,
		UserID:         uid,
		EngineVersion:  req.EngineVersion,
		WeatherRef:     req.Weather.Ref,
		WeatherSHA256:  req.Weather.SHA256,
		Priority:       priority,
		ExtractionSpec: rawJSON(req.ExtractionSpec),
		Variants:       variants,
	}

	// ≤100 variants expand synchronously; larger goes async (CONTRACT §3).
	if len(variants) <= queue.SyncExpandThreshold {
		if err := s.expander.Expand(r.Context(), spec); err != nil {
			s.log.Error("sync batch expansion failed", "batch_id", batchID, "err", err)
			writeError(w, http.StatusInternalServerError, "batch expansion failed")
			return
		}
	} else {
		s.expander.ExpandAsync(spec)
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"batchId": batchID, "state": "expanding"})
}

// --- GET /v1/batches/{id} -----------------------------------------------------

func (s *Server) handleGetBatch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	b, err := s.store.GetBatch(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "batch not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": b.ID, "state": b.State, "total": b.Total, "succeeded": b.Succeeded, "failed": b.Failed,
	})
}

// --- GET /v1/batches/{id}/simulations -----------------------------------------

func (s *Server) handleListBatchSimulations(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit := queryInt(r, "limit", 50)
	offset := queryInt(r, "offset", 0)
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	sims, total, err := s.store.ListBatchSimulations(r.Context(), id, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	items := make([]map[string]any, 0, len(sims))
	for i := range sims {
		sim := &sims[i]
		item := map[string]any{"id": sim.ID, "state": sim.State}
		if sim.Error != nil {
			item["error"] = *sim.Error
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// --- GET /v1/results/{simId} --------------------------------------------------

func (s *Server) handleGetResult(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, resultPayload(res))
}

// --- helpers ------------------------------------------------------------------

// resultPayload shapes a result row to the CONTRACT §3 result envelope
// (verdict, metrics, artifactUri). metrics is passed through as raw JSON.
func resultPayload(res *store.Result) map[string]any {
	var metrics any
	if len(res.Metrics) > 0 {
		_ = json.Unmarshal(res.Metrics, &metrics)
	} else {
		metrics = map[string]any{}
	}
	var uri any
	if res.ArtifactURI != nil {
		uri = *res.ArtifactURI
	}
	return map[string]any{"verdict": res.Verdict, "metrics": metrics, "artifactUri": uri}
}

// normalizePriority clamps an optional priority to {0,1,2}, defaulting to 1
// (normal) per CONTRACT §2.
func normalizePriority(p *int) int {
	if p == nil {
		return 1
	}
	switch {
	case *p < 0:
		return 0
	case *p > 2:
		return 2
	default:
		return *p
	}
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func rawJSON(m json.RawMessage) []byte {
	if len(m) == 0 {
		return nil
	}
	return []byte(m)
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
