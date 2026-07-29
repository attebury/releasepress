import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withBoundedNpmCacheEnv } from "./npm-env.js";
import { isInsidePath, ReleasepressError } from "./config.js";

export function resolvePromoteRoots({ exportRoot, sourceRoot }) {
  if (!exportRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
  const roots = {
    exportRoot: path.resolve(exportRoot),
    sourceRoot: path.resolve(sourceRoot)
  };
  assertDirectory(roots.exportRoot, "export");
  assertDirectory(roots.sourceRoot, "source");
  return roots;
}

export function resolveLaunchCwd({ roots, launchRoot, launchPath = "." }) {
  const root = launchRoot === "export" ? roots.exportRoot : roots.sourceRoot;
  const cwd = path.resolve(root, launchPath);
  if (!isInsidePath(root, cwd)) {
    throw new ReleasepressError("launch_path_escape", "Launcher path escaped the selected root", {
      launch_root: launchRoot,
      launch_path: launchPath
    });
  }
  assertDirectory(cwd, "launch");
  const realRoot = fs.realpathSync(root);
  const realCwd = fs.realpathSync(cwd);
  if (!isInsidePath(realRoot, realCwd)) {
    throw new ReleasepressError("launch_path_escape", "Launcher path escaped the selected root", {
      launch_root: launchRoot,
      launch_path: launchPath
    });
  }
  return cwd;
}

export function launcherEnv({ exportRoot, sourceRoot }) {
  return {
    ...withBoundedNpmCacheEnv(process.env),
    RELEASEPRESS_EXPORT_ROOT: exportRoot,
    RELEASEPRESS_SOURCE_ROOT: sourceRoot
  };
}

export function withReportBundlePreserved(exportRoot, run) {
  const reportDir = path.join(exportRoot, ".releasepress-report");
  let backupDir = null;
  if (fs.existsSync(reportDir)) {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "releasepress-report-backup-"));
    fs.cpSync(reportDir, path.join(backupDir, ".releasepress-report"), { recursive: true });
  }

  try {
    return run();
  } finally {
    if (backupDir) {
      fs.mkdirSync(path.dirname(reportDir), { recursive: true });
      fs.cpSync(path.join(backupDir, ".releasepress-report"), reportDir, { recursive: true });
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

function assertDirectory(root, purpose) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", `${purpose} path does not exist`, { path: root });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `${purpose} path must not be a symlink`, { path: root });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `${purpose} path must be a directory`, { path: root });
  }
}
