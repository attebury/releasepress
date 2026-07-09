import { attestPublicReview } from "./attest.js";
import { ReleasepressError } from "./config.js";
import { createExport, stageExport } from "./export.js";
import { runPackageSurface } from "./package-surface.js";
import { createPlan } from "./plan.js";
import { promoteProvider } from "./promote-provider.js";
import { publishPublicReview } from "./public-review.js";
import { createReleaseStatus } from "./release-status.js";
import { scanPath } from "./scan.js";

export function releasePlan({ config, sourceRoot = process.cwd() }) {
  return {
    ok: true,
    type: "releasepress_release_plan",
    plan: createPlan({ config, sourceRoot }),
    status: createReleaseStatus({ config })
  };
}

export function prepareRelease({ config, outDir, sourceRoot = process.cwd() }) {
  const exportResult = createExport({ config, outDir, sourceRoot });
  const scan = scanPath({ config, root: exportResult.out });
  const packageSurface = runPackageSurface({
    config,
    sourceRoot,
    exportRoot: exportResult.out
  });
  const stage = stageExport({ config, exportRoot: exportResult.out });
  const status = createReleaseStatus({
    config,
    exportRoot: exportResult.out,
    sourceRoot
  });

  return {
    ok: scan.ok && packageSurface.ok && stage.ok,
    type: "releasepress_release_prepare",
    export: exportResult,
    scan,
    package: packageSurface,
    stage,
    status
  };
}

export function publishReviewForRelease({ config, exportRoot, sourceRoot = process.cwd(), target = null }) {
  assertReviewTarget(config, target);
  const publicReview = publishPublicReview({ config, exportRoot, sourceRoot });
  const status = createReleaseStatus({ config, exportRoot, sourceRoot });
  return {
    ok: publicReview.ok,
    type: "releasepress_release_publish_review",
    public_review: publicReview,
    status
  };
}

export function attestReviewForRelease({
  config,
  exportRoot,
  target = null,
  reviewedCommit = null,
  approved = false,
  reviewer = "operator",
  reason = null,
  sourceRoot = process.cwd()
}) {
  assertReviewTarget(config, target);
  const attestation = attestPublicReview({
    config,
    exportRoot,
    approved,
    reviewTarget: target,
    reviewedCommit,
    reviewer,
    reason
  });
  const status = createReleaseStatus({ config, exportRoot, sourceRoot });
  return {
    ok: attestation.ok,
    type: "releasepress_release_attest_review",
    attestation,
    status
  };
}

export function deliverRelease({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  target,
  approvedProviderId,
  runner
}) {
  if (!target) {
    throw new ReleasepressError("missing_target", "release deliver requires --target <provider-id>");
  }
  const provider = config.delivery.providers.find((candidate) => candidate.id === target);
  if (!provider) {
    throw new ReleasepressError("delivery_provider_unknown", "Delivery provider is not configured", {
      provider_id: target,
      valid_provider_ids: config.delivery.providers.map((candidate) => candidate.id)
    });
  }
  const delivery = promoteProvider({
    providerId: target,
    config,
    exportRoot,
    sourceRoot,
    approvedProviderId,
    runner
  });
  const status = createReleaseStatus({ config, exportRoot, sourceRoot });
  return {
    ok: delivery.ok,
    type: "releasepress_release_deliver",
    delivery,
    status
  };
}

function assertReviewTarget(config, target) {
  if (target === null || target === undefined) {
    return;
  }
  if (target !== (config.public_review.id ?? null)) {
    throw new ReleasepressError("public_review_target_mismatch", "Selected review target does not match config", {
      expected: config.public_review.id ?? null,
      actual: target
    });
  }
}
