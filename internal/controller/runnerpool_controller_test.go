package controller

import (
	"testing"

	synergyv1 "github.com/synergyplus/synergyplus/api/v1"
)

// TestRunnerImage covers the image-defaulting logic: an empty spec.Image derives
// the tag from spec.EngineVersion (ADR-0015), while an explicit image is honoured
// verbatim so a pinned digest or an override registry survives reconciliation.
func TestRunnerImage(t *testing.T) {
	tests := []struct {
		name          string
		image         string
		engineVersion string
		want          string
	}{
		{
			name:          "empty image derives tag from engineVersion",
			image:         "",
			engineVersion: "24.1.0",
			want:          "ghcr.io/city-syntax/synergyplus-runner:24.1.0",
		},
		{
			name:          "empty image with a different engineVersion",
			image:         "",
			engineVersion: "25.1.0",
			want:          "ghcr.io/city-syntax/synergyplus-runner:25.1.0",
		},
		{
			name:          "explicit image is preserved verbatim",
			image:         "ghcr.io/city-syntax/synergyplus-runner:24.1.0",
			engineVersion: "24.1.0",
			want:          "ghcr.io/city-syntax/synergyplus-runner:24.1.0",
		},
		{
			name:          "explicit image overrides engineVersion (e.g. pinned digest)",
			image:         "registry.example.com/runner@sha256:deadbeef",
			engineVersion: "24.1.0",
			want:          "registry.example.com/runner@sha256:deadbeef",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pool := &synergyv1.RunnerPool{
				Spec: synergyv1.RunnerPoolSpec{
					Image:         tt.image,
					EngineVersion: tt.engineVersion,
				},
			}
			if got := runnerImage(pool); got != tt.want {
				t.Errorf("runnerImage() = %q, want %q", got, tt.want)
			}
		})
	}
}
