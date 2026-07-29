import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ReleasepressError } from "./config.js";
import { resolvePromoteRoots } from "./promote-roots.js";

const PRECHECK_TIMEOUT_MS = 10 * 60 * 1000;
const PRECHECK_MAX_BUFFER = 1024 * 1024;

export function runProviderPreflight({
  config,
  releaseIdentity,
  exportRoot,
  sourceRoot = process.cwd(),
  runner = spawnSync
}) {
  const roots = resolvePromoteRoots({ exportRoot, sourceRoot });
  
  // Read stage report to get stage_commit
  let stageCommit = null;
  try {
    const stageReportPath = path.join(roots.exportRoot, ".releasepress-report", "stage-results.json");
    const stageReport = JSON.parse(fs.readFileSync(stageReportPath, "utf8"));
    stageCommit = stageReport.stage_commit;
  } catch (err) {
    // Stage commit not ready yet
  }

  // Read attestation / review report if available
  let reviewCommit = null;
  try {
    const reviewReportPath = path.join(roots.exportRoot, ".releasepress-report", "public-review-attestation.json");
    const reviewReport = JSON.parse(fs.readFileSync(reviewReportPath, "utf8"));
    reviewCommit = reviewReport.review_commit ?? reviewReport.reviewed_commit ?? null;
  } catch (err) {
    // Review commit not attested yet
  }

  const providers = config.delivery?.providers ?? [];
  const results = [];

  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }

    const check = {
      provider_id: provider.id,
      kind: provider.kind,
      ok: true,
      blocker: null,
      warning: null,
      details: {}
    };

    try {
      if (provider.preflight?.enabled && provider.preflight.command_argv?.length > 0) {
        const res = runCustomPreflightCheck({
          preflight: provider.preflight,
          releaseIdentity,
          runner,
          cwd: roots.sourceRoot,
          timeoutMs: PRECHECK_TIMEOUT_MS,
          maxBuffer: PRECHECK_MAX_BUFFER
        });

        if (res.status === "failed") {
          check.ok = false;
          check.blocker = res.blocker;
          check.details.reason = res.reason;
        }
      }

      if (provider.kind === "package_registry") {
        if (provider.provider === "npm" && provider.version_policy === "must-not-exist") {
          const res = checkNpmVersionPreflight({
            packageName: releaseIdentity.packageName,
            version: releaseIdentity.version,
            runner,
            cwd: roots.sourceRoot
          });

          if (res.status === "blocked") {
            check.ok = false;
            check.blocker = res.blocker;
            check.details.reason = res.reason;
          } else if (res.status === "failed") {
            check.ok = false;
            check.blocker = res.blocker;
            check.details.reason = res.reason;
          }
        }
      } else if (provider.kind === "git_host") {
        const tagConfig = provider.tag ?? {};
        if (tagConfig.enabled === true) {
          const expectedCommit = reviewCommit || stageCommit;
          const tagName = tagConfig.name 
            ? tagConfig.name.replace("{version}", releaseIdentity.version)
            : releaseIdentity.tagName;

          if (!provider.repo) {
            throw new ReleasepressError("delivery_provider_invalid", "git_host provider requires repo", {
              provider_id: provider.id
            });
          }

          const res = checkGitTagPreflight({
            repo: provider.repo,
            tagName,
            runner,
            cwd: roots.sourceRoot,
            timeoutMs: PRECHECK_TIMEOUT_MS,
            maxBuffer: PRECHECK_MAX_BUFFER
          });

          if (res.status === "failed") {
            check.ok = false;
            check.blocker = res.blocker;
            check.details.reason = res.reason;
          } else if (res.status === "success") {
            check.details.tag_exists = res.exists;
            check.details.tag_commit = res.commit;

            if (res.exists) {
              if (expectedCommit && res.commit !== expectedCommit) {
                if (tagConfig.allow_retarget !== true) {
                  check.ok = false;
                  check.blocker = "git_tag_target_mismatch";
                  check.details.reason = `Git tag ${tagName} exists at different commit ${res.commit} (expected ${expectedCommit})`;
                }
              }
            } else {
              if (tagConfig.policy === "require-existing") {
                check.ok = false;
                check.blocker = "git_tag_missing";
                check.details.reason = `Required Git tag ${tagName} is missing from remote ${provider.repo}`;
              }
            }
          }
        }
      }
    } catch (error) {
      check.ok = false;
      check.blocker = "preflight_check_error";
      check.details.reason = error.message;
    }

    results.push(check);
  }

  return {
    ok: results.every((r) => r.ok),
    checked_at: new Date().toISOString(),
    results
  };
}

