// Amazon ECR — the container registry (cloud-native swap for GHCR).
//
// The self-managed variant pulls images from ghcr.io with an imagePullSecret.
// Here we create one private ECR repo per component (apiserver / operator /
// runner / portal / seed). EKS nodes pull via their node role's
// AmazonEC2ContainerRegistryReadOnly policy (cluster.ts) — so there is NO
// imagePullSecret anywhere.
//
// Two ways images get INTO these repos (documented in the README):
//   1. CI pushes directly: GitHub Actions assumes a push role (OIDC) and runs
//      `docker push <acct>.dkr.ecr.<region>.amazonaws.com/synergyplus-<c>:<tag>`.
//   2. ECR pull-through cache from GHCR: an upstream registry rule mirrors
//      ghcr.io/<owner>/* on first pull, so the existing GHCR publish flow is
//      untouched and EKS still pulls in-region/IAM-native.
//
// Each repo scans on push, encrypts with KMS (AES256 default here for
// simplicity — flip to KMS by passing a key), and an untagged-image lifecycle
// rule keeps the repo from accumulating cruft.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { SynergyConfig, IMAGE_COMPONENTS, ImageComponent, ecrImage } from "./config";

export interface Registry {
  // component -> repository URL (without tag).
  repoUrls: Record<ImageComponent, pulumi.Output<string>>;
  // component -> fully-qualified image ref (with the configured tag).
  imageRefs: Record<ImageComponent, pulumi.Output<string>>;
  // All repo ARNs (for an optional CI push policy).
  repoArns: pulumi.Output<string>[];
}

const TAGS = { Project: "synergyplus", ManagedBy: "pulumi", Variant: "cloud-native" };

export function createRegistry(c: SynergyConfig): Registry {
  const repoUrls = {} as Record<ImageComponent, pulumi.Output<string>>;
  const imageRefs = {} as Record<ImageComponent, pulumi.Output<string>>;
  const repoArns: pulumi.Output<string>[] = [];

  for (const component of IMAGE_COMPONENTS) {
    const repo = new aws.ecr.Repository(`synergy-ecr-${component}`, {
      name: `synergyplus-${component}`,
      imageTagMutability: "MUTABLE", // dev convenience; IMMUTABLE for prod release tags
      imageScanningConfiguration: { scanOnPush: true },
      encryptionConfigurations: [{ encryptionType: "AES256" }],
      forceDelete: true, // scaffold convenience: allow teardown of non-empty repos
      tags: { ...TAGS, Component: component },
    });

    // Expire untagged images after 14 days to bound storage.
    new aws.ecr.LifecyclePolicy(`synergy-ecr-${component}-lifecycle`, {
      repository: repo.name,
      policy: JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: "Expire untagged images after 14 days",
            selection: {
              tagStatus: "untagged",
              countType: "sinceImagePushed",
              countUnit: "days",
              countNumber: 14,
            },
            action: { type: "expire" },
          },
        ],
      }),
    });

    repoUrls[component] = repo.repositoryUrl;
    imageRefs[component] = ecrImage(repo.repositoryUrl, c.imageTag);
    repoArns.push(repo.arn);
  }

  return { repoUrls, imageRefs, repoArns };
}
