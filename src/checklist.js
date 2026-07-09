import fs from "node:fs";
import path from "node:path";
import { publicPromotionRequired, ReleasepressError } from "./config.js";
import { assertPreflightSatisfied } from "./preflight.js";

const REPORT_DIR = ".releasepress-report";
const CHECKLIST_REPORT = "checklist.json";
const STEP_ORDER = [
  "plan",
  "export",
  "scan",
  "package",
  "preflight",
  "stage",
  "public_review",
  "public_review_attestation",
  "promote_local",
  "verify"
];
const BASE_PROMOTE_GATE_STEPS = new Set(["export", "scan", "package", "preflight", "stage"]);

import { getReleaseIdentity } from "./release-identity.js";
import { runProviderPreflight } from "./provider-preflight.js";

export function createChecklist({ config, exportRoot = null, sourceRoot = process.cwd() }) {
  assertConfig(config);

  if (!exportRoot) {
    return {
      ok: true,
      type: "releasepress_checklist",
      mode: "plan",
      steps: plannedSteps(config),
      delivery: deliverySummary(config),
      promote: {
        ready: false,
        reason: "report_path_required"
      }
    };
  }

  const roots = resolveRoots({ exportRoot, sourceRoot });

  let releaseIdentity = null;
  let identityError = null;
  try {
    releaseIdentity = getReleaseIdentity({ config, sourceRoot: roots.sourceRoot });
  } catch (err) {
    identityError = err;
  }

  let preflightResults = null;
  if (releaseIdentity) {
    preflightResults = runProviderPreflight({
      config,
      releaseIdentity,
      exportRoot: roots.exportRoot,
      sourceRoot: roots.sourceRoot
    });
  }

  const steps = inspectSteps({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot }, preflightResults);
  const blockers = promoteBlockers(steps);

  if (identityError) {
    blockers.push({
      step: "release_identity",
      status: "failed",
      reason: identityError.code || "release_identity_invalid",
      message: identityError.message
    });
  }

  if (preflightResults && !preflightResults.ok) {
    for (const r of preflightResults.results) {
      if (!r.ok) {
        blockers.push({
          step: `promote_provider:${r.provider_id}`,
          status: "failed",
          reason: r.blocker,
          message: r.details.reason
        });
      }
    }
  }

  const output = {
    ok: blockers.length === 0,
    type: "releasepress_checklist",
    mode: "report",
    report_dir: REPORT_DIR,
    steps,
    delivery: deliverySummary(config),
    release_identity: releaseIdentity,
    provider_preflight: preflightResults,
    promote: {
      ready: blockers.length === 0,
      blockers
    }
  };

  writeChecklistReport(roots.exportRoot, output);
  return output;
}

export function assertPromotePrerequisites({ config, exportRoot, sourceRoot = process.cwd() }) {
  const checklist = createChecklist({ config, exportRoot, sourceRoot });
  if (!checklist.promote.ready) {
    throw new ReleasepressError("promote_prerequisites_failed", "Promote prerequisites are not satisfied", {
      blockers: checklist.promote.blockers
    });
  }

  return {
    ok: true,
    type: "releasepress_promote_gate",
    checklist_report: `${REPORT_DIR}/${CHECKLIST_REPORT}`
  };
}

