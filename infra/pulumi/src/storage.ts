// S3 object storage — the ONE AWS application managed service we use.
//
// Three buckets matching CONTRACT §4 and the in-cluster MinIO layout:
//   - models   : input IDF/epJSON models
//   - weather  : EPW weather cache
//   - results  : raw artifacts (.err, *.sql, synergy-summary.json) under
//                results/<content_hash>/
//
// Retention (ADR-0008 / CONTRACT SP_ARTIFACT_TTL_DAYS): raw artifacts in the
// results bucket are regenerable from the Content Hash, so we expire them after
// a TTL. The .err + summary are small and kept by the result *index* row in
// Postgres, so a blanket TTL on the bucket is acceptable for the scaffold; a
// finer rule (prefix-scoped) can replace it later.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig } from "./config";

export interface Storage {
  modelsBucket: aws.s3.BucketV2;
  weatherBucket: aws.s3.BucketV2;
  resultsBucket: aws.s3.BucketV2;
  // Convenience: all three bucket ARNs (+ their /* object ARNs) for IAM scoping.
  bucketArns: pulumi.Output<string>[];
  objectArns: pulumi.Output<string>[];
  // Logical names exposed to the app as S3_BUCKET_* env (CONTRACT §6).
  names: { models: pulumi.Output<string>; weather: pulumi.Output<string>; results: pulumi.Output<string> };
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi" };

// Default artifact TTL (days) for the results bucket lifecycle rule.
const RESULTS_TTL_DAYS = 30;

function bucket(logical: string): aws.s3.BucketV2 {
  return new aws.s3.BucketV2(`synergy-${logical}`, {
    // Let AWS append a random suffix so bucket names stay globally unique
    // across stacks/accounts without a manual collision dance.
    bucketPrefix: `synergyplus-${logical}-`,
    forceDestroy: true, // scaffold convenience: allow teardown of non-empty buckets
    tags: { ...TAGS, Name: `synergy-${logical}`, Role: logical },
  });
}

// Block all public access — pods reach S3 via IRSA, presigned URLs are minted
// server-side. Nothing here should ever be public.
function lockDown(name: string, b: aws.s3.BucketV2) {
  new aws.s3.BucketPublicAccessBlock(`synergy-${name}-pab`, {
    bucket: b.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
  new aws.s3.BucketServerSideEncryptionConfigurationV2(`synergy-${name}-sse`, {
    bucket: b.id,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
  });
  new aws.s3.BucketVersioningV2(`synergy-${name}-ver`, {
    bucket: b.id,
    versioningConfiguration: { status: "Enabled" },
  });
}

export function createStorage(_c: SynergyConfig): Storage {
  const models = bucket("models");
  const weather = bucket("weather");
  const results = bucket("results");

  for (const [name, b] of [
    ["models", models],
    ["weather", weather],
    ["results", results],
  ] as const) {
    lockDown(name, b);
  }

  // Lifecycle: expire raw result artifacts after the TTL (regenerable from the
  // Content Hash). Also clean up incomplete multipart uploads everywhere.
  new aws.s3.BucketLifecycleConfigurationV2("synergy-results-lifecycle", {
    bucket: results.id,
    rules: [
      {
        id: "expire-raw-artifacts",
        status: "Enabled",
        filter: {}, // whole bucket; tighten to a prefix to keep .err/summary forever
        expiration: { days: RESULTS_TTL_DAYS },
        noncurrentVersionExpiration: { noncurrentDays: 7 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 3 },
      },
    ],
  });

  const arn = (b: aws.s3.BucketV2) => b.arn;
  const objArn = (b: aws.s3.BucketV2) => pulumi.interpolate`${b.arn}/*`;

  return {
    modelsBucket: models,
    weatherBucket: weather,
    resultsBucket: results,
    bucketArns: [arn(models), arn(weather), arn(results)],
    objectArns: [objArn(models), objArn(weather), objArn(results)],
    names: { models: models.bucket, weather: weather.bucket, results: results.bucket },
  };
}
