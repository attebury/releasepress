import fs from "node:fs";
import path from "node:path";
import { createChecklist } from "./checklist.js";
import { ReleasepressError } from "./config.js";
import { validateLocalPromoteReceipt } from "./promote-local.js";

const REPORT_DIR = ".releasepress-report";
const VERIFY_REPORT = "verify-results.json";

export function verifyRelease({ config, exportRoot, sourceRoot = process.cwd() }) {
  const roots = resolveRoots({ exportRoot, sourceRoot });
  const checklist = createChecklist({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const checks = [
    checklistCheck(checklist),
    ...providerPromoteChecks({ config, exportRoot: roots.exportRoot }),
    localPromoteCheck({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot })
  ];
  const blockers = checks
    .filter((check) => check.ok === false)
    .map((check) => ({
      check: check.id,
      reason: check.reason ?? "not_satisfied"
    }));

  const output = {
    ok: blockers.length === 0,
    type: "releasepress_verify",
    report_dir: REPORT_DIR,
    checklist: {
      ok: checklist.ok,
      promote_ready: checklist.promote.ready,
      blockers: checklist.promote.blockers ?? []
    },
    delivery: {
      providers: config.delivery.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        provider: provider.provider,
        enabled: provider.enabled,
        review_target: provider.review_target,
        artifact: provider.artifact,
        repo: provider.repo ?? null,
        ref: provider.ref ?? null,
        channel: provider.channel ?? null
      }))
    },
    checks,
    blockers
  };

  writeJson(path.join(roots.exportRoot, REPORT_DIR, VERIFY_REPORT), output);
  createChecklist({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  return output;
}

function checklistCheck(checklist) {
  if (checklist.ok && checklist.promote.ready) {
    return {
      id: "checklist",
      status: "passed",
      ok: true
    };
  }
  return {
    id: "checklist",
    status: "failed",
    ok: false,
    reason: "promote_prerequisites_failed",
    blockers: checklist.promote.blockers ?? []
  };
}

function providerPromoteChecks({ config, exportRoot }) {
  return config.delivery.providers
    .filter((provider) => provider.enabled)
    .map((provider) => providerPromoteCheck({ provider, exportRoot }));
}

function providerPromoteCheck({ provider, exportRoot }) {
  const id = `provider_${provider.id}`;
  const report = readJsonReport(exportRoot, `provider-${provider.id}.json`);
  const stageReport = readJsonReport(exportRoot, "stage-results.json");
  const attestationReport = readJsonReport(exportRoot, "public-review-attestation.json");
  if (!report.ok && report.status === "missing") {
    return skippedCheck(id, "provider_promote_not_run");
  }
  if (!report.ok) {
    return reportCheckFailure(id, report);
  }
  const value = report.value;
  if (value?.type !== "releasepress_promote_provider") {
    return invalidCheck(id, "provider_promote_report_type_mismatch");
  }
  if (!value.ok) {
    return failedCheck(id, "provider_promote_report_failed");
  }

  const comparisons = [
    ["provider_id", provider.id, value.provider_id],
    ["kind", provider.kind, value.kind],
    ["provider", provider.provider, value.provider],
    ["review_target", provider.review_target, value.review_target ?? null],
    ["review_target_id", provider.review_target, value.review_target_id ?? null],
    ["launch_root", provider.launch_root, value.launch_root],
    ["launch_path", provider.launch_path, value.launch_path]
  ];
  if (stageReport.ok) {
    comparisons.push(["stage_commit", stageReport.value.stage_commit, value.stage_commit ?? null]);
    comparisons.push([
      "candidate_fingerprint",
      stageReport.value.candidate_fingerprint ?? null,
      value.candidate_fingerprint ?? null
    ]);
  }
  if (attestationReport.ok) {
    comparisons.push(["review_commit", attestationReport.value.review_commit, value.review_commit ?? null]);
    comparisons.push([
      "attestation_candidate_fingerprint",
      attestationReport.value.candidate_fingerprint ?? null,
      value.candidate_fingerprint ?? null
    ]);
  }
  if (provider.kind === "git_host") {
    comparisons.push(["repo", provider.repo, value.repo]);
    comparisons.push(["ref", provider.ref, value.ref]);
  }
  if (provider.kind === "package_registry") {
    comparisons.push(["artifact", provider.artifact, value.artifact]);
    comparisons.push(["channel", provider.channel, value.channel ?? value.dist_tag ?? null]);
  }

  const mismatches = comparisons
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field, expected, actual]) => ({ field, expected: expected ?? null, actual: actual ?? null }));
  if (mismatches.length > 0) {
    return failedCheck(id, "provider_promote_report_mismatch", { mismatches });
  }

  return {
    id,
    status: "passed",
    ok: true,
    provider_id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    artifact: provider.artifact ?? null,
    repo: provider.repo ?? null,
    ref: provider.ref ?? null,
    channel: provider.channel ?? null,
    version: value.version ?? null
  };
}

function localPromoteCheck({ config, exportRoot, sourceRoot }) {
  if (!config.surfaces.local.enabled) {
    return skippedCheck("local_promote", "local_surface_disabled");
  }

  const report = readJsonReport(exportRoot, "local-promote.json");
  if (!report.ok && report.status === "missing") {
    return skippedCheck("local_promote", "local_promote_not_run");
  }
  if (!report.ok) {
    return reportCheckFailure("local_promote", report);
  }
  try {
    validateLocalPromoteReceipt({
      config,
      exportRoot,
      sourceRoot,
      receipt: report.value,
      requireInstalled: true
    });
  } catch (error) {
    if (error instanceof ReleasepressError) {
      return failedCheck("local_promote", error.code, { details: error.details });
    }
    throw error;
  }
  return {
    id: "local_promote",
    status: "passed",
    ok: true,
    strategy: report.value.strategy,
    installed_command: report.value.installed_command
  };
}

function resolveRoots({ exportRoot, sourceRoot }) {
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
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
  } catch {
    return {
      ok: false,
      status: "invalid",
      reason: "report_json_invalid",
      report
    };
  }
}

function reportCheckFailure(id, report) {
  return {
    id,
    status: report.status,
    ok: false,
    reason: report.reason,
    report: `${REPORT_DIR}/${report.report}`
  };
}

function skippedCheck(id, reason) {
  return {
    id,
    status: "skipped",
    ok: true,
    reason
  };
}

function invalidCheck(id, reason) {
  return failedCheck(id, reason, { status: "invalid" });
}

function failedCheck(id, reason, fields = {}) {
  return {
    id,
    status: "failed",
    ok: false,
    reason,
    ...fields
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
