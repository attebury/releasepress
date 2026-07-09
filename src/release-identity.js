import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";

function parseNpmPackage(fileContent) {
  let json;
  try {
    json = JSON.parse(fileContent);
  } catch (e) {
    throw new Error(`is not valid JSON: ${e.message}`);
  }
  return { name: json.name, version: json.version };
}

function parseCargoToml(fileContent) {
  const lines = fileContent.split(/\r?\n/);
  let name, version;
  let inPackageSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[package]")) {
      inPackageSection = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackageSection = false;
      continue;
    }
    if (inPackageSection) {
      const nameMatch = trimmed.match(/^name\s*=\s*"(.*)"/);
      if (nameMatch) name = nameMatch[1];
      const versionMatch = trimmed.match(/^version\s*=\s*"(.*)"/);
      if (versionMatch) version = versionMatch[1];
    }
  }
  return { name, version };
}

function parsePythonToml(fileContent) {
  const lines = fileContent.split(/\r?\n/);
  let name, version;
  let inProjectSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[project]")) {
      inProjectSection = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inProjectSection = false;
      continue;
    }
    if (inProjectSection) {
      const nameMatch = trimmed.match(/^name\s*=\s*"(.*)"/);
      if (nameMatch) name = nameMatch[1];
      const versionMatch = trimmed.match(/^version\s*=\s*"(.*)"/);
      if (versionMatch) version = versionMatch[1];
    }
  }
  return { name, version };
}

const PARSER_REGISTRY = {
  "npm-package": parseNpmPackage,
  "cargo-toml": parseCargoToml,
  "python-toml": parsePythonToml
};

function getDefaultPath(artifact) {
  switch (artifact) {
    case "npm-package": return "package.json";
    case "cargo-toml": return "Cargo.toml";
    case "python-toml": return "pyproject.toml";
    default: return "package.json";
  }
}

export function getReleaseIdentity({ config, sourceRoot = process.cwd() } = {}) {
  const ri = config?.release_identity;
  const providers = config?.delivery?.providers ?? [];
  
  const hasPreflightProviders = providers.some((p) => {
    if (!p.enabled) return false;
    if (p.kind === "package_registry" && p.version_policy === "must-not-exist") return true;
    if (p.kind === "git_host" && p.tag?.enabled === true) return true;
    return false;
  });

  if (!ri && !hasPreflightProviders) {
    return null;
  }

  const versionSource = ri?.version_source ?? { artifact: "npm-package", path: "package.json" };
  const tagNameTemplate = ri?.tag_name ?? "v{version}";

  const parser = PARSER_REGISTRY[versionSource.artifact];
  if (!parser) {
    throw new ReleasepressError("unsupported_version_source", `Unsupported version source artifact: ${versionSource.artifact}`, {
      artifact: versionSource.artifact
    });
  }

  const defaultPath = getDefaultPath(versionSource.artifact);
  const pkgPath = path.resolve(sourceRoot, versionSource.path || defaultPath);
  
  // Ensure path is inside source root
  const relative = path.relative(sourceRoot, pkgPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ReleasepressError("unsafe_pattern", `Package path escapes source root: ${versionSource.path || defaultPath}`, {
      path: versionSource.path || defaultPath
    });
  }

  let fileContent;
  try {
    fileContent = fs.readFileSync(pkgPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ReleasepressError("release_identity_missing", `Release identity artifact not found at: ${versionSource.path || defaultPath}`, {
        path: versionSource.path || defaultPath
      });
    }
    throw error;
  }

  let packageName, version;
  try {
    const parsed = parser(fileContent);
    packageName = parsed.name;
    version = parsed.version;
  } catch (error) {
    throw new ReleasepressError("release_identity_invalid", `Release identity artifact at ${versionSource.path || defaultPath} is not valid: ${error.message}`, {
      path: versionSource.path || defaultPath,
      reason: error.message
    });
  }

  if (!packageName || typeof packageName !== "string") {
    throw new ReleasepressError("release_identity_invalid", `Package name is missing or invalid in ${versionSource.path || defaultPath}`);
  }
  if (!version || typeof version !== "string") {
    throw new ReleasepressError("release_identity_invalid", `Package version is missing or invalid in ${versionSource.path || defaultPath}`);
  }

  const tagName = tagNameTemplate.replace("{version}", version);

  return {
    packageName,
    version,
    tagName
  };
}
