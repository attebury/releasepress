import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReleasepressError } from "../config.js";
import { runLauncher } from "../launcher.js";
import { assertProviderLaunchPrerequisites } from "../provider-gate.js";
import {
  launcherEnv,
  resolveLaunchCwd,
  resolvePromoteRoots,
  withReportBundlePreserved
} from "../promote-roots.js";
import { resolveVersion } from "../release-meta.js";
import { redactTargetValue } from "../target.js";
import { providerReportName } from "./git-host.js";

const REPORT_DIR = ".releasepress-report";

export function promotePackageRegistryProvider({
  provider,
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  runner = spawnSync
}) {
  if (provider.provider !== "npm") {
    throw new ReleasepressError("delivery_provider_unsupported", "Only npm package registry providers are supported in this slice", {
      provider_id: provider.id,
      provider: provider.provider
    });
  }
  if (!provider.artifact) {
    throw new ReleasepressError("delivery_provider_invalid", "package_registry provider requires an artifact", {
      provider_id: provider.id
    });
  }
  if (!provider.channel) {
    throw new ReleasepressError("delivery_provider_invalid", "npm package registry provider requires a channel", {
      provider_id: provider.id
    });
  }
  if (!provider.launcher.command_argv.length) {
    throw new ReleasepressError("missing_provider_launcher_argv", "package_registry provider launcher argv is required", {
      provider_id: provider.id
    });
  }

  const roots = resolvePromoteRoots({ exportRoot, sourceRoot });
  const gate = assertProviderLaunchPrerequisites({
    provider: provider.id,
    config,
    exportRoot: roots.exportRoot,
    sourceRoot: roots.sourceRoot
  });
  const artifactReport = readArtifactReport({
    roots,
    artifactId: provider.artifact
  });
  const version = resolveVersion({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const launchCwd = resolveLaunchCwd({
    roots,
    launchRoot: provider.launch_root,
    launchPath: provider.launch_path
  });
  const launchCwdLabel = provider.launch_path === "."
    ? provider.launch_root
    : `${provider.launch_root}/${provider.launch_path}`;

  const launcher = withReportBundlePreserved(roots.exportRoot, () =>
    runLauncher({
      id: provider.id,
      argv: provider.launcher.command_argv,
      cwd: launchCwd,
      env: launcherEnv({
        exportRoot: roots.exportRoot,
        sourceRoot: roots.sourceRoot
      }),
      runner,
      interactive: true,
      errorCode: "provider_launch_command_failed"
    })
  );

  const providerVerify = runArgvVerify({
    provider,
    version: version.version,
    cwd: launchCwd,
    runner
  });

  const output = {
    ok: true,
    type: "releasepress_promote_provider",
    provider_id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    artifact: provider.artifact,
    artifact_report: artifactReport.report,
    channel: provider.channel,
    dist_tag: provider.channel,
    workspace: provider.workspace,
    review_target: provider.review_target,
    review_target_id: gate.evidence.review_target_id,
    review_commit: gate.evidence.review_commit,
    stage_commit: gate.evidence.stage_commit,
    candidate_fingerprint: gate.evidence.candidate_fingerprint,
    attestation_report: gate.evidence.attestation_report,
    version: version.version,
    launch_root: provider.launch_root,
    launch_path: provider.launch_path,
    launcher: {
      ...launcher,
      cwd: launchCwdLabel
    },
    provider_verify: providerVerify
  };

  writeJson(path.join(roots.exportRoot, REPORT_DIR, providerReportName(provider.id)), output);
  return output;
}

function readArtifactReport({ roots, artifactId }) {
  const source = readJsonReport(roots.sourceRoot, "package-files.json");
  const report = source.ok ? source : readJsonReport(roots.exportRoot, "package-files.json");
  if (!report.ok) {
    throw new ReleasepressError("package_report_missing", "Package registry provider requires a package report", {
      provider_id: artifactId,
      report: `${REPORT_DIR}/package-files.json`
    });
  }
  if (report.value?.type !== "releasepress_package" || report.value.ok !== true) {
    throw new ReleasepressError("package_report_invalid", "Package registry provider requires a passing package report", {
      artifact_id: artifactId
    });
  }

  const artifact = Array.isArray(report.value.artifacts)
    ? report.value.artifacts.find((candidate) => candidate.id === artifactId)
    : null;
  if (artifact) {
    if (artifact.ok !== true) {
      throw new ReleasepressError("package_artifact_failed", "Referenced package artifact did not pass", {
        artifact_id: artifactId,
        violation_count: Array.isArray(artifact.violations) ? artifact.violations.length : null
      });
    }
    return {
      report: `${REPORT_DIR}/package-files.json`,
      root: source.ok ? "source" : "export",
      artifact
    };
  }

  if (report.value.artifact_id === artifactId || artifactId === "npm-package") {
    return {
      report: `${REPORT_DIR}/package-files.json`,
      root: source.ok ? "source" : "export",
      artifact: {
        id: artifactId,
        package_files: report.value.package_files ?? [],
        violations: report.value.violations ?? []
      }
    };
  }

  throw new ReleasepressError("package_artifact_missing", "Package report does not contain the referenced artifact", {
    artifact_id: artifactId
  });
}

function runArgvVerify({ provider, version, cwd, runner }) {
  if (provider.verify.kind !== "argv") {
    return { ok: true, status: "skipped", reason: "verify_not_configured" };
  }
  if (!Object.keys(provider.verify.expect ?? {}).length) {
    return { ok: true, status: "skipped", reason: "verify_expect_missing" };
  }

  const context = {
    version,
    channel: provider.channel,
    dist_tag: provider.channel
  };
  const argv = provider.verify.command_argv.map((arg) => substituteTemplates(arg, context));
  const result = runner(argv[0], argv.slice(1), {
    cwd,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0) {
    throw new ReleasepressError("package_registry_verify_failed", "Package registry provider verify command failed", {
      provider_id: provider.id,
      argv: redactArgv(argv),
      status,
      stderr: redactTargetValue(String(result.stderr || "").trim())
    });
  }

  let payload;
  try {
    payload = JSON.parse(String(result.stdout || "").trim());
  } catch {
    throw new ReleasepressError("package_registry_verify_invalid_json", "Package registry provider verify stdout was not JSON", {
      provider_id: provider.id,
      argv: redactArgv(argv)
    });
  }

  const mismatches = [];
  for (const [key, expectedTemplate] of Object.entries(provider.verify.expect)) {
    const expected = substituteTemplates(expectedTemplate, context);
    const actual = readJsonField(payload, key);
    if (String(actual) !== expected) {
      mismatches.push({ field: key, expected, actual });
    }
  }
  if (mismatches.length > 0) {
    throw new ReleasepressError("package_registry_verify_expectation_failed", "Package registry provider verify expectation failed", {
      provider_id: provider.id,
      mismatches
    });
  }

  return {
    ok: true,
    status: "passed",
    argv: redactArgv(argv),
    expect: provider.verify.expect
  };
}

function readJsonField(payload, field) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (Object.hasOwn(payload, field)) {
    return payload[field];
  }
  return field.split(".").reduce((value, segment) => {
    if (value && typeof value === "object" && Object.hasOwn(value, segment)) {
      return value[segment];
    }
    return null;
  }, payload);
}

function readJsonReport(root, report) {
  try {
    return {
      ok: true,
      value: JSON.parse(fs.readFileSync(path.join(root, REPORT_DIR, report), "utf8"))
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, status: "missing", report };
    }
    throw error;
  }
}

function substituteTemplates(value, context) {
  return String(value).replace(/\{([a-z_]+)\}/g, (_, key) => {
    if (!(key in context)) {
      throw new ReleasepressError("verify_template_unknown", "Unknown verify template key", { key, value });
    }
    return String(context[key]);
  });
}

function redactArgv(argv) {
  return argv.map((arg) => redactTargetValue(arg));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
