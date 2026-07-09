import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isInsidePath,
  matchesAny,
  matchesPattern,
  ReleasepressError,
  toPosixPath
} from "./config.js";
import { buildCandidateSummary, readSourceCommit as readReportedSourceCommit } from "./candidate.js";
import { scanPath } from "./scan.js";
import { resolveTag, resolveVersion } from "./release-meta.js";

const BUILT_IN_EXCLUDE = [".git", ".git/**", ".releasepress-report", ".releasepress-report/**"];

export function enumerateSourceEntries(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const entries = [];

  function walk(dir) {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      const rel = toPosixPath(path.relative(root, absolute));

      if (rel === ".git" || rel.startsWith(".git/")) {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        entries.push({ path: rel, absolute, type: "symlink" });
        continue;
      }

      if (dirent.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (dirent.isFile()) {
        entries.push({ path: rel, absolute, type: "file" });
      }
    }
  }

  walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export function selectPublicFiles(entries, config) {
  const publicFiles = [];
  const excludedFiles = [];

  for (const entry of entries) {
    const includePattern = config.include.find((pattern) => matchesPattern(entry.path, pattern));
    if (!includePattern) {
      excludedFiles.push({ path: entry.path, reason: "not_allowlisted" });
      continue;
    }

    const builtInPattern = BUILT_IN_EXCLUDE.find((pattern) => matchesPattern(entry.path, pattern));
    if (builtInPattern) {
      excludedFiles.push({
        path: entry.path,
        reason: "built_in_backstop",
        pattern: builtInPattern
      });
      continue;
    }

    const disallowedPattern = config.defaults.expanded_disallowed_patterns.find(({ pattern }) =>
      matchesPattern(entry.path, pattern)
    );
    if (disallowedPattern) {
      excludedFiles.push({
        path: entry.path,
        reason: "disallowed_profile_backstop",
        pattern: disallowedPattern.pattern,
        source: disallowedPattern.source
      });
      continue;
    }

    const excludePattern = config.exclude.find((pattern) => matchesPattern(entry.path, pattern));
    if (excludePattern) {
      excludedFiles.push({
        path: entry.path,
        reason: "exclude_backstop",
        pattern: excludePattern
      });
      continue;
    }

    if (entry.type === "symlink") {
      throw new ReleasepressError("symlink_selected", "Selected export path is a symlink", {
        path: entry.path,
        include_pattern: includePattern
      });
    }

    publicFiles.push(entry.path);
  }

  return {
    publicFiles,
    excludedFiles
  };
}

export function createExport({ sourceRoot = process.cwd(), outDir, config }) {
  if (!outDir) {
    throw new ReleasepressError("missing_out", "--out is required");
  }

  const root = path.resolve(sourceRoot);
  const out = path.resolve(outDir);
  if (isInsidePath(root, out)) {
    throw new ReleasepressError("out_inside_source", "Export output must not be inside the source repo", {
      out: outDir
    });
  }

  const entries = enumerateSourceEntries(root);
  const selection = selectPublicFiles(entries, config);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  for (const rel of selection.publicFiles) {
    const from = path.join(root, rel);
    const to = path.join(out, rel);
    if (!isInsidePath(out, path.resolve(to))) {
      throw new ReleasepressError("copy_path_escape", "Export destination escaped output root", { path: rel });
    }

    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw new ReleasepressError("symlink_selected", "Selected export path is a symlink", { path: rel });
    }
    if (!stat.isFile()) {
      throw new ReleasepressError("not_regular_file", "Selected export path is not a regular file", { path: rel });
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  const reportDir = path.join(out, ".releasepress-report");
  fs.mkdirSync(reportDir, { recursive: true });
  const sourceState = getSourceState(root);
  const candidate = buildCandidateSummary(out);
  fs.writeFileSync(path.join(reportDir, "source-commit.txt"), `${sourceState.commit}\n`);
  writeJson(path.join(reportDir, "source-state.json"), sourceState);
  writeJson(path.join(reportDir, "candidate-fingerprint.json"), {
    ok: true,
    type: "releasepress_candidate_fingerprint",
    ...candidate
  });
  writeJson(path.join(reportDir, "public-files.json"), selection.publicFiles);
  writeJson(path.join(reportDir, "excluded-files.json"), selection.excludedFiles);
  writeJson(path.join(reportDir, "disallowed-patterns.json"), config.defaults.expanded_disallowed_patterns);

  return {
    ok: true,
    type: "releasepress_export",
    source_root: root,
    out,
    source_commit: sourceState.commit,
    source_dirty: sourceState.dirty,
    candidate_fingerprint: candidate.fingerprint,
    candidate_file_count: candidate.file_count,
    public_files: selection.publicFiles,
    excluded_files: selection.excludedFiles,
    disallowed_patterns: config.defaults.expanded_disallowed_patterns,
    report_dir: reportDir
  };
}

export function stageExport({ exportRoot, config }) {
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
  if (!config.stage_repo) {
    throw new ReleasepressError("missing_stage_repo", "stage_repo is required to stage an export");
  }
  if (stageRepoHasCredentials(config.stage_repo)) {
    throw new ReleasepressError(
      "stage_repo_credentials_unsupported",
      "stage_repo must not contain embedded credentials"
    );
  }
  if (!isPrivateStageRepo(config.stage_repo)) {
    throw new ReleasepressError("stage_repo_not_private", "stage_repo must be local or localhost in v1", {
      stage_repo: config.stage_repo
    });
  }

  const root = path.resolve(exportRoot);
  const scan = scanPath({ root, config });
  if (!scan.ok) {
    throw new ReleasepressError("stage_scan_failed", "Export scan must pass before staging", {
      findings: scan.findings.length
    });
  }

  const remote = prepareStageRemote(config.stage_repo);
  const candidate = buildCandidateSummary(root);
  prepareExportGitRepo(root);
  const commit = createStageCommit(root);
  const stageCommit = readGitHead(root);
  try {
    const version = resolveVersion({ config, exportRoot: root, sourceRoot: process.cwd() });
    const tag = resolveTag({ version: version.version, config });
    if (tag.tag) {
      runGit(["tag", "-f", "-a", tag.tag, "-m", `releasepress tag ${tag.tag}`], root, { allowFailure: true });
    }
  } catch (error) {
    // Ignore version/tag resolution errors on incomplete config
  }
  ensureStageRemote({ root, remote });
  const publication = publishStageRef({
    root,
    stage: config.stage,
    stageCommit
  });

  const output = {
    ok: true,
    type: "releasepress_stage",
    export_root: root,
    target_id: config.stage.id,
    stage_repo: config.stage_repo,
    target: {
      id: config.stage.id,
      kind: "git_ref",
      repo: config.stage_repo,
      visibility: "local",
      strategy: publication.strategy,
      ref: publication.ref,
      resolved_ref: publication.resolvedRef
    },
    strategy: publication.strategy,
    ref: publication.ref,
    resolved_ref: publication.resolvedRef,
    stage_commit: stageCommit,
    source_commit: readSourceCommit(root),
    candidate_fingerprint: candidate.fingerprint,
    candidate_file_count: candidate.file_count,
    previous_commit: publication.previousCommit,
    replaced: publication.replaced,
    committed: commit.status === 0,
    scan
  };
  writeJson(path.join(root, ".releasepress-report", "stage-results.json"), output);
  return output;
}

function prepareExportGitRepo(root) {
  runGit(["init", "-b", "main"], root, { allowFailure: fs.existsSync(path.join(root, ".git")) });
  const excludePath = path.join(root, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, "\n.releasepress-report\n");
  runGit(["add", "-A"], root);
}

function createStageCommit(root) {
  return runGit(
    [
      "-c",
      "user.email=stage@releasepress.local",
      "-c",
      "user.name=releasepress-stage",
      "commit",
      "-m",
      "releasepress public stage"
    ],
    root,
    { allowFailure: true }
  );
}

function ensureStageRemote({ root, remote }) {
  const getRemote = runGit(["remote", "get-url", "stage"], root, { allowFailure: true });
  if (getRemote.status === 0) {
    runGit(["remote", "set-url", "stage", remote], root);
  } else {
    runGit(["remote", "add", "stage", remote], root);
  }
}

function publishStageRef({ root, stage, stageCommit }) {
  const strategy = stage?.strategy ?? "fast-forward-only";
  const configuredRef = stage?.ref ?? "main";
  const refPrefix = stage?.ref_prefix ?? "releasepress";
  const ref = strategy === "unique-ref" ? `${refPrefix}/${stageCommit}` : configuredRef;
  const resolvedRef = `refs/heads/${ref}`;

  if (strategy === "fast-forward-only") {
    pushStageRef({
      root,
      argv: ["push", "stage", `HEAD:${resolvedRef}`],
      strategy,
      ref,
      resolvedRef
    });
    return {
      strategy,
      ref,
      resolvedRef,
      previousCommit: null,
      replaced: false
    };
  }

  if (strategy === "replace-main") {
    const previousCommit = readRemoteRef({ root, resolvedRef });
    const argv = previousCommit
      ? ["push", `--force-with-lease=${resolvedRef}:${previousCommit}`, "stage", `HEAD:${resolvedRef}`]
      : ["push", "stage", `HEAD:${resolvedRef}`];
    pushStageRef({
      root,
      argv,
      strategy,
      ref,
      resolvedRef
    });
    return {
      strategy,
      ref,
      resolvedRef,
      previousCommit,
      replaced: previousCommit !== null
    };
  }

  if (strategy === "unique-ref") {
    pushStageRef({
      root,
      argv: ["push", "stage", `HEAD:${resolvedRef}`],
      strategy,
      ref,
      resolvedRef
    });
    return {
      strategy,
      ref,
      resolvedRef,
      previousCommit: null,
      replaced: false
    };
  }

  throw new ReleasepressError("invalid_config", "Unknown stage strategy", { strategy });
}

function readRemoteRef({ root, resolvedRef }) {
  const result = runGit(["ls-remote", "stage", resolvedRef], root, { allowFailure: true });
  if (result.status !== 0) {
    throw new ReleasepressError("stage_publish_failed", "Could not read stage remote ref", {
      resolved_ref: resolvedRef,
      status: result.status,
      stderr: redactGitOutput(result.stderr)
    });
  }

  const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
  if (!line) {
    return null;
  }

  const [sha] = line.split(/\s+/);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ReleasepressError("stage_publish_failed", "Stage remote returned an invalid ref value", {
      resolved_ref: resolvedRef
    });
  }
  return sha;
}

function pushStageRef({ root, argv, strategy, ref, resolvedRef }) {
  try {
    runGit(argv, root);
  } catch (error) {
    if (error instanceof ReleasepressError && error.code === "git_command_failed") {
      const gitOutput = `${error.details.stderr ?? ""}\n${error.details.stdout ?? ""}`;
      if (strategy === "fast-forward-only" && isNonFastForward(gitOutput)) {
        throw new ReleasepressError("stage_non_fast_forward", "Stage ref update was rejected as non-fast-forward", {
          strategy,
          ref,
          resolved_ref: resolvedRef,
          remediation: "Use stage.strategy replace-main for repeatable private staging, or unique-ref for per-export review refs."
        });
      }
      throw new ReleasepressError("stage_publish_failed", "Stage ref update failed", {
        strategy,
        ref,
        resolved_ref: resolvedRef,
        status: error.details.status,
        stderr: redactGitOutput(error.details.stderr),
        stdout: redactGitOutput(error.details.stdout)
      });
    }
    throw error;
  }
}

function isNonFastForward(stderr) {
  return /non-fast-forward|fetch first|rejected/i.test(stderr ?? "");
}

function readGitHead(root) {
  return runGit(["rev-parse", "HEAD"], root).stdout.trim();
}

function readSourceCommit(root) {
  return readReportedSourceCommit(root);
}

function redactGitOutput(text) {
  return String(text ?? "")
    .replace(/(https?:\/\/)([^/@\s]+)@/g, "$1[redacted]@")
    .trim();
}

function prepareStageRemote(stageRepo) {
  if (isLocalPathRepo(stageRepo)) {
    const resolved = path.resolve(stageRepo);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      runGit(["init", "--bare", resolved], process.cwd());
    } else if (!fs.existsSync(path.join(resolved, "HEAD"))) {
      runGit(["init", "--bare", resolved], process.cwd());
    }
    return resolved;
  }

  if (stageRepo.startsWith("file://")) {
    const url = new URL(stageRepo);
    const resolved = url.pathname;
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      runGit(["init", "--bare", resolved], process.cwd());
    } else if (!fs.existsSync(path.join(resolved, "HEAD"))) {
      runGit(["init", "--bare", resolved], process.cwd());
    }
  }

  return stageRepo;
}

function isPrivateStageRepo(stageRepo) {
  if (isLocalPathRepo(stageRepo) || stageRepo.startsWith("file://")) {
    return true;
  }

  try {
    const url = new URL(stageRepo);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isLocalPathRepo(stageRepo) {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(stageRepo) && !stageRepo.includes("@");
}

function stageRepoHasCredentials(stageRepo) {
  if (isLocalPathRepo(stageRepo)) {
    return false;
  }
  try {
    const url = new URL(stageRepo);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

function getSourceState(root) {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  if (commit.status !== 0) {
    return {
      commit: "unknown",
      dirty: null
    };
  }

  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });

  return {
    commit: commit.stdout.trim(),
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}

function runGit(argv, cwd, options = {}) {
  const result = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new ReleasepressError("git_command_failed", "A git command failed", {
      argv: redactGitArgv(["git", ...argv]),
      status: result.status,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim()
    });
  }
  return result;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function redactGitArgv(argv) {
  return argv.map((arg) => redactGitOutput(arg));
}

export function pathMatchesAny(relPath, patterns) {
  return matchesAny(relPath, patterns);
}
