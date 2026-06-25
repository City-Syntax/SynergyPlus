package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// apiKeyVector is one shared raw-key -> sha256 hex pair. The same fixture
// (testdata/api_key_vectors.json at the repo root) is consumed by the portal's
// hashKey test, pinning both sides of the apiserver<->portal hash seam (ADR-0014,
// CONTRACT §3) to identical values. The sha256 digests in the fixture are
// computed independently of the code under test.
type apiKeyVector struct {
	Raw    string `json:"raw"`
	SHA256 string `json:"sha256"`
}

func loadAPIKeyVectors(t *testing.T) []apiKeyVector {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "api_key_vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var vectors []apiKeyVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(vectors) == 0 {
		t.Fatalf("no vectors in %s", path)
	}
	return vectors
}

func TestHashAPIKeyMatchesSharedVectors(t *testing.T) {
	for _, v := range loadAPIKeyVectors(t) {
		got := HashAPIKey(v.Raw)
		if got != v.SHA256 {
			t.Errorf("HashAPIKey(%q) = %s, want %s", v.Raw, got, v.SHA256)
		}
	}
}