export function assertPublicReviewPrerequisites({ config, exportRoot, sourceRoot = process.cwd() }) {
  const roots = resolveRoots({ exportRoot, sourceRoot });
  const steps = inspectSteps({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const blockers = basePromoteBlockers(steps);
  if (blockers.length > 0) {
    throw new ReleasepressError("public_review_prerequisites_failed", "Public review prerequisites are not satisfied", {
      blockers
    });
  }
  return {
    ok: true,
    type: "releasepress_public_review_gate",
    required_steps: [...BASE_PROMOTE_GATE_STEPS]
  };
}

function plannedSteps(config) {
  return checklistStepIds(config).map((id) => {
    const step = {
      id,
      status: "planned",
      ok: null,
      promote_gate: isPromoteGate(id, config)
    };
    if (id === "preflight" && !config.preflight.enabled) {
      return {
        ...step,
        status: "skipped",
        ok: true,
        promote_gate: false,
        skip_reason: "preflight_disabled"
      };
    }
    if (id === "stage" && !config.stage_repo) {
      return {
        ...step,
        status: "blocked",
        ok: false,
        reason: "stage_repo_required"
      };
    }
    if (id === "stage") {
      const plannedRef = config.stage.strategy === "unique-ref"
        ? `${config.stage.ref_prefix}/<stage_commit>`
        : config.stage.ref;
      return {
        ...step,
        target_id: config.stage.id,
        strategy: config.stage.strategy,
        ref: plannedRef,
        resolved_ref: `refs/heads/${plannedRef}`,
        ref_prefix: config.stage.ref_prefix
      };
    }
    if (id === "public_review") {
      return plannedPublicReviewStep(config);
    }
    if (id === "public_review_attestation") {
      return plannedPublicReviewAttestationStep(config);
    }
    if (id === "promote_local") {
      return plannedLocalStep(config);
    }
    if (isProviderStepId(id)) {
      return plannedProviderStep(stepProvider(config, id));
    }
    return step;
  });
}

function inspectSteps({ config, exportRoot, sourceRoot }, preflightResults) {
  return checklistStepIds(config).map((id) => {
    if (id === "plan") {
      return passedStep(id, { promote_gate: false });
    }
    if (id === "export") {
      return inspectExportReport(exportRoot);
    }
    if (id === "scan") {
      return inspectTypedReport({
        id,
        root: exportRoot,
        report: "scan-results.json",
        expectedType: "releasepress_scan",
        promoteGate: true
      });
    }
    if (id === "package") {
      return inspectPackageReport({ sourceRoot, exportRoot });
    }
    if (id === "preflight") {
      return inspectPreflightReport({ config, exportRoot });
    }
    if (id === "stage") {
      return inspectStageReport({ config, exportRoot });
    }
    if (id === "public_review") {
      return inspectPublicReviewReport({ config, exportRoot });
    }
    if (id === "public_review_attestation") {
      return inspectPublicReviewAttestationReport({ config, exportRoot });
    }
    if (id === "promote_local") {
      return inspectedLocalStep(config);
    }
    if (isProviderStepId(id)) {
      return inspectedProviderStep(stepProvider(config, id), preflightResults);
    }
    if (id === "verify") {
      return inspectVerifyReport(exportRoot);
    }
    throw new ReleasepressError("internal_error", "Unknown checklist step", { id });
  });
}

function checklistStepIds(config) {
  const ids = [...STEP_ORDER];
  const verifyIndex = ids.indexOf("verify");
  const providerIds = config.delivery.providers.map((provider) => providerStepId(provider));
  ids.splice(verifyIndex, 0, ...providerIds);
  return ids;
}

function providerStepId(provider) {
  return `promote_provider:${provider.id}`;
}

function isProviderStepId(id) {
  return id.startsWith("promote_provider:");
}

function stepProvider(config, id) {
  const providerId = id.slice("promote_provider:".length);
  const provider = config.delivery.providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new ReleasepressError("internal_error", "Unknown delivery provider checklist step", {
      step: id,
      provider_id: providerId
    });
  }
  return provider;
}

function deliverySummary(config) {
  return {
    artifacts: config.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      root: artifact.root,
      path: artifact.path,
      must_exclude: artifact.must_exclude
    })),
    review_targets: config.review_targets.map((target) => ({
      id: target.id,
      kind: target.kind,
      repo: target.repo,
      visibility: target.visibility,
      strategy: target.strategy,
      ref: target.ref,
      requires_human_attestation: target.requires_human_attestation
    })),
    providers: config.delivery.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      provider: provider.provider,
      enabled: provider.enabled,
      review_target: provider.review_target,
      artifact: provider.artifact,
      repo: provider.repo ?? null,
      ref: provider.ref ?? null,
      channel: provider.channel ?? null,
      launch_root: provider.launch_root,
      launch_path: provider.launch_path
    }))
  };
}

