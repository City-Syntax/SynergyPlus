// S3 object storage — models / weather / results (CONTRACT §4).
//
// Same three buckets as the self-managed variant, but cloud-native hardened:
//   - SSE-KMS (a dedicated customer-managed key) instead of SSE-S3 (AES256),
//   - versioning on,
//   - lifecycle TTL on the results bucket (raw artifacts are regenerable from
//     the Content Hash, ADR-0008 / CONTRACT SP_ARTIFACT_TTL_DAYS),
//   - all public access blocked (pods reach S3 via IRSA; the apiserver mints
//     presigned URLs server-side).

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
  // The KMS key guarding object encryption (IRSA policies must grant kms:* on it).
  kmsKeyArn: pulumi.Output<string>;
  // Logical names exposed to the app as S3_BUCKET_* env (CONTRACT §6).
  names: {
    models: pulumi.Output<string>;
    weather: pulumi.Output<string>;
    results: pulumi.Output<string>;
  };
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

// Default artifact TTL (days) for the results bucket lifecycle rule.
const RESULTS_TTL_DAYS = 30;

export function createStorage(_c: SynergyConfig): Storage {
  // Customer-managed KMS key for S3 SSE-KMS (the cloud-native upgrade over the
  // self-managed stack's SSE-S3/AES256).
  const kms = new aws.kms.Key("synergy-s3-kms", {
    description: "SSE-KMS for the SynergyPlus S3 buckets (models/weather/results).",
    deletionWindowInDays: 7,
    enableKeyRotation: true,
    tags: { ...TAGS, Name: "synergy-s3-kms" },
  });
  new aws.kms.Alias("synergy-s3-kms-alias", {
    name: "alias/synergyplus-s3",
    targetKeyId: kms.keyId,
  });

  function bucket(logical: string): aws.s3.BucketV2 {
    return new aws.s3.BucketV2(`synergy-${logical}`, {
      // AWS appends a random suffix so bucket names stay globally unique.
      bucketPrefix: `synergyplus-${logical}-`,
      forceDestroy: true, // scaffold convenience: allow teardown of non-empty buckets
      tags: { ...TAGS, Name: `synergy-${logical}`, Role: logical },
    });
  }

  function lockDown(name: string, b: aws.s3.BucketV2) {
    new aws.s3.BucketPublicAccessBlock(`synergy-${name}-pab`, {
      bucket: b.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    // SSE-KMS with our customer-managed key + bucket key (cuts KMS request cost).
    new aws.s3.BucketServerSideEncryptionConfigurationV2(`synergy-${name}-sse`, {
      bucket: b.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: {
            sseAlgorithm: "aws:kms",
            kmsMasterKeyId: kms.arn,
          },
          bucketKeyEnabled: true,
        },
      ],
    });
    new aws.s3.BucketVersioningV2(`synergy-${name}-ver`, {
      bucket: b.id,
      versioningConfiguration: { status: "Enabled" },
    });
  }

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
    kmsKeyArn: kms.arn,
    names: { models: models.bucket, weather: weather.bucket, results: results.bucket },
  };
}
