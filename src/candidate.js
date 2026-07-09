import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReleasepressError, toPosixPath } from "./config.js";

const IGNORED_ROOTS = new Set([".git", ".releasepress-report"]);

export function buildCandidateSummary(root) {
  const resolved = path.resolve(root);
  assertDirectory(resolved);
  const files = enumerateCandidateFiles(resolved);
  const hash = crypto.createHash("sha256");
  hash.update("releasepress-candidate-tree-v1\0");
  for (const file of files) {
    const absolute = path.join(resolved, file);
    const contentHash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    const stat = fs.lstatSync(absolute);
    hash.update(`${file}\0${stat.size}\0${contentHash}\0`);
  }
  return {
    fingerprint: `sha256:${hash.digest("hex")}`,
    file_count: files.length
  };
}

export function readSourceCommit(root) {
  try {
    const value = fs.readFileSync(path.join(root, ".releasepress-report", "source-commit.txt"), "utf8").trim();
    return value || "unknown";
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "unknown";
    }
    throw error;
  }
}

function enumerateCandidateFiles(root) {
  const files = [];

  function walk(dir) {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      const rel = toPosixPath(path.relative(root, absolute));
      const firstSegment = rel.split("/")[0];
      if (IGNORED_ROOTS.has(firstSegment)) {
        continue;
      }
      if (dirent.isSymbolicLink()) {
        throw new ReleasepressError("candidate_symlink_selected", "Candidate tree must not contain symlinks", {
          path: rel
        });
      }
      if (dirent.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (dirent.isFile()) {
        files.push(rel);
      }
    }
  }

  walk(root);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function assertDirectory(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", "Candidate path does not exist", { path: root });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Candidate path must not be a symlink", { path: root });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", "Candidate path must be a directory", { path: root });
  }
}