function plannedPublicReviewStep(config) {
  if (!publicPromotionRequired(config)) {
    return {
      id: "public_review",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "public_promote_surfaces_disabled"
    };
  }
  if (!config.public_review.repo) {
    return failedPlannedStep("public_review", "public_review_repo_required");
  }
  return {
    id: "public_review",
    status: "planned",
    ok: null,
    promote_gate: true,
    repo: config.public_review.repo,
    review_target_id: config.public_review.id ?? null,
    visibility: config.public_review.visibility,
    strategy: config.public_review.strategy,
    ref: config.public_review.ref,
    resolved_ref: `refs/heads/${config.public_review.ref}`
  };
}

function plannedPublicReviewAttestationStep(config) {
  if (!publicPromotionRequired(config)) {
    return {
      id: "public_review_attestation",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "public_promote_surfaces_disabled"
    };
  }
  if (!config.public_review.requires_human_attestation) {
    return {
      id: "public_review_attestation",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "human_attestation_not_required"
    };
  }
  return {
    id: "public_review_attestation",
    status: "planned",
    ok: null,
    promote_gate: true,
    approval_required: true,
    repo: config.public_review.repo,
    review_target_id: config.public_review.id ?? null,
    ref: config.public_review.ref
  };
}

function plannedLocalStep(config) {
  if (!config.surfaces.local.enabled) {
    return {
      id: "promote_local",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "local_surface_disabled"
    };
  }
  return {
    id: "promote_local",
    status: "planned",
    ok: null,
    promote_gate: false,
    approval_required: true,
    strategy: config.surfaces.local.strategy,
    source: config.surfaces.local.source,
    command_name: config.surfaces.local.command_name
  };
}

function inspectedLocalStep(config) {
  if (!config.surfaces.local.enabled) {
    return {
      id: "promote_local",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "local_surface_disabled"
    };
  }
  return {
    id: "promote_local",
    status: "ready",
    ok: null,
    promote_gate: false,
    approval_required: true,
    strategy: config.surfaces.local.strategy,
    source: config.surfaces.local.source,
    command_name: config.surfaces.local.command_name
  };
}

function plannedProviderStep(provider) {
  if (!provider.enabled) {
    return {
      ...providerStepBase(provider),
      status: "skipped",
      ok: true,
      skip_reason: "delivery_provider_disabled"
    };
  }
  return {
    ...providerStepBase(provider),
    status: "planned",
    ok: null
  };
}

function inspectedProviderStep(provider, preflightResults) {
  if (!provider.enabled) {
    return {
      ...providerStepBase(provider),
      status: "skipped",
      ok: true,
      skip_reason: "delivery_provider_disabled"
    };
  }
  const result = preflightResults?.results.find((r) => r.provider_id === provider.id);
  if (result) {
    return {
      ...providerStepBase(provider),
      status: result.ok ? "ready" : "failed",
      ok: result.ok,
      reason: result.blocker,
      details: result.details
    };
  }
  return {
    ...providerStepBase(provider),
    status: "ready",
    ok: null
  };
}

function providerStepBase(provider) {
  return {
    id: providerStepId(provider),
    provider_id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    promote_gate: false,
    approval_required: Boolean(provider.enabled),
    review_target: provider.review_target,
    artifact: provider.artifact ?? null,
    repo: provider.repo ?? null,
    ref: provider.ref ?? null,
    channel: provider.channel ?? null,
    launch_root: provider.launch_root,
    launch_path: provider.launch_path,
    launcher_argv: provider.launcher.command_argv,
    verify: provider.verify
  };
}

