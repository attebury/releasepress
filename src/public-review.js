import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertPublicReviewPrerequisites } from "./checklist.js";
import { buildCandidateSummary } from "./candidate.js";
import { ReleasepressError } from "./config.js";
import {
  normalizeBranchRef,
  prepareLocalBareRepo,
  redactTargetValue
} from "./target.js";

const REPORT_DIR = ".releasepress-report";
const REPORT_NAME = "public-review-results.json";
const REMOTE_NAME = "public-review";

export function publishPublicReview({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  runner = spawnSync
}) {
  assertPublicReviewConfig(config);
  const root = resolveExportRoot(exportRoot);
  assertPublicReviewPrerequisites({ config, exportRoot: root, sourceRoot });
  const stage = readStageReport(root);
  const candidate = buildCandidateSummary(root);
  if (stage.candidate_fingerprint && stage.candidate_fingerprint !== candidate.fingerprint) {
    throw new ReleasepressError("public_review_candidate_mismatch", "Public review candidate fingerprint does not match stage report", {
      stage_candidate_fingerprint: stage.candidate_fingerprint,
      candidate_fingerprint: candidate.fingerprint
    });
  }
  assertNoPublicTreeChanges({ root, runner });

  const reviewCommit = readGitHead(root, runner);
  if (reviewCommit !== stage.stage_commit) {
    throw new ReleasepressError("public_review_candidate_mismatch", "Public review must publish the staged candidate commit", {
      stage_commit: stage.stage_commit,
      review_commit: reviewCommit
    });
  }

  const remote = prepareLocalBareRepo(config.public_review.repo, runGitWithRunner(runner));
  ensureRemote({ root, remote, runner });
  const publication = publishReviewRef({
    root,
    review: config.public_review,
    reviewCommit,
    runner
  });

  const output = {
    ok: true,
    type: "releasepress_public_review",
    export_root: root,
    review_target_id: config.public_review.id ?? null,
    target: {
      id: config.public_review.id ?? null,
      kind: config.public_review.kind ?? "git_ref",
      repo: config.public_review.repo,
      visibility: config.public_review.visibility,
      strategy: config.public_review.strategy,
      ref: publication.ref,
      resolved_ref: publication.resolvedRef
    },
    repo: config.public_review.repo,
    visibility: config.public_review.visibility,
    strategy: config.public_review.strategy,
    ref: publication.ref,
    resolved_ref: publication.resolvedRef,
    review_commit: reviewCommit,
    stage_commit: stage.stage_commit,
    source_commit: stage.source_commit ?? readSourceCommit(root),
    candidate_fingerprint: candidate.fingerprint,
    candidate_file_count: candidate.file_count,
    previous_commit: publication.previousCommit,
    replaced: publication.replaced,
    pushed: true
  };
  writeJson(path.join(root, REPORT_DIR, REPORT_NAME), output);
  return output;
}

export function readPublicReviewReport(root) {
  return readJson(path.join(root, REPORT_DIR, REPORT_NAME), "public_review_report_missing");
}

function assertPublicReviewConfig(config) {
  if (!config?.public_review?.repo) {
    throw new ReleasepressError("missing_public_review_repo", "public_review.repo is required");
  }
}

function publishReviewRef({ root, review, reviewCommit, runner }) {
  const ref = review.ref;
  const resolvedRef = normalizeBranchRef(ref);

  if (review.strategy === "fast-forward-only") {
    pushReviewRef({
      root,
      argv: ["push", REMOTE_NAME, `HEAD:${resolvedRef}`],
      strategy: review.strategy,
      ref,
      resolvedRef,
      runner
    });
    return {
      ref,
      resolvedRef,
      previousCommit: null,
      replaced: false
    };
  }

  if (review.strategy === "replace-ref") {
    const previousCommit = readRemoteRef({ root, resolvedRef, runner });
    const argv = previousCommit
      ? ["push", `--force-with-lease=${resolvedRef}:${previousCommit}`, REMOTE_NAME, `HEAD:${resolvedRef}`]
      : ["push", REMOTE_NAME, `HEAD:${resolvedRef}`];
    pushReviewRef({
      root,
      argv,
      strategy: review.strategy,
      ref,
      resolvedRef,
      runner
    });
    return {
      ref,
      resolvedRef,
      previousCommit,
      replaced: previousCommit !== null
    };
  }

  throw new ReleasepressError("invalid_config", "Unknown public review strategy", {
    strategy: review.strategy,
    review_commit: reviewCommit
  });
}

