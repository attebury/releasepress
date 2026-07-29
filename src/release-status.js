import fs from "node:fs";
import path from "node:path";
import { buildCandidateSummary, readSourceCommit } from "./candidate.js";
import { createChecklist } from "./checklist.js";
import { publicPromotionRequired, ReleasepressError } from "./config.js";
import { readJsonReport } from "./report-io.js";
import { redactTargetValue } from "./target.js";

const REPORT_DIR = ".releasepress-report";
const STATUS_REPORT = "release-status.json";

function providerReportName(providerId) {
  return `provider-${providerId}.json`;
}

export function createReleaseStatus({
  config,
  exportRoot = null,
  sourceRoot = process.cwd(),
  writeReport = true
}) {
  if (!exportRoot) {
    return plannedReleaseStatus({ config });
  }

  const roots = resolveRoots({ exportRoot, sourceRoot });
  const candidate = candidateStatus(roots.exportRoot);
  const checklist = createChecklist({
    config,
    exportRoot: roots.exportRoot,
    sourceRoot: roots.sourceRoot
  });
  const reports = {
    stage: readJsonReport(roots.exportRoot, "stage-results.json"),
    publicReview: readJsonReport(roots.exportRoot, "public-review-results.json"),
    attestation: readJsonReport(roots.exportRoot, "public-review-attestation.json"),
    verify: readJsonReport(roots.exportRoot, "verify-results.json"),
    localPromote: readJsonReport(roots.exportRoot, "local-promote.json")
  };
  for (const provider of config.delivery.providers) {
    reports[`provider:${provider.id}`] = readJsonReport(roots.exportRoot, providerReportName(provider.id));
  }

  const output = {
    ok: true,
    type: "releasepress_release_status",
    schema_version: 1,
    report_dir: REPORT_DIR,
    release_identity: checklist.release_identity ?? null,
    provider_preflight: checklist.provider_preflight ?? null,
    candidate,
    stage: stageStatus({ config, report: reports.stage, checklist }),
    review: reviewStatus({ config, report: reports.publicReview, checklist }),
    attestation: attestationStatus({ config, report: reports.attestation, checklist }),
    local_promote: localPromoteStatus({ config, report: reports.localPromote }),
    delivery: deliveryStatus({ config, reports, checklist, exportRoot: roots.exportRoot }),
    verify: verifyStatus(reports.verify),
    next_actions: nextActions({ config, reports, checklist })
  };

  if (writeReport) {
    writeJson(path.join(roots.exportRoot, REPORT_DIR, STATUS_REPORT), output);
  }
  return output;
}

function plannedReleaseStatus({ config }) {
  return {
    ok: true,
    type: "releasepress_release_status",
    schema_version: 1,
    mode: "plan",
    candidate: { state: "not_prepared" },
    stage: {
      state: config.stage_repo ? "planned" : "blocked",
      reason: config.stage_repo ? null : "stage_repo_required",
      target_id: config.stage.id,
      repo: config.stage_repo ? redactTargetValue(config.stage_repo) : null,
      ref: config.stage.strategy === "unique-ref" ? `${config.stage.ref_prefix}/<stage_commit>` : config.stage.ref,
      strategy: config.stage.strategy
    },
    review: plannedReviewStatus(config),
    attestation: plannedAttestationStatus(config),
    local_promote: {
      state: config.surfaces.local.enabled ? "planned" : "skipped",
      reason: config.surfaces.local.enabled ? null : "local_surface_disabled"
    },
    delivery: {
      providers: config.delivery.providers.map((provider) => ({
        target_id: provider.id,
        provider: provider.provider,
        kind: provider.kind,
        state: provider.enabled ? "planned" : "skipped",
        reason: provider.enabled ? null : "delivery_provider_disabled",
        review_target: provider.review_target ?? null,
        artifact: provider.artifact ?? null,
        repo: provider.repo ? redactTargetValue(provider.repo) : null,
        ref: provider.ref ?? null,
        channel: provider.channel ?? null
      }))
    },
    next_actions: ["releasepress release prepare --config <config> --out <public-tree>"]
  };
}

function plannedReviewStatus(config) {
  if (!publicPromotionRequired(config)) {
    return { state: "skipped", reason: "public_delivery_disabled" };
  }
  return {
    state: "planned",
    target_id: config.public_review.id ?? null,
    repo: redactTargetValue(config.public_review.repo),
    ref: config.public_review.ref,
    resolved_ref: `refs/heads/${config.public_review.ref}`,
    visibility: config.public_review.visibility,
    strategy: config.public_review.strategy
  };
}

function plannedAttestationStatus(config) {
  if (!publicPromotionRequired(config)) {
    return { state: "skipped", reason: "public_delivery_disabled" };
  }
  return {
    state: "blocked",
    reason: "public_review_not_published",
    review_target_id: config.public_review.id ?? null,
    required: config.public_review.requires_human_attestation
  };
}