function inspectExportReport(exportRoot) {
  const sourceCommit = readTextReport(exportRoot, "source-commit.txt");
  const publicFiles = readJsonReport(exportRoot, "public-files.json");
  const excludedFiles = readJsonReport(exportRoot, "excluded-files.json");
  const sourceState = readJsonReport(exportRoot, "source-state.json");
  const missing = [sourceCommit, publicFiles, excludedFiles, sourceState].find((report) => !report.ok);
  if (missing) {
    return reportFailureStep("export", missing, { promote_gate: true });
  }
  if (
    sourceCommit.value.trim().length === 0 ||
    !Array.isArray(publicFiles.value) ||
    !Array.isArray(excludedFiles.value) ||
    !sourceState.value ||
    typeof sourceState.value !== "object"
  ) {
    return invalidStep("export", "export_report_invalid", { promote_gate: true });
  }

  return passedStep("export", {
    promote_gate: true,
    public_file_count: publicFiles.value.length,
    excluded_file_count: excludedFiles.value.length,
    source_dirty: sourceState.value.dirty ?? null
  });
}

function inspectPackageReport({ sourceRoot, exportRoot }) {
  const sourceReport = readJsonReport(sourceRoot, "package-files.json");
  const report = sourceReport.ok ? sourceReport : readJsonReport(exportRoot, "package-files.json");
  if (!report.ok) {
    return reportFailureStep("package", report, { promote_gate: true });
  }
  if (report.value?.type !== "releasepress_package") {
    return invalidStep("package", "package_report_type_mismatch", { promote_gate: true });
  }
  if (!report.value.ok) {
    return failedStep("package", "package_report_failed", {
      promote_gate: true,
      violation_count: Array.isArray(report.value.violations) ? report.value.violations.length : null
    });
  }
  return passedStep("package", {
    promote_gate: true,
    package_file_count: Array.isArray(report.value.package_files) ? report.value.package_files.length : null,
    report_root: sourceReport.ok ? "source" : "export"
  });
}

function inspectPreflightReport({ config, exportRoot }) {
  if (!config.preflight.enabled) {
    return {
      id: "preflight",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "preflight_disabled"
    };
  }

  try {
    assertPreflightSatisfied({ config, exportRoot });
  } catch (error) {
    if (error instanceof ReleasepressError) {
      return failedStep("preflight", error.code, { promote_gate: true });
    }
    throw error;
  }

  const report = readJsonReport(exportRoot, "preflight-results.json");
  if (!report.ok) {
    return reportFailureStep("preflight", report, { promote_gate: true });
  }
  return passedStep("preflight", {
    promote_gate: true,
    step_count: Array.isArray(report.value.steps) ? report.value.steps.length : null
  });
}

function inspectStageReport({ config, exportRoot }) {
  if (!config.stage_repo) {
    return failedStep("stage", "stage_repo_required", { promote_gate: true });
  }
  const report = readJsonReport(exportRoot, "stage-results.json");
  if (!report.ok) {
    return reportFailureStep("stage", report, { promote_gate: true });
  }
  if (report.value?.type !== "releasepress_stage") {
    return invalidStep("stage", "stage_report_type_mismatch", { promote_gate: true });
  }
  if (!report.value.ok) {
    return failedStep("stage", "stage_report_failed", { promote_gate: true });
  }
  const invalidReason = invalidStageReportReason(report.value);
  if (invalidReason) {
    return invalidStep("stage", invalidReason, { promote_gate: true });
  }
  const mismatches = stageReportMismatches({ config, report: report.value });
  if (mismatches.length > 0) {
    return failedStep("stage", "stage_report_mismatch", {
      promote_gate: true,
      mismatches
    });
  }
  return passedStep("stage", {
    promote_gate: true,
    committed: report.value.committed ?? null,
    target_id: report.value.target_id ?? null,
    strategy: report.value.strategy,
    ref: report.value.ref,
    resolved_ref: report.value.resolved_ref,
    stage_commit: report.value.stage_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    replaced: report.value.replaced
  });
}

