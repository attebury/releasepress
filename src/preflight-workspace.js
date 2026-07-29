import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCandidateSummary, enumerateCandidateFiles } from "./candidate.js";
import { isInsidePath, ReleasepressError } from "./config.js";
import { copyStableFile } from "./stable-copy.js";

const WORKSPACE_PREFIX = "releasepress-preflight-";
const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_TOTAL_BYTES = 1024 * 1024 * 1024;

export function createPreflightWorkspace({
  candidateRoot,
  expectedSummary,
  tempRoot = os.tmpdir()
}) {
  const sourceRoot = path.resolve(candidateRoot);
  let before;
  let files;
  try {
    before = buildCandidateSummary(sourceRoot);
    files = enumerateCandidateFiles(sourceRoot);
  } catch (error) {
    if (error instanceof ReleasepressError) {
      throw error;
    }
    throw new ReleasepressError(
      "preflight_candidate_unsafe",
      "Candidate could not be inspected safely for isolated preflight"
    );
  }
  assertSummaryMatch(expectedSummary, before, "preflight_candidate_changed");

  if (files.length > MAX_CANDIDATE_FILES) {
    throw new ReleasepressError("preflight_candidate_too_large", "Candidate has too many files for isolated preflight", {
      file_count: files.length,
      max_file_count: MAX_CANDIDATE_FILES
    });
  }

  let parent;
  let root;
  let resolvedTempRoot;
  let parentIdentity;
  try {
    resolvedTempRoot = fs.realpathSync(path.resolve(tempRoot));
    const tempStat = fs.lstatSync(resolvedTempRoot);
    if (tempStat.isSymbolicLink() || !tempStat.isDirectory()) {
      throw new Error("unsafe temporary root");
    }
    parent = fs.mkdtempSync(path.join(resolvedTempRoot, WORKSPACE_PREFIX));
    parentIdentity = fs.lstatSync(parent, { bigint: true });
    root = path.join(parent, "candidate");
    fs.mkdirSync(root, { mode: 0o700 });
  } catch {
    if (parent && resolvedTempRoot && parentIdentity) {
      try {
        removePreflightWorkspace({
          parent,
          root: root ?? path.join(parent, "candidate"),
          tempRoot: resolvedTempRoot,
          parentIdentity: {
            dev: parentIdentity.dev,
            ino: parentIdentity.ino
          }
        });
      } catch {
        throw cleanupError();
      }
    }
    throw new ReleasepressError(
      "preflight_workspace_unavailable",
      "Isolated preflight workspace could not be created safely"
    );
  }

  try {
    let totalBytes = 0;
    for (const rel of files) {
      totalBytes += copyStableCandidateFile({
        sourceRoot,
        destinationRoot: root,
        rel,
        remainingBytes: MAX_CANDIDATE_TOTAL_BYTES - totalBytes
      });
    }

    const sourceAfterCopy = buildCandidateSummary(sourceRoot);
    assertSummaryMatch(expectedSummary, sourceAfterCopy, "preflight_candidate_changed");
    const workspaceSummary = buildCandidateSummary(root);
    assertSummaryMatch(expectedSummary, workspaceSummary, "preflight_workspace_mismatch");

    return {
      parent,
      root,
      tempRoot: resolvedTempRoot,
      parentIdentity: {
        dev: parentIdentity.dev,
        ino: parentIdentity.ino
      },
      summary: workspaceSummary
    };
  } catch (error) {
    const failure = error instanceof ReleasepressError
      ? error
      : new ReleasepressError(
        "preflight_workspace_unavailable",
        "Candidate could not be materialized for isolated preflight"
    );
    try {
      removePreflightWorkspace({
        parent,
        root,
        tempRoot: resolvedTempRoot,
        parentIdentity: {
          dev: parentIdentity.dev,
          ino: parentIdentity.ino
        }
      });
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw failure;
  }
}

export function removePreflightWorkspace(workspace) {
  const parent = path.resolve(workspace?.parent ?? "");
  const root = path.resolve(workspace?.root ?? "");
  const tempRoot = path.resolve(workspace?.tempRoot ?? "");
  if (
    !workspace?.parent
    || !workspace?.root
    || !workspace?.tempRoot
    || typeof workspace?.parentIdentity?.dev !== "bigint"
    || typeof workspace?.parentIdentity?.ino !== "bigint"
    || path.dirname(parent) !== tempRoot
    || !path.basename(parent).startsWith(WORKSPACE_PREFIX)
    || root !== path.join(parent, "candidate")
    || !isInsidePath(tempRoot, parent)
  ) {
    throw cleanupError();
  }

  let stat;
  try {
    const resolvedTempRoot = fs.realpathSync(tempRoot);
    const tempStat = fs.lstatSync(resolvedTempRoot);
    if (
      resolvedTempRoot !== tempRoot
      || tempStat.isSymbolicLink()
      || !tempStat.isDirectory()
    ) {
      throw cleanupError();
    }
    stat = fs.lstatSync(parent, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw cleanupError();
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== workspace.parentIdentity.dev
    || stat.ino !== workspace.parentIdentity.ino
  ) {
    throw cleanupError();
  }

  try {
    fs.rmSync(parent, { recursive: true, force: false });
  } catch {
    throw cleanupError();
  }
  if (fs.existsSync(parent)) {
    throw cleanupError();
  }
}

function copyStableCandidateFile({
  sourceRoot,
  destinationRoot,
  rel,
  remainingBytes
}) {
  return copyStableFile({
    sourceRoot,
    destinationRoot,
    rel,
    remainingBytes,
    maxFileBytes: MAX_CANDIDATE_FILE_BYTES,
    codes: {
      unsafe: "preflight_candidate_unsafe",
      escape: "preflight_workspace_path_escape",
      tooLarge: "preflight_candidate_too_large",
      changed: "preflight_candidate_changed",
      write: "preflight_workspace_unavailable",
      noFollow: "preflight_workspace_unavailable"
    }
  });
}

function assertSummaryMatch(expected, actual, code) {
  if (
    !expected
    || expected.fingerprint !== actual.fingerprint
    || expected.file_count !== actual.file_count
  ) {
    throw new ReleasepressError(code, "Preflight candidate binding changed");
  }
}

function cleanupError() {
  return new ReleasepressError(
    "preflight_workspace_cleanup_failed",
    "Isolated preflight workspace could not be removed safely"
  );
}