function candidateStatus(exportRoot) {
  const summary = buildCandidateSummary(exportRoot);
  return {
    state: "prepared",
    path: exportRoot,
    source_commit: readSourceCommit(exportRoot),
    tree_fingerprint: summary.fingerprint,
    file_count: summary.file_count
  };
}

function stageStatus({ config, report, checklist }) {
  const step = stepById(checklist, "stage");
  if (!report.ok || report.value?.type !== "releasepress_stage" || report.value.ok !== true) {
    return {
      state: step?.status === "missing" ? "missing" : "blocked",
      reason: step?.reason ?? report.reason,
      target_id: config.stage.id,
      repo: config.stage_repo ? redactTargetValue(config.stage_repo) : null,
      ref: config.stage.strategy === "unique-ref" ? `${config.stage.ref_prefix}/<stage_commit>` : config.stage.ref,
      resolved_ref: null,
      strategy: config.stage.strategy
    };
  }
  return {
    state: step?.ok === true ? "published" : "invalid",
    reason: step?.ok === true ? null : step?.reason ?? null,
    target_id: report.value.target_id ?? config.stage.id,
    repo: redactTargetValue(report.value.stage_repo),
    ref: report.value.ref,
    resolved_ref: report.value.resolved_ref,
    strategy: report.value.strategy,
    commit: report.value.stage_commit,
    source_commit: report.value.source_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    previous_commit: report.value.previous_commit ?? null,
    replaced: report.value.replaced ?? false
  };
}

function reviewStatus({ config, report, checklist }) {
  if (!publicPromotionRequired(config)) {
    return { state: "skipped", reason: "public_delivery_disabled" };
  }
  const step = stepById(checklist, "public_review");
  if (!report.ok || report.value?.type !== "releasepress_public_review" || report.value.ok !== true) {
    return {
      state: "blocked",
      reason: step?.reason ?? "public_review_report_missing",
      target_id: config.public_review.id ?? null,
      repo: redactTargetValue(config.public_review.repo),
      ref: config.public_review.ref,
      resolved_ref: `refs/heads/${config.public_review.ref}`,
      visibility: config.public_review.visibility,
      strategy: config.public_review.strategy
    };
  }
  return {
    state: step?.ok === true ? "published" : "invalid",
    reason: step?.ok === true ? null : step?.reason ?? null,
    target_id: report.value.review_target_id ?? config.public_review.id ?? null,
    repo: redactTargetValue(report.value.repo),
    ref: report.value.ref,
    resolved_ref: report.value.resolved_ref,
    visibility: report.value.visibility,
    strategy: report.value.strategy,
    commit: report.value.review_commit,
    stage_commit: report.value.stage_commit,
    source_commit: report.value.source_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    previous_commit: report.value.previous_commit ?? null,
    replaced: report.value.replaced ?? false
  };
}

function attestationStatus({ config, report, checklist }) {
  if (!publicPromotionRequired(config)) {
    return { state: "skipped", reason: "public_delivery_disabled" };
  }
  const step = stepById(checklist, "public_review_attestation");
  if (!report.ok || report.value?.type !== "releasepress_public_review_attestation" || report.value.ok !== true) {
    return {
      state: "blocked",
      reason: step?.reason ?? "public_review_attestation_missing",
      review_target_id: config.public_review.id ?? null,
      required: config.public_review.requires_human_attestation
    };
  }
  return {
    state: step?.ok === true ? "attested" : "invalid",
    reason: step?.ok === true ? null : step?.reason ?? null,
    review_target_id: report.value.review_target_id ?? config.public_review.id ?? null,
    repo: redactTargetValue(report.value.repo),
    ref: report.value.ref,
    resolved_ref: report.value.resolved_ref,
    review_commit: report.value.review_commit,
    stage_commit: report.value.stage_commit,
    source_commit: report.value.source_commit,
    candidate_fingerprint: report.value.candidate_fingerprint ?? null,
    delivery_targets: report.value.delivery_targets ?? [],
    reviewer: report.value.reviewer ?? null,
    attested_at: report.value.attested_at ?? null
  };
}

function localPromoteStatus({ config, report }) {
  if (!config.surfaces.local.enabled) {
    return { state: "skipped", reason: "local_surface_disabled" };
  }
  if (!report.ok || report.value?.type !== "releasepress_local_promote_receipt" || report.value.ok !== true) {
    return {
      state: "ready",
      reason: "local_promote_not_run",
      command_name: config.surfaces.local.command_name,
      strategy: config.surfaces.local.strategy
    };
  }
  return {
    state: "promoted",
    command_name: report.value.installed_command,
    strategy: report.value.strategy,
    promoted_commit: report.value.promoted_commit ?? null
  };
}

function deliveryStatus({ config, reports, checklist, exportRoot }) {
  return {
    providers: config.delivery.providers.map((provider) =>
      providerStatus({ provider, reports, checklist, exportRoot })
    )
  };
}

