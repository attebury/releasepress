import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";
import { readPublicReviewReport } from "./public-review.js";

const REPORT_DIR = ".releasepress-report";
const REPORT_NAME = "public-review-attestation.json";

export function attestPublicReview({
  config,
  exportRoot,
  approved = false,
  reviewTarget = null,
  reviewedCommit = null,
  reviewer = "operator",
  reason = null,
  clock = () => new Date()
}) {
  if (!approved) {
    throw new ReleasepressError("public_review_approval_required", "Public review attestation requires explicit approval");
  }
  const root = resolveExportRoot(exportRoot);
  const review = readPublicReviewReport(root);
  validateReviewAgainstConfig({ config, review });
  validateOperatorReviewFields({ config, review, reviewTarget, reviewedCommit });
  const deliveryTargets = (config.delivery?.providers ?? [])
    .filter((provider) => provider.enabled && provider.review_target === (config.public_review.id ?? null))
    .map((provider) => provider.id);

  const output = {
    ok: true,
    type: "releasepress_public_review_attestation",
    review_target_id: config.public_review.id ?? null,
    target: {
      id: config.public_review.id ?? null,
      kind: config.public_review.kind ?? "git_ref",
      repo: review.repo,
      visibility: review.visibility,
      strategy: review.strategy,
      ref: review.ref,
      resolved_ref: review.resolved_ref
    },
    repo: review.repo,
    visibility: review.visibility,
    strategy: review.strategy,
    ref: review.ref,
    resolved_ref: review.resolved_ref,
    review_commit: review.review_commit,
    source_commit: review.source_commit,
    stage_commit: review.stage_commit,
    candidate_fingerprint: review.candidate_fingerprint ?? null,
    candidate_file_count: review.candidate_file_count ?? null,
    delivery_targets: deliveryTargets,
    reviewer: normalizeReviewer(reviewer),
    reason: normalizeReason(reason),
    attested_at: clock().toISOString()
  };
  writeJson(path.join(root, REPORT_DIR, REPORT_NAME), output);
  return output;
}

function validateOperatorReviewFields({ config, review, reviewTarget, reviewedCommit }) {
  if (reviewTarget !== null && reviewTarget !== undefined && reviewTarget !== (config.public_review.id ?? null)) {
    throw new ReleasepressError("public_review_target_mismatch", "Attested review target does not match config", {
      expected: config.public_review.id ?? null,
      actual: reviewTarget
    });
  }
  if (reviewedCommit !== null && reviewedCommit !== undefined && reviewedCommit !== review.review_commit) {
    throw new ReleasepressError("public_review_commit_mismatch", "Attested review commit does not match public review report", {
      expected: review.review_commit,
      actual: reviewedCommit
    });
  }
}

export function readPublicReviewAttestation(root) {
  return readJson(path.join(root, REPORT_DIR, REPORT_NAME), "public_review_attestation_missing");
}

function validateReviewAgainstConfig({ config, review }) {
  if (review?.type !== "releasepress_public_review" || review.ok !== true) {
    throw new ReleasepressError("public_review_report_invalid", "Public review attestation requires a valid public review report");
  }
  const mismatches = [
    ["review_target_id", config.public_review.id ?? null, review.review_target_id ?? null],
    ["repo", config.public_review.repo, review.repo],
    ["visibility", config.public_review.visibility, review.visibility],
    ["strategy", config.public_review.strategy, review.strategy],
    ["ref", config.public_review.ref, review.ref],
    ["resolved_ref", `refs/heads/${config.public_review.ref}`, review.resolved_ref]
  ]
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({
      field,
      expected,
      actual: actual ?? null
    }));
  if (mismatches.length > 0) {
    throw new ReleasepressError("public_review_report_mismatch", "Public review report does not match config", {
      mismatches
    });
  }
}

function normalizeReviewer(reviewer) {
  const value = String(reviewer ?? "operator").trim();
  if (!value || /[\0\r\n<>`|;&$]/.test(value)) {
    throw new ReleasepressError("invalid_reviewer", "Reviewer must be a non-empty safe string");
  }
  return value;
}

function normalizeReason(reason) {
  if (reason === null || reason === undefined) {
    return null;
  }
  const value = String(reason).trim();
  if (value.length === 0) {
    return null;
  }
  if (/[\0<>`|;&$]/.test(value)) {
    throw new ReleasepressError("invalid_attestation_reason", "Review reason contains unsafe characters");
  }
  if (/\b(?:token|secret|password|passwd|api[_-]?key|authorization)\b\s*[:=]/i.test(value)) {
    throw new ReleasepressError("invalid_attestation_reason", "Review reason must not contain credential material");
  }
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value) || /\bnpm_[A-Za-z0-9]{20,}\b/.test(value)) {
    throw new ReleasepressError("invalid_attestation_reason", "Review reason must not contain credential material");
  }
  return value;
}

function resolveExportRoot(exportRoot) {
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
  const root = path.resolve(exportRoot);
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", "Public review attestation export path does not exist", { path: exportRoot });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Public review attestation export path must not be a symlink", {
      path: exportRoot
    });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", "Public review attestation export path must be a directory", {
      path: exportRoot
    });
  }
  return root;
}

function readJson(file, missingCode) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError(missingCode, "Required report is missing", { report: path.basename(file) });
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError("report_json_invalid", "Required report is not valid JSON", {
      report: path.basename(file),
      reason: error.message
    });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
