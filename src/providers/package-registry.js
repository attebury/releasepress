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
import { releasepressEnvelope } from "../packet-envelope.js";
import { resolveVersion } from "../release-meta.js";
import { readJsonReport } from "../report-io.js";
import { redactTargetValue } from "../target.js";
import { providerReportName } from "./git-host.js";

const REPORT_DIR = ".releasepress-report";

const NPM_DUPLICATE_VERSION_PATTERNS = [
  /cannot publish over the previously published versions/i,
  /EPUBLISHCONFLICT/i,
  /E403[\s\S]*cannot publish over/i,
  /You cannot publish over the previously published versions/i
];

export function promotePackageRegistryProvider({
  provider,
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  releaseEvidence = null,
  toolchainCompatibility = null,
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
  if (provider.launch_root !== "export") {
    throw new ReleasepressError(
      "package_registry_launch_root_unsupported",
      "package_registry providers must use launch_root export so npm ships the scanned export tree",
      {
        provider_id: provider.id,
        launch_root: provider.launch_root ?? null
      }
    );
  }

  const roots = resolvePromoteRoots({ exportRoot, sourceRoot });
  const scanReport = readJsonReport(roots.exportRoot, "scan-results.json");
  if (!scanReport.ok || scanReport.value?.ok !== true) {
    throw new ReleasepressError(
      "package_registry_scan_required",
      "package_registry promote requires a passing export scan report",
      {
        provider_id: provider.id,
        report: `${REPORT_DIR}/scan-results.json`,
        scan_ok: scanReport.ok ? scanReport.value?.ok ?? null : false
      }
    );
  }
  const gate = assertProviderLaunchPrerequisites({
    provider: provider.id,
    config,
    exportRoot: roots.exportRoot,
    sourceRoot: roots.sourceRoot,
    releaseEvidence,
    toolchainCompatibility
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

  let launcher;
  let delivery = {
    status: "launched",
    reconcile: null
  };

  try {
    launcher = withReportBundlePreserved(roots.exportRoot, () =>
      runLauncher({
        id: provider.id,
        argv: provider.launcher.command_argv,
        cwd: launchCwd,
        env: launcherEnv({
          exportRoot: roots.exportRoot,
          sourceRoot: roots.sourceRoot
        }),
        runner,
        interactive: false,
        errorCode: "provider_launch_command_failed"
      })
    );
  } catch (error) {
    if (!(error instanceof ReleasepressError) || error.code !== "provider_launch_command_failed") {
      throw error;
    }
    if (!isNpmDuplicateVersionError(error.details?.stderr)) {
      throw error;
    }

    const reconcile = reconcileNpmAlreadyDelivered({
      provider,
      version: version.version,
      cwd: launchCwd,
      runner,
      artifact: artifactReport.artifact,
      launchError: error
    });
    launcher = {
      id: provider.id,
      argv: error.details?.argv ?? redactArgv(provider.launcher.command_argv),
      status: error.details?.status ?? 1,
      cwd: launchCwd
    };
    delivery = {
      status: "already_delivered",
      reconcile
    };
  }

  const providerVerify = runArgvVerify({
    provider,
    version: version.version,
    cwd: launchCwd,
    runner
  });

  const output = {
    ...releasepressEnvelope({ ok: true, type: "releasepress_promote_provider" }),
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
    delivery,
    provider_verify: providerVerify
  };
  if (gate.release_evidence.status !== "skipped") {
    output.release_evidence = gate.release_evidence;
  }
  if (gate.toolchain_compatibility.status !== "skipped") {
    output.toolchain_compatibility = gate.toolchain_compatibility;
  }

  writeJson(path.join(roots.exportRoot, REPORT_DIR, providerReportName(provider.id)), output);
  return output;
}

export function isNpmDuplicateVersionError(stderr) {
  const text = String(stderr ?? "");
  if (!text) {
    return false;
  }
  return NPM_DUPLICATE_VERSION_PATTERNS.some((pattern) => pattern.test(text));
}

function reconcileNpmAlreadyDelivered({
  provider,
  version,
  cwd,
  runner,
  artifact,
  launchError
}) {
  if (provider.verify?.kind !== "argv" || !Object.keys(provider.verify.expect ?? {}).length) {
    throw new ReleasepressError(
      launchError.code,
      launchError.message,
      {
        ...launchError.details,
        reconcile_skipped: "verify_not_configured",
        reason: "npm duplicate-version requires configured argv verify to reconcile already-delivered state"
      }
    );
  }

  let verifyResult;
  try {
    verifyResult = runArgvVerify({
      provider,
      version,
      cwd,
      runner,
      requireConfigured: true
    });
  } catch (error) {
    throw new ReleasepressError(
      launchError.code,
      launchError.message,
      {
        ...launchError.details,
        reconcile_failed: error instanceof ReleasepressError ? error.code : "reconcile_verify_failed",
        reconcile_details: error instanceof ReleasepressError ? error.details : null,
        reason: "npm duplicate-version reconcile failed registry verification"
      }
    );
  }

  let integrityChecked = false;
  try {
    integrityChecked = assertIntegrityWhenAvailable({
      provider,
      version,
      cwd,
      runner,
      artifact,
      verifyPayload: verifyResult.payload
    });
  } catch (error) {
    throw new ReleasepressError(
      launchError.code,
      launchError.message,
      {
        ...launchError.details,
        reconcile_failed: error instanceof ReleasepressError ? error.code : "reconcile_integrity_failed",
        reconcile_details: error instanceof ReleasepressError ? error.details : null,
        reason: "npm duplicate-version reconcile failed integrity check"
      }
    );
  }

  return {
    reason: "npm_duplicate_version",
    registry_version: version,
    dist_tag: provider.channel,
    integrity_checked: integrityChecked
  };
}

function assertIntegrityWhenAvailable({
  provider,
  version,
  cwd,
  runner,
  artifact,
  verifyPayload
}) {
  const localIntegrity = readLocalIntegrity(artifact);
  if (!localIntegrity) {
    return false;
  }

  let registryIntegrity = readRegistryIntegrity(verifyPayload);
  if (!registryIntegrity) {
    registryIntegrity = fetchRegistryIntegrity({
      provider,
      version,
      cwd,
      runner
    });
  }
  if (!registryIntegrity) {
    return false;
  }

  if (String(registryIntegrity) !== String(localIntegrity)) {
    throw new ReleasepressError(
      "package_registry_reconcile_integrity_mismatch",
      "Registry package integrity does not match the local candidate",
      {
        provider_id: provider.id,
        local_integrity: localIntegrity,
        registry_integrity: registryIntegrity
      }
    );
  }
  return true;
}

function readLocalIntegrity(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return null;
  }
  return (
    artifact.integrity
    ?? artifact.shasum
    ?? artifact.dist?.integrity
    ?? artifact.dist?.shasum
    ?? null
  );
}

function readRegistryIntegrity(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return (
    payload.dist?.integrity
    ?? payload.dist?.shasum
    ?? payload.integrity
    ?? payload.shasum
    ?? null
  );
}

function fetchRegistryIntegrity({ provider, version, cwd, runner }) {
  const packageName = resolvePackageName({ cwd, provider });
  if (!packageName) {
    return null;
  }
  const argv = ["npm", "view", `${packageName}@${version}`, "dist", "--json"];
  const result = runner(argv[0], argv.slice(1), {
    cwd,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0) {
    return null;
  }
  try {
    const payload = JSON.parse(String(result.stdout || "").trim());
    return readRegistryIntegrity({ dist: payload });
  } catch {
    return null;
  }
}

function resolvePackageName({ cwd, provider }) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (typeof pkg?.name === "string" && pkg.name.length > 0) {
      return pkg.name;
    }
  } catch {
    // fall through
  }
  const viewArg = provider.verify?.command_argv?.find((arg, index, argv) =>
    argv[index - 1] === "view" && typeof arg === "string" && !arg.startsWith("-")
  );
  if (typeof viewArg === "string" && viewArg.length > 0) {
    return viewArg.split("@")[0];
  }
  return null;
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
        violations: report.value.violations ?? [],
        integrity: report.value.integrity ?? null,
        shasum: report.value.shasum ?? null
      }
    };
  }

  throw new ReleasepressError("package_artifact_missing", "Package report does not contain the referenced artifact", {
    artifact_id: artifactId
  });
}

function runArgvVerify({ provider, version, cwd, runner, requireConfigured = false }) {
  if (provider.verify.kind !== "argv") {
    if (requireConfigured) {
      throw new ReleasepressError("package_registry_verify_not_configured", "Package registry reconcile requires argv verify");
    }
    return { ok: true, status: "skipped", reason: "verify_not_configured", payload: null };
  }
  if (!Object.keys(provider.verify.expect ?? {}).length) {
    if (requireConfigured) {
      throw new ReleasepressError("package_registry_verify_expect_missing", "Package registry reconcile requires verify.expect");
    }
    return { ok: true, status: "skipped", reason: "verify_expect_missing", payload: null };
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
    expect: provider.verify.expect,
    payload
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