function inspectPublicReviewReport({ config, exportRoot }) {
  if (!publicPromotionRequired(config)) {
    return {
      id: "public_review",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "public_promote_surfaces_disabled"
    };
  }
  const report = readJsonReport(exportRoot, "public-review-results.json");
  if (!report.ok) {
    return reportFailureStep("public_review", report, { promote_gate: true });
  }
  if (report.value?.type !== "releasepress_public_review") {
    return invalidStep("public_review", "public_review_report_type_mismatch", { promote_gate: true });
  }
  if (!report.value.ok) {
    return failedStep("public_review", "public_review_report_failed", { promote_gate: true });
  }
  const invalidReason = invalidPublicReviewReportReason(report.value);
  if (invalidReason) {
    return invalidStep("public_review", invalidReason, { promote_gate: true });
  }
  const stageReport = readJsonReport(exportRoot, "stage-results.json");
  const mismatches = publicReviewReportMismatches({ config, report: report.value, stageReport });
  if (mismatches.length > 0) {
    return failedStep("public_review", "public_review_report_mismatch", {
      promote_gate: true,
      mismatches
    });
  }
  return passedStep("public_review", {
    promote_gate: true,
    repo: report.value.repo,
    review_target_id: config.public_review.id ?? null,
    visibility: report.value.visibility,
    strategy: report.value.strategy,
    ref: report.value.ref,
    resolved_ref: report.value.resolved_ref,
    review_commit: report.value.review_commit,
    stage_commit: report.value.stage_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    replaced: report.value.replaced
  });
}

function inspectPublicReviewAttestationReport({ config, exportRoot }) {
  if (!publicPromotionRequired(config)) {
    return {
      id: "public_review_attestation",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "public_promote_surfaces_disabled"
    };
  }
  if (!config.public_review.requires_human_attestation) {
    return {
      id: "public_review_attestation",
      status: "skipped",
      ok: true,
      promote_gate: false,
      skip_reason: "human_attestation_not_required"
    };
  }
  const review = readJsonReport(exportRoot, "public-review-results.json");
  const report = readJsonReport(exportRoot, "public-review-attestation.json");
  if (!report.ok) {
    return reportFailureStep("public_review_attestation", report, { promote_gate: true });
  }
  if (report.value?.type !== "releasepress_public_review_attestation") {
    return invalidStep("public_review_attestation", "public_review_attestation_type_mismatch", { promote_gate: true });
  }
  if (!report.value.ok) {
    return failedStep("public_review_attestation", "public_review_attestation_failed", { promote_gate: true });
  }
  if (!review.ok) {
    return failedStep("public_review_attestation", "public_review_report_missing", { promote_gate: true });
  }
  const mismatches = publicReviewAttestationMismatches({ config, review: review.value, report: report.value });
  if (mismatches.length > 0) {
    return failedStep("public_review_attestation", "public_review_attestation_mismatch", {
      promote_gate: true,
      mismatches
    });
  }
  return passedStep("public_review_attestation", {
    promote_gate: true,
    repo: report.value.repo,
    review_target_id: config.public_review.id ?? null,
    ref: report.value.ref,
    review_commit: report.value.review_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    delivery_targets: report.value.delivery_targets ?? [],
    reviewer: report.value.reviewer ?? null,
    attested_at: report.value.attested_at
  });
}

function invalidPublicReviewReportReason(report) {
  if (typeof report.repo !== "string" || report.repo.length === 0) {
    return "public_review_repo_missing";
  }
  if (typeof report.strategy !== "string" || report.strategy.length === 0) {
    return "public_review_strategy_missing";
  }
  if (typeof report.ref !== "string" || report.ref.length === 0) {
    return "public_review_ref_missing";
  }
  if (typeof report.resolved_ref !== "string" || !report.resolved_ref.startsWith("refs/heads/")) {
    return "public_review_resolved_ref_invalid";
  }
  if (typeof report.review_commit !== "string" || !/^[0-9a-f]{40}$/i.test(report.review_commit)) {
    return "public_review_commit_invalid";
  }
  return null;
}

function publicReviewReportMismatches({ config, report, stageReport }) {
  const comparisons = [
    ["review_target_id", config.public_review.id ?? null, report.review_target_id ?? null],
    ["repo", config.public_review.repo, report.repo],
    ["visibility", config.public_review.visibility, report.visibility],
    ["strategy", config.public_review.strategy, report.strategy],
    ["ref", config.public_review.ref, report.ref],
    ["resolved_ref", `refs/heads/${config.public_review.ref}`, report.resolved_ref]
  ];
  if (stageReport.ok) {
    comparisons.push(["stage_commit", stageReport.value.stage_commit, report.stage_commit]);
    comparisons.push(["review_commit", stageReport.value.stage_commit, report.review_commit]);
    comparisons.push([
      "candidate_fingerprint",
      stageReport.value.candidate_fingerprint ?? null,
      report.candidate_fingerprint ?? null
    ]);
  }
  return comparisons
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({
      field,
      expected,
      actual: actual ?? null
    }));
}