function providerStatus({ provider, reports, checklist, exportRoot }) {
  const base = {
    target_id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    enabled: provider.enabled,
    review_target: provider.review_target ?? null,
    artifact: provider.artifact ?? null,
    repo: provider.repo ? redactTargetValue(provider.repo) : null,
    ref: provider.ref ?? null,
    channel: provider.channel ?? null
  };
  if (!provider.enabled) {
    return { ...base, state: "skipped", reason: "delivery_provider_disabled" };
  }
  const report = readJsonReport(exportRoot, providerReportName(provider.id));
  if (report.ok && report.value?.type === "releasepress_promote_provider" && report.value.ok === true) {
    return {
      ...base,
      state: "delivered",
      version: report.value.version ?? null,
      tag: report.value.tag ?? null,
      candidate_fingerprint: report.value.candidate_fingerprint ?? null,
      review_commit: report.value.review_commit ?? null
    };
  }
  const attestationStep = stepById(checklist, "public_review_attestation");
  if (attestationStep?.ok !== true) {
    return {
      ...base,
      state: "blocked",
      reason: attestationStep?.reason ?? "missing_review_attestation"
    };
  }
  if (report.ok && report.value?.ok !== true) {
    return {
      ...base,
      state: "invalid",
      reason: "provider_report_failed"
    };
  }
  return {
    ...base,
    state: "ready",
    reason: "provider_delivery_not_run"
  };
}

function verifyStatus(report) {
  if (!report.ok || report.value?.type !== "releasepress_verify") {
    return { state: "not_run", ok: null };
  }
  return {
    state: report.value.ok ? "passed" : "failed",
    ok: report.value.ok,
    blockers: report.value.blockers ?? []
  };
}

function nextActions({ config, reports, checklist }) {
  const actions = [];
  
  // Check for preflight blockers
  const blockers = checklist.promote?.blockers ?? [];
  if (blockers.length > 0) {
    const hasNpmBlocker = blockers.some((b) => b.reason === "npm_version_already_published");
    const hasGitBlocker = blockers.some((b) => b.reason === "git_tag_target_mismatch" || b.reason === "git_tag_missing");
    const hasIdentityBlocker = blockers.some((b) => b.reason === "release_identity_invalid" || b.reason === "release_identity_missing");

    if (hasNpmBlocker) {
      actions.push(
        "bump package version and rebuild/restage",
        "choose a new prerelease version",
        "publish npm only after the package version is proven unpublished"
      );
    }
    if (hasGitBlocker) {
      actions.push("deliver GitHub first, then tag the delivered public commit");
    }
    if (hasIdentityBlocker) {
      actions.push("create/recreate the staging preview from the new source commit");
    }

    if (actions.length > 0) {
      return actions;
    }
  }

  if (!reports.stage.ok) {
    actions.push("releasepress stage --config <config> --path <public-tree>");
    return actions;
  }
  if (publicPromotionRequired(config) && !reports.publicReview.ok) {
    actions.push("releasepress release publish-review --config <config> --path <public-tree> --target <review-target>");
    return actions;
  }
  const attestationStep = stepById(checklist, "public_review_attestation");
  if (publicPromotionRequired(config) && attestationStep?.ok !== true) {
    actions.push("releasepress release attest --config <config> --path <public-tree> --target <review-target> --approve-public-review");
    return actions;
  }
  for (const provider of config.delivery.providers.filter((candidate) => candidate.enabled)) {
    const providerReport = readJsonReportFromChecklistRoot(reports, provider.id);
    if (!providerReport.ok) {
      actions.push(`releasepress release deliver --config <config> --path <public-tree> --target ${provider.id} --approve-public ${provider.id}`);
    }
  }
  if (actions.length === 0 && config.surfaces.local.enabled && !reports.localPromote.ok) {
    if (config.surfaces.local.source === "source") {
      actions.push(
        "releasepress local prepare --config <config> --source <clean-source> --out <local-evidence>",
        "releasepress promote local --config <config> --source <clean-source> --path <local-evidence> --approve-local"
      );
    } else {
      actions.push("releasepress promote local --config <config> --path <public-tree> --approve-local");
    }
  }
  return actions;
}

function readJsonReportFromChecklistRoot(reports, providerId) {
  return reports[`provider:${providerId}`] ?? { ok: false };
}

function stepById(checklist, id) {
  return checklist.steps.find((step) => step.id === id);
}

function resolveRoots({ exportRoot, sourceRoot }) {
  const roots = {
    exportRoot: path.resolve(exportRoot),
    sourceRoot: path.resolve(sourceRoot)
  };
  assertDirectory(roots.exportRoot, "export");
  assertDirectory(roots.sourceRoot, "source");
  return roots;
}

function assertDirectory(root, purpose) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", `${purpose} path does not exist`, { path: root });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `${purpose} path must not be a symlink`, { path: root });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `${purpose} path must be a directory`, { path: root });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
