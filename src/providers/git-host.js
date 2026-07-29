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
import { resolveTag, resolveVersion } from "../release-meta.js";
import { redactTargetValue } from "../target.js";

const REPORT_DIR = ".releasepress-report";

export function promoteGitHostProvider({
  provider,
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  releaseEvidence = null,
  toolchainCompatibility = null,
  runner = spawnSync
}) {
  if (provider.launch_root !== "export") {
    throw new ReleasepressError(
      "git_host_launch_root_unsupported",
      "git_host providers must launch from the scanned export tree",
      {
        provider_id: provider.id,
        launch_root: provider.launch_root ?? null
      }
    );
  }
  if (!provider.repo || !provider.ref) {
    throw new ReleasepressError("delivery_provider_invalid", "git_host provider requires repo and ref", {
      provider_id: provider.id
    });
  }
  if (!provider.launcher.command_argv.length) {
    throw new ReleasepressError("missing_provider_launcher_argv", "git_host provider launcher argv is required", {
      provider_id: provider.id
    });
  }

  const roots = resolvePromoteRoots({ exportRoot, sourceRoot });
  const gate = assertProviderLaunchPrerequisites({
    provider: provider.id,
    config,
    exportRoot: roots.exportRoot,
    sourceRoot: roots.sourceRoot,
    releaseEvidence,
    toolchainCompatibility
  });
  const stage = readStageReport(roots.exportRoot);
  const version = resolveVersion({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const tag = resolveTag({ version: version.version, config });
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

  const providerVerify = runGitRefVerify({
    provider,
    cwd: launchCwd,
    version: version.version,
    tag: tag.tag,
    expectedCommit: stage.stage_commit,
    runner
  });

  const output = {
    ...releasepressEnvelope({ ok: true, type: "releasepress_promote_provider" }),
    provider_id: provider.id,
    kind: provider.kind,
    provider: provider.provider,
    repo: provider.repo,
    ref: provider.ref,
    resolved_ref: `refs/heads/${provider.ref}`,
    review_target: provider.review_target,
    review_target_id: gate.evidence.review_target_id,
    review_commit: gate.evidence.review_commit,
    stage_commit: gate.evidence.stage_commit,
    candidate_fingerprint: gate.evidence.candidate_fingerprint,
    attestation_report: gate.evidence.attestation_report,
    version: version.version,
    tag: tag.tag,
    expected_commit: stage.stage_commit,
    launch_root: provider.launch_root,
    launch_path: provider.launch_path,
    launcher: {
      ...launcher,
      cwd: launchCwdLabel
    },
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

export function providerReportName(providerId) {
  return `provider-${providerId}.json`;
}

function runGitRefVerify({ provider, cwd, version, tag, expectedCommit, runner }) {
  if (provider.verify.kind !== "git_ref") {
    return { ok: true, status: "skipped", reason: "verify_not_configured" };
  }
  const context = {
    version,
    tag,
    branch: provider.ref,
    ref: provider.ref,
    commit: expectedCommit
  };
  const remote = substituteTemplates(provider.verify.remote, context);
  const ref = substituteTemplates(provider.verify.ref, context);
  const argv = ["git", "ls-remote", remote, ref];
  const result = runner(argv[0], argv.slice(1), {
    cwd,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0) {
    throw new ReleasepressError("git_host_verify_failed", "git_host provider verify command failed", {
      provider_id: provider.id,
      argv: redactArgv(argv),
      status,
      stderr: redactTargetValue(String(result.stderr || "").trim())
    });
  }
  const line = String(result.stdout || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  if (!line) {
    throw new ReleasepressError("git_host_verify_ref_missing", "git_host provider verify ref was not found", {
      provider_id: provider.id,
      remote: redactTargetValue(remote),
      ref
    });
  }
  const [sha] = line.split(/\s+/);
  if (sha !== expectedCommit) {
    throw new ReleasepressError("git_host_verify_commit_mismatch", "git_host provider verify ref did not match the staged candidate", {
      provider_id: provider.id,
      remote: redactTargetValue(remote),
      ref,
      expected_commit: expectedCommit,
      actual_commit: sha || null
    });
  }
  return {
    ok: true,
    status: "passed",
    remote: redactTargetValue(remote),
    ref,
    sha
  };
}

function readStageReport(exportRoot) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(exportRoot, REPORT_DIR, "stage-results.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("stage_report_missing", "Provider launch requires a stage report", {
        report: `${REPORT_DIR}/stage-results.json`
      });
    }
    throw error;
  }
  if (report?.type !== "releasepress_stage" || report.ok !== true || !/^[0-9a-f]{40}$/i.test(report.stage_commit ?? "")) {
    throw new ReleasepressError("stage_report_invalid", "Provider launch requires a passing stage report", {
      report: `${REPORT_DIR}/stage-results.json`
    });
  }
  return report;
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