function publicReviewAttestationMismatches({ config, review, report }) {
  const comparisons = [
    ["review_target_id", config.public_review.id ?? null, report.review_target_id ?? null],
    ["repo", config.public_review.repo, report.repo],
    ["ref", config.public_review.ref, report.ref],
    ["resolved_ref", `refs/heads/${config.public_review.ref}`, report.resolved_ref],
    ["review_commit", review.review_commit, report.review_commit],
    ["source_commit", review.source_commit, report.source_commit],
    ["stage_commit", review.stage_commit, report.stage_commit],
    ["candidate_fingerprint", review.candidate_fingerprint ?? null, report.candidate_fingerprint ?? null]
  ];
  const expectedTargets = (config.delivery?.providers ?? [])
    .filter((provider) => provider.enabled && provider.review_target === (config.public_review.id ?? null))
    .map((provider) => provider.id)
    .sort();
  const actualTargets = Array.isArray(report.delivery_targets) ? [...report.delivery_targets].sort() : [];
  comparisons.push(["delivery_targets", expectedTargets.join(","), actualTargets.join(",")]);
  return comparisons
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({
      field,
      expected: expected ?? null,
      actual: actual ?? null
    }));
}

function invalidStageReportReason(report) {
  if (typeof report.stage_repo !== "string" || report.stage_repo.length === 0) {
    return "stage_report_stage_repo_missing";
  }
  if (typeof report.strategy !== "string" || report.strategy.length === 0) {
    return "stage_report_strategy_missing";
  }
  if (typeof report.ref !== "string" || report.ref.length === 0) {
    return "stage_report_ref_missing";
  }
  if (typeof report.resolved_ref !== "string" || !report.resolved_ref.startsWith("refs/heads/")) {
    return "stage_report_resolved_ref_invalid";
  }
  if (typeof report.stage_commit !== "string" || !/^[0-9a-f]{40}$/i.test(report.stage_commit)) {
    return "stage_report_commit_invalid";
  }
  if (typeof report.target_id !== "string" || report.target_id.length === 0) {
    return "stage_report_target_id_missing";
  }
  if (typeof report.candidate_fingerprint !== "string" || !report.candidate_fingerprint.startsWith("sha256:")) {
    return "stage_report_candidate_fingerprint_invalid";
  }
  return null;
}

function stageReportMismatches({ config, report }) {
  const expectedRef = report.strategy === "unique-ref"
    ? `${config.stage.ref_prefix}/${report.stage_commit}`
    : config.stage.ref;
  const expectedResolvedRef = `refs/heads/${expectedRef}`;
  const comparisons = [
    ["target_id", config.stage.id, report.target_id ?? null],
    ["stage_repo", config.stage_repo, report.stage_repo],
    ["strategy", config.stage.strategy, report.strategy],
    ["ref", expectedRef, report.ref],
    ["resolved_ref", expectedResolvedRef, report.resolved_ref]
  ];
  return comparisons
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({
      field,
      expected,
      actual: actual ?? null
    }));
}

function inspectVerifyReport(exportRoot) {
  const report = readJsonReport(exportRoot, "verify-results.json");
  if (!report.ok && report.status === "missing") {
    return {
      id: "verify",
      status: "pending",
      ok: null,
      promote_gate: false,
      reason: "verify_not_run"
    };
  }
  if (!report.ok) {
    return reportFailureStep("verify", report, { promote_gate: false });
  }
  if (report.value?.type !== "releasepress_verify") {
    return invalidStep("verify", "verify_report_type_mismatch", { promote_gate: false });
  }
  if (!report.value.ok) {
    return failedStep("verify", "verify_report_failed", {
      promote_gate: false,
      blocker_count: Array.isArray(report.value.blockers) ? report.value.blockers.length : null
    });
  }
  return passedStep("verify", { promote_gate: false });
}

