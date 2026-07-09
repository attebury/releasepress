import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReleasepressError } from "./config.js";

export function runPreflight({ config, exportRoot, sourceRoot = process.cwd() }) {
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
  const cwd = config.preflight.cwd === "source" ? roots.sourceRoot : roots.exportRoot;
  const startedAt = Date.now();
  const steps = [];

  for (const step of config.preflight.steps) {
    const result = runStep({ step, cwd, timeoutMs: config.preflight.timeout_ms });
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

function runStep({ step, cwd, timeoutMs }) {
  const startedAt = Date.now();
  if (isNpmStep(step) && !fs.existsSync(path.join(cwd, "package.json"))) {
    return {
      type: "releasepress_preflight_step",
      id: step.id,
      ok: true,
      required: step.required,
      skipped: true,
      skip_reason: "package_json_missing",
      duration_ms: Date.now() - startedAt,
      exit_code: null
    };
  }

  const result = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || path.join(os.tmpdir(), "releasepress-npm-cache")
    }
  });
  const timedOut = result.error?.code === "ETIMEDOUT";

  return {
    type: "releasepress_preflight_step",
    id: step.id,
    ok: result.status === 0 && !timedOut,
    required: step.required,
    skipped: false,
    duration_ms: Date.now() - startedAt,
    exit_code: result.status,
    signal: result.signal ?? null,
    error_code: timedOut ? "preflight_step_timeout" : result.error?.code ?? null
  };
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

function isNpmStep(step) {
  return step.argv[0] === "npm";
}

function assertConfig(config) {
  if (!config?.preflight) {
    throw new ReleasepressError("invalid_config", "Validated config is required for preflight");
  }
}
