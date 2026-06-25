package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/synergyplus/synergyplus/internal/store"
)

// --- fakes --------------------------------------------------------------------

const (
	testKey    = "test-key"
	testUserID = "11111111-1111-1111-1111-111111111111"
	otherUser  = "22222222-2222-2222-2222-222222222222"
)

// fakeStore implements dataStore for handler tests (no Postgres).
type fakeStore struct {
	sims    map[string]*store.Simulation
	results map[string]*store.Result
}

func (f *fakeStore) UserIDForKeyHash(_ context.Context, keyHash string) (string, error) {
	if keyHash == HashAPIKey(testKey) {
		return testUserID, nil
	}
	return "", store.ErrNotFound
}
func (f *fakeStore) GetSimulation(_ context.Context, id string) (*store.Simulation, error) {
	if s, ok := f.sims[id]; ok {
		return s, nil
	}
	return nil, store.ErrNotFound
}
func (f *fakeStore) GetResult(_ context.Context, h string) (*store.Result, error) {
	if r, ok := f.results[h]; ok {
		return r, nil
	}
	return nil, store.ErrNotFound
}
func (f *fakeStore) HasResult(_ context.Context, h string) (bool, error) {
	_, ok := f.results[h]
	return ok, nil
}
func (f *fakeStore) InsertSimulation(context.Context, store.InsertSimulationParams) (string, string, error) {
	return "", "", nil
}
func (f *fakeStore) ListBatchSimulations(context.Context, string, int, int) ([]store.Simulation, int, error) {
	return nil, 0, nil
}
func (f *fakeStore) CreateBatch(context.Context, string, int, *string) (string, error) {
	return "", nil
}
func (f *fakeStore) GetBatch(context.Context, string) (*store.Batch, error) {
	return nil, store.ErrNotFound
}
func (f *fakeStore) FindBatchByIdempotencyKey(context.Context, string, string) (*store.Batch, error) {
	return nil, store.ErrNotFound
}

// fakePresigner implements presignClient. It records the bucket/key it was asked
// to sign and returns deterministic URLs.
type fakePresigner struct {
	putBucket, putKey string
	objects           []storageObject
}

func (p *fakePresigner) PresignPut(_ context.Context, bucket, key string) (string, error) {
	p.putBucket, p.putKey = bucket, key
	return "http://localhost:9000/" + bucket + "/" + key + "?sig=PUT", nil
}
func (p *fakePresigner) PresignGet(_ context.Context, bucket, key string) (string, error) {
	return "http://localhost:9000/" + bucket + "/" + key + "?sig=GET", nil
}
func (p *fakePresigner) List(_ context.Context, _, _ string) ([]storageObject, error) {
	return p.objects, nil
}
func (p *fakePresigner) ExpiresIn() time.Duration { return 5 * time.Minute }

