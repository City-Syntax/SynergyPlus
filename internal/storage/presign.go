// Package storage mints short-lived presigned S3 URLs so researchers transfer
// files with only their API key — the apiserver's own S3 credentials never leave
// the cluster (ACCEPTANCE A3). It wraps an S3-compatible endpoint (MinIO locally,
// AWS S3 in the cloud) via the minio-go client. In addition to presigned URL
// minting (PresignPut, PresignGet), the Presigner also owns direct in-cluster
// object listing via List, which enumerates artifacts without client exposure.
//
// Endpoint split (ACCEPTANCE A4): the URLs are presigned against
// S3_PUBLIC_ENDPOINT (falling back to S3_ENDPOINT) so the host baked into the
// signature is reachable from the researcher's machine — locally
// http://localhost:9000, on AWS the public S3 host. The signature only covers
// the host + path + query, so presigning against the public host and uploading
// there is valid as long as the credentials match.
package storage

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Presigner mints presigned PUT/GET URLs against an S3-compatible store and
// also performs direct in-cluster object listing via List (not just presigned
// URL minting).
//
// Two clients on purpose: signClient is pointed at the client-reachable public
// endpoint so minted URLs are signed for a host the researcher can reach (A4);
// listClient is pointed at the in-cluster endpoint so the apiserver itself can
// enumerate objects (the public host may be unreachable from inside the
// cluster). Presigning is an offline operation, so signing for one host while
// the apiserver lists via another is correct.
type Presigner struct {
	signClient *minio.Client
	listClient *minio.Client
	expiry     time.Duration
}

// Object is one listed result artifact.
type Object struct {
	Key  string
	Size int64
}

// Config carries the S3 connection + presign settings (CONTRACT §6).
type Config struct {
	// Endpoint is where the apiserver lists objects (in-cluster S3_ENDPOINT).
	Endpoint string
	// PublicEndpoint is the client-reachable host URLs are signed against
	// (S3_PUBLIC_ENDPOINT, falls back to Endpoint). ACCEPTANCE A4.
	PublicEndpoint string
	AccessKey      string
	SecretKey      string
	Region         string
	// Expiry is how long minted URLs stay valid (ACCEPTANCE A6, ≤15m).
	Expiry time.Duration
}

// parseEndpoint splits an http(s)://host:port endpoint into (host:port, secure).
func parseEndpoint(endpoint string) (string, bool, error) {
	if endpoint == "" {
		return "", false, errors.New("empty S3 endpoint")
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", false, fmt.Errorf("parse endpoint %q: %w", endpoint, err)
	}
	if u.Host == "" {
		// Tolerate a bare host:port with no scheme.
		return endpoint, false, nil
	}
	return u.Host, u.Scheme == "https", nil
}

// New builds a Presigner. The sign client talks to PublicEndpoint (URLs are
// client-reachable, A4); the list client talks to the in-cluster Endpoint.
//
// Credentials: a static V4 key when AccessKey is set (local MinIO, or an
// explicit key); otherwise the AWS credential chain via minio-go's IAM provider,
// which on EKS picks up the pod's IRSA web-identity role. That lets the apiserver
// presign with its own scoped S3 permissions and NO static secret ever exists.
// Presign expiry is short (≤15m, A6), well within the IRSA temp-credential TTL.
func New(cfg Config) (*Presigner, error) {
	var creds *credentials.Credentials
	if cfg.AccessKey != "" {
		creds = credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, "")
	} else {
		creds = credentials.NewIAM("")
	}

	// An explicit S3_ENDPOINT (MinIO) wins; otherwise sign against the regional
	// AWS S3 host, reachable by both the researcher and the apiserver, so the
	// public/in-cluster split collapses to one endpoint.
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = awsS3Endpoint(cfg.Region)
	}
	pub := cfg.PublicEndpoint
	if pub == "" {
		pub = endpoint
	}
	signClient, err := newClient(pub, creds, cfg.Region)
	if err != nil {
		return nil, fmt.Errorf("build sign client: %w", err)
	}
	listClient, err := newClient(endpoint, creds, cfg.Region)
	if err != nil {
		return nil, fmt.Errorf("build list client: %w", err)
	}

	expiry := cfg.Expiry
	if expiry <= 0 {
		expiry = 5 * time.Minute
	}
	return &Presigner{signClient: signClient, listClient: listClient, expiry: expiry}, nil
}

// awsS3Endpoint returns the regional AWS S3 HTTPS endpoint for region. The https
// scheme is load-bearing: parseEndpoint derives Secure from it.
func awsS3Endpoint(region string) string {
	if region == "" {
		region = "us-east-1"
	}
	return "https://s3." + region + ".amazonaws.com"
}

func newClient(endpoint string, creds *credentials.Credentials, region string) (*minio.Client, error) {
	host, secure, err := parseEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	return minio.New(host, &minio.Options{Creds: creds, Secure: secure, Region: region})
}

// ExpiresIn returns the presigned-URL lifetime.
func (p *Presigner) ExpiresIn() time.Duration { return p.expiry }

// PresignPut mints a presigned PUT URL for bucket/key. A leaked URL can only
// write that exact object (ACCEPTANCE C2). Returns the presigned URL.
func (p *Presigner) PresignPut(ctx context.Context, bucket, key string) (string, error) {
	u, err := p.signClient.PresignedPutObject(ctx, bucket, key, p.expiry)
	if err != nil {
		return "", fmt.Errorf("presign put %s/%s: %w", bucket, key, err)
	}
	return u.String(), nil
}

// PresignGet mints a presigned GET URL for bucket/key (ACCEPTANCE A2/C3).
func (p *Presigner) PresignGet(ctx context.Context, bucket, key string) (string, error) {
	u, err := p.signClient.PresignedGetObject(ctx, bucket, key, p.expiry, url.Values{})
	if err != nil {
		return "", fmt.Errorf("presign get %s/%s: %w", bucket, key, err)
	}
	return u.String(), nil
}

// List returns every object under bucket/prefix (non-directory). Used to
// enumerate a result's artifacts (ACCEPTANCE A2).
func (p *Presigner) List(ctx context.Context, bucket, prefix string) ([]Object, error) {
	var out []Object
	for obj := range p.listClient.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	}) {
		if obj.Err != nil {
			return nil, fmt.Errorf("list %s/%s: %w", bucket, prefix, obj.Err)
		}
		if strings.HasSuffix(obj.Key, "/") {
			continue
		}
		out = append(out, Object{Key: obj.Key, Size: obj.Size})
	}
	return out, nil
}
