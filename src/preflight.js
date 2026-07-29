import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runConfiguredArgvStep } from "./argv-steps.js";
import { buildCandidateSummary, readSourceCommit } from "./candidate.js";
import { ReleasepressError } from "./config.js";
import {
  createPreflightWorkspace,
  removePreflightWorkspace
} from "./preflight-workspace.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function runPreflight({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  runner = spawnSync,
  workspaceFactory = createPreflightWorkspace,
  workspaceRemover = removePreflightWorkspace
}) {
  assertConfig(config);
  if (!config.preflight.enabled) {
    const output = {
      ok: true,
      type: "releasepress_preflight",
      enabled: false,
      skipped: true,
      skip_reason: "preflight_disabled",
      steps: []
    };
    if (exportRoot) {
      const roots = resolveRoots({ exportRoot, sourceRoot });
      output.export_root = roots.exportRoot;
      output.source_root = roots.sourceRoot;
      writePreflightReport(roots.exportRoot, output);
    }
    return output;
  }

  const roots = resolveRoots({ exportRoot, sourceRoot });
  if (config.preflight.cwd === "export") {
    return runIsolatedExportPreflight({
      config,
      roots,
      runner,
      workspaceFactory,
      workspaceRemover
    });
  }

  const cwd = roots.sourceRoot;
  const startedAt = Date.now();
  const steps = [];

  for (const step of config.preflight.steps) {
    const result = runConfiguredArgvStep({
      step,
      cwd,
      timeoutMs: config.preflight.timeout_ms,
      runner
    });
    steps.push(result);
    if (step.required && !result.ok) {
      break;
    }
  }

  const output = {
    ok: steps.every((step) => step.ok || !step.required),
    type: "releasepress_preflight",
    enabled: true,
    cwd: config.preflight.cwd,
    root: cwd,
    export_root: roots.exportRoot,
    source_root: roots.sourceRoot,
    duration_ms: Date.now() - startedAt,
    steps
  };

  writePreflightReport(roots.exportRoot, output);
  return output;
}

export function assertPreflightSatisfied({ config, exportRoot }) {
  assertConfig(config);
  if (!config.preflight.enabled) {
    return {
      ok: true,
      type: "releasepress_preflight_gate",
      enabled: false,
      skipped: true,
      skip_reason: "preflight_disabled"
    };
  }
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }

  const root = path.resolve(exportRoot);
  const reportRel = ".releasepress-report/preflight-results.json";
  const reportPath = path.join(root, reportRel);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("preflight_required", "Preflight must pass before promote", {
        report: reportRel
      });
    }
    if (error instanceof SyntaxError) {
      throw new ReleasepressError("preflight_report_invalid", "Preflight report is not valid JSON", {
        report: reportRel,
        reason: error.message
      });
    }
    throw error;
  }

  assertPassingEnabledReport(parsed, root, reportRel);

  if (!parsed.ok) {
    throw new ReleasepressError("preflight_failed", "Preflight must pass before promote", {
      report: reportRel
    });
  }
  if (config.preflight.cwd === "export") {
    assertIsolatedExportReport({
      parsed,
      exportRoot: root,
      reportRel
    });
  }

  return {
    ok: true,
    type: "releasepress_preflight_gate",
    enabled: true,
    report: reportPath
  };
}

function assertPassingEnabledReport(parsed, exportRoot, reportRel) {
  const exportRootMatches =
    typeof parsed?.export_root === "string" && path.resolve(parsed.export_root) === exportRoot;
  if (
    parsed?.type !== "releasepress_preflight" ||
    parsed.enabled !== true ||
    parsed.skipped === true ||
    !Array.isArray(parsed.steps) ||
    !exportRootMatches
  ) {
    throw new ReleasepressError("preflight_report_mismatch", "Preflight report does not prove enabled preflight passed", {
      report: reportRel
    });
  }
}