function pushReviewRef({ root, argv, strategy, ref, resolvedRef, runner }) {
  try {
    runGit(argv, root, { runner });
  } catch (error) {
    if (error instanceof ReleasepressError && error.code === "git_command_failed") {
      const gitOutput = `${error.details.stderr ?? ""}\n${error.details.stdout ?? ""}`;
      if (strategy === "fast-forward-only" && isNonFastForward(gitOutput)) {
        throw new ReleasepressError("public_review_non_fast_forward", "Public review ref update was rejected as non-fast-forward", {
          strategy,
          ref,
          resolved_ref: resolvedRef,
          remediation: "Use public_review.strategy replace-ref for repeatable private/public review refs."
        });
      }
      throw new ReleasepressError("public_review_publish_failed", "Public review ref update failed", {
        strategy,
        ref,
        resolved_ref: resolvedRef,
        status: error.details.status,
        stderr: redactTargetValue(error.details.stderr),
        stdout: redactTargetValue(error.details.stdout)
      });
    }
    throw error;
  }
}

function ensureRemote({ root, remote, runner }) {
  const getRemote = runGit(["remote", "get-url", REMOTE_NAME], root, { runner, allowFailure: true });
  if (getRemote.status === 0) {
    runGit(["remote", "set-url", REMOTE_NAME, remote], root, { runner });
  } else {
    runGit(["remote", "add", REMOTE_NAME, remote], root, { runner });
  }
}

function readRemoteRef({ root, resolvedRef, runner }) {
  const result = runGit(["ls-remote", REMOTE_NAME, resolvedRef], root, { runner, allowFailure: true });
  if (result.status !== 0) {
    throw new ReleasepressError("public_review_publish_failed", "Could not read public review remote ref", {
      resolved_ref: resolvedRef,
      status: result.status,
      stderr: redactTargetValue(result.stderr)
    });
  }
  const line = String(result.stdout || "").trim().split(/\r?\n/).find(Boolean);
  if (!line) {
    return null;
  }
  const [sha] = line.split(/\s+/);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ReleasepressError("public_review_publish_failed", "Public review remote returned an invalid ref value", {
      resolved_ref: resolvedRef
    });
  }
  return sha;
}

function assertNoPublicTreeChanges({ root, runner }) {
  const status = runGit(["status", "--porcelain=v1", "-z"], root, { runner });
  const changedPublicFiles = parseStatusPaths(String(status.stdout || "")).filter((file) => !isReportPath(file));
  if (changedPublicFiles.length > 0) {
    throw new ReleasepressError("public_review_export_tree_dirty", "Public review requires a clean public export tree", {
      paths: changedPublicFiles
    });
  }
}

function readGitHead(root, runner) {
  return runGit(["rev-parse", "HEAD"], root, { runner }).stdout.trim();
}

function readStageReport(root) {
  const report = readJson(path.join(root, REPORT_DIR, "stage-results.json"), "stage_report_missing");
  if (report?.type !== "releasepress_stage" || report.ok !== true || !/^[0-9a-f]{40}$/i.test(report.stage_commit ?? "")) {
    throw new ReleasepressError("stage_report_invalid", "Public review requires a valid stage-results.json report");
  }
  return report;
}

function readSourceCommit(root) {
  try {
    const value = fs.readFileSync(path.join(root, REPORT_DIR, "source-commit.txt"), "utf8").trim();
    return value || "unknown";
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "unknown";
    }
    throw error;
  }
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
      throw new ReleasepressError("missing_path", "Public review export path does not exist", { path: exportRoot });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Public review export path must not be a symlink", { path: exportRoot });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", "Public review export path must be a directory", { path: exportRoot });
  }
  return root;
}

function runGitWithRunner(runner) {
  return (argv, cwd) => runGit(argv, cwd, { runner });
}

function runGit(argv, cwd, { runner = spawnSync, allowFailure = false } = {}) {
  const result = runner("git", argv, {
    cwd,
    encoding: "utf8",
    shell: false
  });
  const status = typeof result.status === "number" ? result.status : result.error ? 1 : 0;
  if (status !== 0 && !allowFailure) {
    throw new ReleasepressError("git_command_failed", "A git command failed", {
      argv: ["git", ...argv].map((arg) => redactTargetValue(arg)),
      status,
      stderr: String(result.stderr || "").trim(),
      stdout: String(result.stdout || "").trim()
    });
  }
  return {
    status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
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

function isNonFastForward(stderr) {
  return /non-fast-forward|fetch first|rejected/i.test(stderr ?? "");
}

function parseStatusPaths(stdout) {
  const records = stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) {
      continue;
    }
    const code = record.slice(0, 2);
    const file = record.slice(3);
    paths.push(file);
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
      if (records[index]) {
        paths.push(records[index]);
      }
    }
  }
  return paths;
}

function isReportPath(file) {
  return file === REPORT_DIR || file.startsWith(`${REPORT_DIR}/`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
