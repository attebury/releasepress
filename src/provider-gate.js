import { assertPromotePrerequisites } from "./checklist.js";
import { ReleasepressError } from "./config.js";
import { verifyRelease } from "./verify.js";
import fs from "node:fs";
import path from "node:path";

const REPORT_DIR = ".releasepress-report";

export function assertProviderLaunchPrerequisites({ provider, config, exportRoot, sourceRoot }) {
  assertPromotePrerequisites({ config, exportRoot, sourceRoot });
  const evidence = assertProviderReviewEvidence({ provider, config, exportRoot });
  const verify = verifyRelease({ config, exportRoot, sourceRoot });
  if (!verify.ok) {
    throw new ReleasepressError("provider_verify_failed", "Provider launch requires a passing verify report", {
      provider,
      blockers: verify.blockers
    });
  }
  return {
    ok: true,
    type: "releasepress_provider_launch_gate",
    provider,
    evidence,
    verify
  };
}

function assertProviderReviewEvidence({ provider, config, exportRoot }) {
  const providerConfig = (config.delivery?.providers ?? []).find((candidate) => candidate.id === provider);
  if (!providerConfig?.enabled) {
    throw new ReleasepressError("delivery_provider_disabled", "Delivery provider is disabled", {
      provider_id: provider
    });
  }

  const stage = readRequiredReport(exportRoot, "stage-results.json", "stage_report_missing");
  const review = readRequiredReport(exportRoot, "public-review-results.json", "public_review_report_missing");
  const attestation = readRequiredReport(exportRoot, "public-review-attestation.json", "public_review_attestation_missing");
  const mismatches = [
    ["provider_review_target", providerConfig.review_target, attestation.review_target_id ?? null],
    ["review_target_id", review.review_target_id ?? null, attestation.review_target_id ?? null],
    ["review_commit", review.review_commit, attestation.review_commit],
    ["stage_commit", stage.stage_commit, attestation.stage_commit],
    ["candidate_fingerprint", stage.candidate_fingerprint ?? null, attestation.candidate_fingerprint ?? null]
  ]
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({
      field,
      expected: expected ?? null,
      actual: actual ?? null
    }));
  if (!Array.isArray(attestation.delivery_targets) || !attestation.delivery_targets.includes(provider)) {
    mismatches.push({
      field: "delivery_targets",
      expected: provider,
      actual: Array.isArray(attestation.delivery_targets) ? attestation.delivery_targets.join(",") : null
    });
  }
  if (mismatches.length > 0) {
    throw new ReleasepressError("provider_review_attestation_mismatch", "Provider launch requires a matching human review attestation", {
      provider_id: provider,
      mismatches
    });
  }

  return {
    review_target_id: attestation.review_target_id ?? null,
    review_commit: attestation.review_commit,
    stage_commit: attestation.stage_commit,
    candidate_fingerprint: attestation.candidate_fingerprint ?? null,
    attestation_report: `${REPORT_DIR}/public-review-attestation.json`
  };
}

function readRequiredReport(exportRoot, report, missingCode) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(exportRoot, REPORT_DIR, report), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError(missingCode, "Required provider launch report is missing", {
        report: `${REPORT_DIR}/${report}`
      });
    }
    throw error;
  }
  if (value?.ok !== true) {
    throw new ReleasepressError("provider_launch_report_invalid", "Provider launch requires passing review reports", {
      report: `${REPORT_DIR}/${report}`
    });
  }
  return value;
}