function runCustomPreflightCheck({ preflight, releaseIdentity, runner, cwd, timeoutMs = PRECHECK_TIMEOUT_MS, maxBuffer = PRECHECK_MAX_BUFFER }) {
  const args = preflight.command_argv.map((arg) => {
    let replaced = arg;
    if (releaseIdentity) {
      replaced = replaced
        .replaceAll("{version}", releaseIdentity.version)
        .replaceAll("{packageName}", releaseIdentity.packageName)
        .replaceAll("{tagName}", releaseIdentity.tagName);
    }
    return replaced;
  });

  const [cmd, ...cmdArgs] = args;
  const result = runner(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer
  });
  if (result.error?.code === "ETIMEDOUT") {
    return {
      status: "failed",
      blocker: "preflight_command_timeout",
      reason: `Verification command '${args.join(" ")}' timed out after ${timeoutMs}ms`
    };
  }

  if (result.status !== 0) {
    return {
      status: "failed",
      blocker: "preflight_verification_failed",
      reason: `Verification command '${args.join(" ")}' failed with exit code ${result.status}: ${String(result.stderr || "").trim()}`
    };
  }

  const stdout = String(result.stdout || "").trim();
  const expect = preflight.expect ?? {};
  for (const [key, value] of Object.entries(expect)) {
    if (key === "stdout_contains" && !stdout.includes(value)) {
      return {
        status: "failed",
        blocker: "preflight_verification_failed",
        reason: `Verification expected stdout to contain '${value}', but got: ${stdout}`
      };
    }
  }

  return {
    status: "success"
  };
}

function checkNpmVersionPreflight({
  packageName,
  version,
  runner,
  cwd,
  timeoutMs = PRECHECK_TIMEOUT_MS,
  maxBuffer = PRECHECK_MAX_BUFFER
}) {
  const result = runner("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer
  });
  if (result.error?.code === "ETIMEDOUT") {
    return {
      status: "failed",
      blocker: "preflight_command_timeout",
      reason: `NPM preflight check timed out after ${timeoutMs}ms`
    };
  }

  const stdout = String(result.stdout || "").trim();
  if (result.status === 0 && stdout !== "") {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed === version || (Array.isArray(parsed) && parsed.includes(version)) || parsed.version === version) {
        return {
          status: "blocked",
          blocker: "npm_version_already_published",
          reason: `Version ${version} is already published to the registry`
        };
      }
    } catch (e) {
      if (stdout.includes(version)) {
        return {
          status: "blocked",
          blocker: "npm_version_already_published",
          reason: `Version ${version} is already published to the registry`
        };
      }
    }
  }

  const stderr = String(result.stderr || "").trim();
  if (result.status !== 0 && !stderr.includes("E404") && !stderr.includes("404")) {
    return {
      status: "failed",
      blocker: "npm_registry_unavailable",
      reason: `NPM registry check failed: ${stderr}`
    };
  }

  return {
    status: "success",
    exists: false
  };
}

function checkGitTagPreflight({
  repo,
  tagName,
  runner,
  cwd,
  timeoutMs = PRECHECK_TIMEOUT_MS,
  maxBuffer = PRECHECK_MAX_BUFFER
}) {
  const result = runner("git", ["ls-remote", "--tags", repo, tagName], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer
  });
  if (result.error?.code === "ETIMEDOUT") {
    return {
      status: "failed",
      blocker: "preflight_command_timeout",
      reason: `Git tag preflight check timed out after ${timeoutMs}ms`
    };
  }

  if (result.status !== 0) {
    return {
      status: "failed",
      blocker: "git_remote_unavailable",
      reason: `Git remote check failed: ${String(result.stderr || "").trim()}`
    };
  }

  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return {
      status: "success",
      exists: false,
      commit: null
    };
  }

  let tagCommit = null;
  let peeledCommit = null;

  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    if (ref === `refs/tags/${tagName}`) {
      tagCommit = sha;
    } else if (ref === `refs/tags/${tagName}^{}`) {
      peeledCommit = sha;
    }
  }

  const resolvedCommit = peeledCommit || tagCommit;

  return {
    status: "success",
    exists: true,
    commit: resolvedCommit
  };
}