function runIsolatedExportPreflight({
  config,
  roots,
  runner,
  workspaceFactory,
  workspaceRemover
}) {
  const startedAt = Date.now();
  let candidate = null;
  let binding = null;
  let workspace = null;
  let output = null;
  let runError = null;
  let cleanupError = null;

  try {
    candidate = buildCandidateSummary(roots.exportRoot);
    binding = readCandidateBinding(roots.exportRoot, candidate);
    workspace = workspaceFactory({
      candidateRoot: roots.exportRoot,
      expectedSummary: candidate
    });
    const workspaceSummary = buildCandidateSummary(workspace.root);
    assertSummaryMatches(
      candidate,
      workspaceSummary,
      "preflight_workspace_mismatch",
      "Isolated preflight workspace does not match the candidate"
    );

    const steps = [];
    for (const step of config.preflight.steps) {
      const result = runConfiguredArgvStep({
        step,
        cwd: workspace.root,
        timeoutMs: config.preflight.timeout_ms,
        runner
      });
      steps.push(result);
      if (step.required && !result.ok) {
        break;
      }
    }

    const candidateAfter = buildCandidateSummary(roots.exportRoot);
    assertSummaryMatches(
      candidate,
      candidateAfter,
      "preflight_candidate_changed",
      "Candidate changed while isolated preflight was running"
    );

    output = {
      ok: steps.every((step) => step.ok || !step.required),
      type: "releasepress_preflight",
      enabled: true,
      cwd: "export",
      root: roots.exportRoot,
      export_root: roots.exportRoot,
      source_root: roots.sourceRoot,
      duration_ms: Date.now() - startedAt,
      candidate_fingerprint: candidate.fingerprint,
      candidate_file_count: candidate.file_count,
      source_commit: binding.sourceCommit,
      stage_commit: binding.stageCommit,
      execution: {
        isolated: true,
        workspace_cleanup: "pending"
      },
      steps
    };
  } catch (error) {
    runError = error;
  } finally {
    if (workspace) {
      try {
        workspaceRemover(workspace);
      } catch {
        cleanupError = new ReleasepressError(
          "preflight_workspace_cleanup_failed",
          "Isolated preflight workspace could not be removed safely"
        );
      }
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
  if (runError) {
    if (runError instanceof ReleasepressError) {
      throw runError;
    }
    throw new ReleasepressError(
      "preflight_isolation_failed",
      "Isolated export preflight could not be completed safely"
    );
  }

  output.execution.workspace_cleanup = "complete";
  writePreflightReport(roots.exportRoot, output);
  return output;
}

function assertIsolatedExportReport({ parsed, exportRoot, reportRel }) {
  if (
    parsed.cwd !== "export"
    || parsed.execution?.isolated !== true
    || parsed.execution?.workspace_cleanup !== "complete"
  ) {
    throw new ReleasepressError(
      "preflight_report_isolation_mismatch",
      "Preflight report does not prove isolated export execution",
      { report: reportRel }
    );
  }

  const candidate = buildCandidateSummary(exportRoot);
  if (
    parsed.candidate_fingerprint !== candidate.fingerprint
    || parsed.candidate_file_count !== candidate.file_count
  ) {
    throw new ReleasepressError(
      "preflight_report_candidate_mismatch",
      "Preflight report does not match the current candidate",
      { report: reportRel }
    );
  }

  const binding = readCandidateBinding(exportRoot, candidate);
  if (parsed.source_commit !== binding.sourceCommit) {
    throw new ReleasepressError(
      "preflight_report_source_mismatch",
      "Preflight report does not match the candidate source commit",
      { report: reportRel }
    );
  }
  if (parsed.stage_commit !== binding.stageCommit) {
    throw new ReleasepressError(
      "preflight_report_stage_mismatch",
      "Preflight report does not match the current stage receipt",
      { report: reportRel }
    );
  }
}

function readCandidateBinding(exportRoot, candidate) {
  const sourceCommit = readSourceCommit(exportRoot);
  if (!SHA_PATTERN.test(sourceCommit)) {
    throw new ReleasepressError(
      "preflight_source_commit_missing",
      "Isolated export preflight requires a full source commit binding"
    );
  }

  const stagePath = path.join(exportRoot, ".releasepress-report", "stage-results.json");
  let stage;
  try {
    stage = JSON.parse(fs.readFileSync(stagePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { sourceCommit, stageCommit: null };
    }
    throw new ReleasepressError(
      "preflight_stage_report_invalid",
      "Stage receipt is not valid for isolated preflight"
    );
  }

  if (
    stage?.type !== "releasepress_stage"
    || stage.ok !== true
    || !SHA_PATTERN.test(stage.stage_commit ?? "")
    || stage.source_commit !== sourceCommit
    || stage.candidate_fingerprint !== candidate.fingerprint
    || stage.candidate_file_count !== candidate.file_count
  ) {
    throw new ReleasepressError(
      "preflight_stage_report_mismatch",
      "Stage receipt does not match the isolated preflight candidate"
    );
  }
  return {
    sourceCommit,
    stageCommit: stage.stage_commit
  };
}

function assertSummaryMatches(expected, actual, code, message) {
  if (
    expected.fingerprint !== actual.fingerprint
    || expected.file_count !== actual.file_count
  ) {
    throw new ReleasepressError(code, message);
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
      throw new ReleasepressError("missing_path", `Preflight ${label} path does not exist`, { path: original });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `Preflight ${label} path must not be a symlink`, {
      path: original
    });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `Preflight ${label} path must be a directory`, { path: original });
  }
}

function writePreflightReport(exportRoot, output) {
  const reportDir = path.join(exportRoot, ".releasepress-report");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "preflight-results.json"), `${JSON.stringify(output, null, 2)}\n`);
}

function assertConfig(config) {
  if (!config?.preflight) {
    throw new ReleasepressError("invalid_config", "Validated config is required for preflight");
  }
}
