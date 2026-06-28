package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/synergyplus/synergyplus/internal/store"
)

// authzFixture seeds sims, results, and batches owned by the caller (testUserID)
// and by someone else (otherUser), so the object-level authz checks (audit #1)
// can be exercised for each read endpoint.
func authzFixture() *fakeStore {
	hash := "deadbeef"
	return &fakeStore{
		sims: map[string]*store.Simulation{
			"sim-mine":  {ID: "sim-mine", UserID: testUserID, State: "succeeded", ContentHash: &hash},
			"sim-other": {ID: "sim-other", UserID: otherUser, State: "succeeded", ContentHash: &hash},
		},
		results: map[string]*store.Result{
			hash: {ContentHash: hash, Verdict: "clean"},
		},
		batches: map[string]*store.Batch{
			"batch-mine":  {ID: "batch-mine", UserID: testUserID, State: "done", Total: 1},
			"batch-other": {ID: "batch-other", UserID: otherUser, State: "done", Total: 1},
		},
		batchSims: map[string][]store.Simulation{
			"batch-mine":  {{ID: "s1", UserID: testUserID, State: "succeeded"}},
			"batch-other": {{ID: "s2", UserID: otherUser, State: "succeeded"}},
		},
	}
}

// Each read endpoint must return 404 (not 403/200) for an object the caller
// doesn't own, and 200 for one they do — the IDOR fix (audit #1).
func TestReadEndpoints_ObjectAuthz(t *testing.T) {
	cases := []struct {
		name, target string
	}{
		{"get-simulation", "/v1/simulations/%s"},
		{"get-result", "/v1/results/%s"},
		{"get-batch", "/v1/batches/%s"},
		{"list-batch-sims", "/v1/batches/%s/simulations"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := testServer(authzFixture(), &fakePresigner{})

			mine := "sim-mine"
			other := "sim-other"
			if strings.Contains(c.target, "batches") {
				mine, other = "batch-mine", "batch-other"
			}

			if rr := do(t, srv, http.MethodGet, fmt.Sprintf(c.target, mine), testKey, ""); rr.Code != http.StatusOK {
				t.Errorf("own object: status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
			}
			// Another user's object must be indistinguishable from a missing one.
			if rr := do(t, srv, http.MethodGet, fmt.Sprintf(c.target, other), testKey, ""); rr.Code != http.StatusNotFound {
				t.Errorf("other's object: status = %d, want 404", rr.Code)
			}
			if rr := do(t, srv, http.MethodGet, fmt.Sprintf(c.target, "does-not-exist"), testKey, ""); rr.Code != http.StatusNotFound {
				t.Errorf("unknown object: status = %d, want 404", rr.Code)
			}
		})
	}
}

// Submitting a model/weather ref that isn't an s3:// URI into the kind's bucket
// must be rejected at submit time (audit #5), before it can be stored and fetched
// by the runner.
func TestCreateSimulation_RejectsHostileRefs(t *testing.T) {
	bad := []string{
		`{"engineVersion":"24.1.0","model":{"ref":"file:///etc/passwd"},"weather":{"ref":"s3://weather/x.epw"}}`,
		`{"engineVersion":"24.1.0","model":{"ref":"/var/run/secrets/token"},"weather":{"ref":"s3://weather/x.epw"}}`,
		`{"engineVersion":"24.1.0","model":{"ref":"s3://results/other-hash/eplusout.sql"},"weather":{"ref":"s3://weather/x.epw"}}`,
		`{"engineVersion":"24.1.0","model":{"ref":"s3://models/ok.idf"},"weather":{"ref":"s3://results/leak/"}}`,
	}
	for _, body := range bad {
		srv := testServer(authzFixture(), &fakePresigner{})
		if rr := do(t, srv, http.MethodPost, "/v1/simulations", testKey, body); rr.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400 for hostile ref\n  body=%s", rr.Code, body)
		}
	}
}

func TestCreateSimulation_AcceptsValidRefs(t *testing.T) {
	srv := testServer(authzFixture(), &fakePresigner{})
	body := `{"engineVersion":"24.1.0","model":{"ref":"s3://models/uploads/x.idf"},"weather":{"ref":"s3://weather/uploads/x.epw"}}`
	if rr := do(t, srv, http.MethodPost, "/v1/simulations", testKey, body); rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", rr.Code, rr.Body.String())
	}
}

func TestCreateBatch_RejectsHostileVariantRef(t *testing.T) {
	srv := testServer(authzFixture(), &fakePresigner{})
	body := `{"engineVersion":"24.1.0","weather":{"ref":"s3://weather/x.epw"},"variants":[{"model":{"ref":"s3://models/ok.idf"}},{"model":{"ref":"file:///etc/passwd"}}]}`
	if rr := do(t, srv, http.MethodPost, "/v1/batches", testKey, body); rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for hostile variant ref", rr.Code)
	}
}

// A batch may not declare more variants than the configured cap (audit #8).
func TestCreateBatch_VariantCap(t *testing.T) {
	t.Setenv("SP_MAX_BATCH_VARIANTS", "1")
	srv := testServer(authzFixture(), &fakePresigner{})
	body := `{"engineVersion":"24.1.0","weather":{"ref":"s3://weather/x.epw"},"variants":[{"model":{"ref":"s3://models/a.idf"}},{"model":{"ref":"s3://models/b.idf"}}]}`
	if rr := do(t, srv, http.MethodPost, "/v1/batches", testKey, body); rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 over the variant cap", rr.Code)
	}
}
