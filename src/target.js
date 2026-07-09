import path from "node:path";
import fs from "node:fs";

export const TARGET_VISIBILITIES = ["local", "private-remote", "public-remote", "registry"];

export function normalizeBranchRef(ref) {
  return `refs/heads/${ref}`;
}

export function isLocalishRepo(repo) {
  if (isLocalPathRepo(repo) || String(repo).startsWith("file://")) {
    return true;
  }
  try {
    const url = new URL(repo);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isLocalPathRepo(repo) {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(String(repo)) && !String(repo).includes("@");
}

export function repoHasEmbeddedCredentials(repo) {
  if (isLocalPathRepo(repo)) {
    return false;
  }
  try {
    const url = new URL(repo);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

export function repoIsProbablyExplicitRemote(repo) {
  const value = String(repo ?? "");
  if (isLocalPathRepo(value) || value.startsWith("file://")) {
    return true;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return true;
  }
  return /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:.+/.test(value);
}

export function prepareLocalBareRepo(repo, runGit) {
  if (isLocalPathRepo(repo)) {
    const resolved = path.resolve(repo);
    ensureBareRepo(resolved, runGit);
    return resolved;
  }

  if (String(repo).startsWith("file://")) {
    const url = new URL(repo);
    ensureBareRepo(url.pathname, runGit);
  }

  return repo;
}

export function redactTargetValue(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/)([^/@\s]+)@/g, "$1[redacted]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
}

function ensureBareRepo(resolved, runGit) {
  if (!path.isAbsolute(resolved)) {
    throw new Error("internal error: bare repo path must be resolved before preparation");
  }
  if (!runGit) {
    throw new Error("internal error: runGit is required");
  }
  if (!existsBareRepo(resolved)) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    runGit(["init", "--bare", resolved], process.cwd());
  }
}

function existsBareRepo(resolved) {
  return path.basename(resolved) !== "" &&
    path.isAbsolute(resolved) &&
    path.parse(resolved).root !== resolved &&
    (fs.existsSync(path.join(resolved, "HEAD")) || fs.existsSync(path.join(resolved, "config")));
}