func testServer(store dataStore, presigner presignClient) *Server {
	return NewServer(store, nil, presigner, LoadConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func do(t *testing.T, srv *Server, method, target, auth, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	rr := httptest.NewRecorder()
	srv.Router().ServeHTTP(rr, req)
	return rr
}

// --- POST /v1/uploads ---------------------------------------------------------

func TestCreateUpload_OK(t *testing.T) {
	p := &fakePresigner{}
	srv := testServer(&fakeStore{}, p)
	rr := do(t, srv, http.MethodPost, "/v1/uploads", testKey,
		`{"kind":"model","filename":"baseline.idf","sha256":"abc123"}`)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var resp createUploadResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Method != http.MethodPut {
		t.Errorf("method = %q, want PUT", resp.Method)
	}
	if resp.Ref != "s3://models/uploads/abc123-baseline.idf" {
		t.Errorf("ref = %q", resp.Ref)
	}
	if !strings.HasPrefix(resp.URL, "http://localhost:9000/") {
		t.Errorf("url not client-reachable: %q", resp.URL) // A4
	}
	if resp.ExpiresIn <= 0 || resp.ExpiresIn > 900 {
		t.Errorf("expiresIn = %d, want 0<..<=900 (A6)", resp.ExpiresIn)
	}
	if p.putBucket != "models" || p.putKey != "uploads/abc123-baseline.idf" {
		t.Errorf("presigned %s/%s, want models/uploads/abc123-baseline.idf", p.putBucket, p.putKey)
	}
}

func TestCreateUpload_WeatherBucket(t *testing.T) {
	p := &fakePresigner{}
	srv := testServer(&fakeStore{}, p)
	rr := do(t, srv, http.MethodPost, "/v1/uploads", testKey,
		`{"kind":"weather","filename":"chicago.epw","sha256":"def"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	if p.putBucket != "weather" {
		t.Errorf("bucket = %q, want weather", p.putBucket)
	}
}

func TestCreateUpload_BadKind(t *testing.T) {
	srv := testServer(&fakeStore{}, &fakePresigner{})
	rr := do(t, srv, http.MethodPost, "/v1/uploads", testKey,
		`{"kind":"bogus","filename":"x.idf"}`)
	if rr.Code != http.StatusBadRequest { // A7
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestCreateUpload_PathTraversalSanitized(t *testing.T) {
	p := &fakePresigner{}
	srv := testServer(&fakeStore{}, p)
	rr := do(t, srv, http.MethodPost, "/v1/uploads", testKey,
		`{"kind":"model","filename":"../../etc/passwd","sha256":"h"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	if strings.Contains(p.putKey, "..") || strings.Contains(p.putKey, "/etc/") {
		t.Errorf("key not sanitized: %q (C2)", p.putKey)
	}
}

func TestCreateUpload_NoAuth(t *testing.T) {
	srv := testServer(&fakeStore{}, &fakePresigner{})
	rr := do(t, srv, http.MethodPost, "/v1/uploads", "", `{"kind":"model","filename":"a.idf"}`)
	if rr.Code != http.StatusUnauthorized { // A7
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestCreateUpload_BadKey(t *testing.T) {
	srv := testServer(&fakeStore{}, &fakePresigner{})
	rr := do(t, srv, http.MethodPost, "/v1/uploads", "wrong", `{"kind":"model","filename":"a.idf"}`)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestCreateUpload_NoPresigner503(t *testing.T) {
	srv := testServer(&fakeStore{}, nil)
	rr := do(t, srv, http.MethodPost, "/v1/uploads", testKey, `{"kind":"model","filename":"a.idf"}`)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}

// --- GET /v1/results/{simId}/artifacts ---------------------------------------

func resultsFixture() *fakeStore {
	hash := "deadbeef"
	return &fakeStore{
		sims: map[string]*store.Simulation{
			"sim-mine":     {ID: "sim-mine", UserID: testUserID, ContentHash: &hash},
			"sim-other":    {ID: "sim-other", UserID: otherUser, ContentHash: &hash},
			"sim-noresult": {ID: "sim-noresult", UserID: testUserID, ContentHash: nil},
		},
		results: map[string]*store.Result{
			hash: {ContentHash: hash, Verdict: "ok"},
		},
	}
}

func TestListArtifacts_OK(t *testing.T) {
	p := &fakePresigner{objects: []storageObject{
		{Key: "deadbeef/eplusout.err", Size: 10},
		{Key: "deadbeef/synergy-summary.json", Size: 99},
	}}
	srv := testServer(resultsFixture(), p)
	rr := do(t, srv, http.MethodGet, "/v1/results/sim-mine/artifacts", testKey, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var resp listArtifactsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Artifacts) != 2 {
		t.Fatalf("artifacts = %d, want 2", len(resp.Artifacts))
	}
	names := map[string]bool{}
	for _, a := range resp.Artifacts {
		names[a.Name] = true
		if !strings.Contains(a.URL, "sig=GET") {
			t.Errorf("url not a presigned GET: %q", a.URL)
		}
	}
	if !names["eplusout.err"] || !names["synergy-summary.json"] {
		t.Errorf("names = %v, want basenames relative to prefix", names) // A2
	}
}

func TestListArtifacts_Authz404(t *testing.T) {
	srv := testServer(resultsFixture(), &fakePresigner{})
	rr := do(t, srv, http.MethodGet, "/v1/results/sim-other/artifacts", testKey, "")
	if rr.Code != http.StatusNotFound { // A5/C3 — not the caller's sim
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestListArtifacts_UnknownSim404(t *testing.T) {
	srv := testServer(resultsFixture(), &fakePresigner{})
	rr := do(t, srv, http.MethodGet, "/v1/results/nope/artifacts", testKey, "")
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestListArtifacts_NoResultYet404(t *testing.T) {
	srv := testServer(resultsFixture(), &fakePresigner{})
	rr := do(t, srv, http.MethodGet, "/v1/results/sim-noresult/artifacts", testKey, "")
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestListArtifacts_NoAuth401(t *testing.T) {
	srv := testServer(resultsFixture(), &fakePresigner{})
	rr := do(t, srv, http.MethodGet, "/v1/results/sim-mine/artifacts", "", "")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

// resultPrefix unit: prefer stored artifact_uri, else convention.
func TestResultPrefix(t *testing.T) {
	uri := "s3://results/abc123"
	b, p := resultPrefix(&store.Result{ArtifactURI: &uri}, "abc123", "results")
	if b != "results" || p != "abc123/" {
		t.Errorf("got %s/%s, want results/abc123/", b, p)
	}
	b, p = resultPrefix(&store.Result{}, "xyz", "results")
	if b != "results" || p != "xyz/" {
		t.Errorf("fallback got %s/%s, want results/xyz/", b, p)
	}
}
