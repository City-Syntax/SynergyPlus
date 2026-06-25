// AWS Secrets Manager — the cloud-native swap for hand-written k8s Secrets.
//
// In the self-managed variant the DATABASE_URL and the Postgres password live in
// k8s Secrets authored by Pulumi. Here the sensitive material lives in AWS
// Secrets Manager and is SYNCED into the cluster by the External Secrets
// Operator (app.ts wires the ExternalSecret -> the `synergyplus-env` k8s Secret
// the manifests expect). Pulumi never writes a plaintext DB password into a k8s
// Secret object.
//
// Two secrets:
//   1. synergyplus/app-env  — a JSON blob of the non-DB app env (S3 bucket
//      names, region, engine allow-list, SES from-address). ESO projects each
//      JSON key into the k8s Secret.
//   2. synergyplus/db       — DATABASE_URL pointing at the AURORA WRITER
//      endpoint, plus the discrete user/password/host (for tools that want
//      them split). Built from database.ts outputs.
//   3. synergyplus/better-auth — a generated Better Auth signing secret.
//
// All three are encrypted with a dedicated KMS key; the apiserver (read) and
// External Secrets Operator (read) IRSA roles are scoped to this ARN prefix.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { SynergyConfig } from "./config";
import { Database } from "./database";
import { Storage } from "./storage";

export interface Secrets {
  // ARN prefix used to scope IRSA policies (iam.ts) — "arn:aws:secretsmanager:...:secret:synergyplus/".
  arnPrefix: pulumi.Output<string>;
  appEnvSecretName: pulumi.Output<string>;
  dbSecretName: pulumi.Output<string>;
  betterAuthSecretName: pulumi.Output<string>;
  kmsKeyArn: pulumi.Output<string>;
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };
const PREFIX = "synergyplus";

export function createSecrets(
  c: SynergyConfig,
  db: Database,
  storage: Storage,
  accountId: pulumi.Output<string>,
): Secrets {
  // KMS key for Secrets Manager encryption.
  const kms = new aws.kms.Key("synergy-secrets-kms", {
    description: "Encryption for SynergyPlus Secrets Manager secrets.",
    deletionWindowInDays: 7,
    enableKeyRotation: true,
    tags: { ...TAGS, Name: "synergy-secrets-kms" },
  });
  new aws.kms.Alias("synergy-secrets-kms-alias", {
    name: "alias/synergyplus-secrets",
    targetKeyId: kms.keyId,
  });

  // 1) Non-DB app env (CONTRACT §6 minus the DB URL + S3 static keys, which
  // don't exist on AWS — pods use IRSA). ESO maps each JSON key into env.
  const appEnv = new aws.secretsmanager.Secret("synergy-app-env", {
    name: `${PREFIX}/app-env`,
    description: "SynergyPlus non-DB app env (S3 bucket names, region, engine allow-list, SES).",
    kmsKeyId: kms.keyId,
    recoveryWindowInDays: 0, // scaffold convenience: immediate delete on destroy
    tags: TAGS,
  });
  new aws.secretsmanager.SecretVersion("synergy-app-env-v", {
    secretId: appEnv.id,
    secretString: pulumi
      .all([storage.names.models, storage.names.weather, storage.names.results])
      .apply(([models, weather, results]) =>
        JSON.stringify({
          S3_REGION: c.region,
          S3_BUCKET_MODELS: models,
          S3_BUCKET_WEATHER: weather,
          S3_BUCKET_RESULTS: results,
          SP_LEASE_SECONDS: "90",
          SP_HEARTBEAT_SECONDS: "30",
          SP_ALLOWED_ENGINE_VERSIONS: c.allowedEngineVersions,
          SES_FROM_ADDRESS: c.sesFromAddress,
          AWS_REGION: c.region,
        }),
      ),
  });

  // 2) DB secret: DATABASE_URL -> Aurora WRITER endpoint, plus split fields.
  const dbSecret = new aws.secretsmanager.Secret("synergy-db", {
    name: `${PREFIX}/db`,
    description: "SynergyPlus Aurora connection (DATABASE_URL + split fields).",
    kmsKeyId: kms.keyId,
    recoveryWindowInDays: 0,
    tags: TAGS,
  });
  const databaseUrl = pulumi
    .all([db.user, db.password, db.writerEndpoint, db.port, db.dbName])
    .apply(([user, pass, host, port, name]) => {
      const enc = encodeURIComponent(pass);
      // Aurora requires TLS; sslmode=require keeps the contract's DATABASE_URL
      // shape while enforcing in-transit encryption (vs the local sslmode=disable).
      return `postgres://${user}:${enc}@${host}:${port}/${name}?sslmode=require`;
    });
  new aws.secretsmanager.SecretVersion("synergy-db-v", {
    secretId: dbSecret.id,
    secretString: pulumi
      .all([databaseUrl, db.user, db.password, db.writerEndpoint, db.readerEndpoint, db.port, db.dbName])
      .apply(([url, user, pass, writer, reader, port, name]) =>
        JSON.stringify({
          DATABASE_URL: url,
          PGUSER: user,
          PGPASSWORD: pass,
          PGHOST: writer,
          PGHOST_READER: reader,
          PGPORT: String(port),
          PGDATABASE: name,
        }),
      ),
  });

  // 3) Better Auth signing secret (generated; the portal reads BETTER_AUTH_SECRET).
  const betterAuthSecretValue = new random.RandomPassword("synergy-better-auth-secret", {
    length: 48,
    special: false,
  });
  const betterAuth = new aws.secretsmanager.Secret("synergy-better-auth", {
    name: `${PREFIX}/better-auth`,
    description: "Better Auth signing secret (BETTER_AUTH_SECRET).",
    kmsKeyId: kms.keyId,
    recoveryWindowInDays: 0,
    tags: TAGS,
  });
  new aws.secretsmanager.SecretVersion("synergy-better-auth-v", {
    secretId: betterAuth.id,
    secretString: betterAuthSecretValue.result.apply((s) =>
      JSON.stringify({ BETTER_AUTH_SECRET: s }),
    ),
  });

  const arnPrefix = pulumi.interpolate`arn:aws:secretsmanager:${c.region}:${accountId}:secret:${PREFIX}/`;

  return {
    arnPrefix,
    appEnvSecretName: appEnv.name,
    dbSecretName: dbSecret.name,
    betterAuthSecretName: betterAuth.name,
    kmsKeyArn: kms.arn,
  };
}
