package queue

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// contentHashVector mirrors one entry of testdata/content_hash_vectors.json.
// The same file is asserted against by the Python Runner suite
// (runner/tests/test_content_hash_vectors.py) so the two independent
// implementations of CONTRACT §2.1 cannot silently diverge: a one-byte drift
// in either ContentHash (Go) or content_hash (Python) fails a build.
type contentHashVector struct {
	Name          string `json:"name"`
	ModelSHA256   string `json:"model_sha256"`
	WeatherSHA256 string `json:"weather_sha256"`
	EngineVersion string `json:"engine_version"`
	Expected      string `json:"expected"`
}

func TestContentHashVectors(t *testing.T) {
	// Go tests run in their package dir (internal/queue); the shared vector
	// file lives at the repo root under testdata/.
	path := filepath.Join("..", "..", "testdata", "content_hash_vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared vector file %s: %v", path, err)
	}

	var vectors []contentHashVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(vectors) == 0 {
		t.Fatalf("no vectors found in %s", path)
	}

	for _, v := range vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			got := ContentHash(v.ModelSHA256, v.WeatherSHA256, v.EngineVersion)
			if got != v.Expected {
				t.Errorf("ContentHash(%q, %q, %q) = %q, want %q",
					v.ModelSHA256, v.WeatherSHA256, v.EngineVersion, got, v.Expected)
			}
		})
	}
}
