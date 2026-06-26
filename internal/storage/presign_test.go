package storage

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAwsS3Endpoint(t *testing.T) {
	cases := map[string]string{
		"ap-southeast-1": "https://s3.ap-southeast-1.amazonaws.com",
		"us-east-1":      "https://s3.us-east-1.amazonaws.com",
		"":               "https://s3.us-east-1.amazonaws.com", // empty defaults
	}
	for region, want := range cases {
		if got := awsS3Endpoint(region); got != want {
			t.Errorf("awsS3Endpoint(%q) = %q, want %q", region, got, want)
		}
	}
}

// When no endpoint is configured, New derives the regional AWS S3 host and signs
// against it. This is the same endpoint path the IRSA branch uses; we exercise it
// with a static key so presigning stays offline (no STS call).
func TestNewDerivesRegionalAwsEndpoint(t *testing.T) {
	p, err := New(Config{
		AccessKey: "AKIAEXAMPLE",
		SecretKey: "secretexample",
		Region:    "ap-southeast-1",
		Expiry:    10 * time.Minute,
		// Endpoint intentionally empty -> derive AWS host.
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	raw, err := p.PresignPut(context.Background(), "synergyplus-models-xyz", "uploads/abc-baseline.idf")
	if err != nil {
		t.Fatalf("PresignPut: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse presigned url %q: %v", raw, err)
	}
	if u.Scheme != "https" {
		t.Errorf("presigned URL scheme = %q, want https", u.Scheme)
	}
	// minio-go signs against the regional AWS S3 host (it uses the dualstack
	// variant by default, s3.dualstack.<region>.amazonaws.com — both are valid).
	if !strings.Contains(u.Host, "ap-southeast-1.amazonaws.com") {
		t.Errorf("presigned URL host = %q, want the regional AWS S3 host", u.Host)
	}
	if !strings.Contains(raw, "X-Amz-Signature") {
		t.Errorf("presigned URL missing SigV4 signature: %q", raw)
	}
}