function inspectTypedReport({ id, root, report, expectedType, promoteGate }) {
  const parsed = readJsonReport(root, report);
  if (!parsed.ok) {
    return reportFailureStep(id, parsed, { promote_gate: promoteGate });
  }
  if (parsed.value?.type !== expectedType) {
    return invalidStep(id, `${id}_report_type_mismatch`, { promote_gate: promoteGate });
  }
  if (!parsed.value.ok) {
    return failedStep(id, `${id}_report_failed`, {
      promote_gate: promoteGate,
      finding_count: Array.isArray(parsed.value.findings) ? parsed.value.findings.length : null
    });
  }
  return passedStep(id, { promote_gate: promoteGate });
}

function promoteBlockers(steps) {
  return steps
    .filter((step) => step.promote_gate && step.ok !== true)
    .map((step) => ({
      step: step.id,
      status: step.status,
      reason: step.reason ?? step.error_code ?? "not_satisfied"
    }));
}

function basePromoteBlockers(steps) {
  return steps
    .filter((step) => BASE_PROMOTE_GATE_STEPS.has(step.id) && step.promote_gate && step.ok !== true)
    .map((step) => ({
      step: step.id,
      status: step.status,
      reason: step.reason ?? step.error_code ?? "not_satisfied"
    }));
}

function isPromoteGate(id, config) {
  if (BASE_PROMOTE_GATE_STEPS.has(id)) {
    return true;
  }
  return publicPromotionRequired(config) && (
    id === "public_review" ||
    (id === "public_review_attestation" && config.public_review.requires_human_attestation)
  );
}

function passedStep(id, fields = {}) {
  return {
    id,
    status: "passed",
    ok: true,
    ...fields
  };
}

function failedStep(id, reason, fields = {}) {
  return {
    id,
    status: "failed",
    ok: false,
    reason,
    ...fields
  };
}

function invalidStep(id, reason, fields = {}) {
  return {
    id,
    status: "invalid",
    ok: false,
    reason,
    ...fields
  };
}

function failedPlannedStep(id, reason) {
  return {
    id,
    status: "blocked",
    ok: false,
    promote_gate: true,
    reason
  };
}

function reportFailureStep(id, report, fields = {}) {
  return {
    id,
    status: report.status,
    ok: false,
    reason: report.reason,
    report: `${REPORT_DIR}/${report.report}`,
    ...fields
  };
}

function readTextReport(root, report) {
  try {
    return {
      ok: true,
      value: fs.readFileSync(path.join(root, REPORT_DIR, report), "utf8")
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, status: "missing", reason: "report_missing", report };
    }
    throw error;
  }
}

function readJsonReport(root, report) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, REPORT_DIR, report), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, status: "missing", reason: "report_missing", report };
    }
    throw error;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      reason: "report_json_invalid",
      report
    };
  }
}

function resolveRoots({ exportRoot, sourceRoot }) {
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
  const resolvedExportRoot = path.resolve(exportRoot);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  assertRealDirectory(resolvedExportRoot, "export", exportRoot);
  assertRealDirectory(resolvedSourceRoot, "source", sourceRoot);
  return {
    exportRoot: resolvedExportRoot,
    sourceRoot: resolvedSourceRoot
  };
}

function assertRealDirectory(resolved, label, original) {
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", `Checklist ${label} path does not exist`, { path: original });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `Checklist ${label} path must not be a symlink`, {
      path: original
    });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `Checklist ${label} path must be a directory`, { path: original });
  }
}

function writeChecklistReport(exportRoot, output) {
  const reportDir = path.join(exportRoot, REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, CHECKLIST_REPORT), `${JSON.stringify(output, null, 2)}\n`);
}

function assertConfig(config) {
  if (!config?.package || !config?.preflight || !config?.stage) {
    throw new ReleasepressError("invalid_config", "Validated config is required for checklist");
  }
}
