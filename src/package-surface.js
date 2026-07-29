import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isInsidePath, matchesPattern, ReleasepressError } from "./config.js";
import { withBoundedNpmCacheEnv } from "./npm-env.js";

export function runPackageSurface({
  sourceRoot = process.cwd(),
  exportRoot = null,
  config,
  runner = spawnSync
}) {
  const roots = {
    source: path.resolve(sourceRoot),
    export: exportRoot ? path.resolve(exportRoot) : null
  };
  const artifactReports = config.artifacts
    .filter((artifact) => artifact.kind === "npm_pack")
    .map((artifact) => inspectNpmPackArtifact({ artifact, roots, runner }));
  const primary = artifactReports.find((artifact) => artifact.id === config.package.artifact_id) ?? artifactReports[0];
  if (!primary) {
    throw new ReleasepressError("package_artifact_missing", "No npm_pack artifact is configured");
  }
  const output = {
    ok: artifactReports.every((artifact) => artifact.ok),
    type: "releasepress_package",
    artifact_id: primary.id,
    command: primary.command,
    package_files: primary.package_files,
    violations: primary.violations,
    artifacts: artifactReports
  };

  const reportDir = path.join(sourceRoot, ".releasepress-report");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "package-files.json"), `${JSON.stringify(output, null, 2)}\n`);

  if (!output.ok) {
    throw new ReleasepressError("package_must_exclude_violation", "Package surface includes forbidden paths", {
      artifact_id: primary.id,
      violations: artifactReports.flatMap((artifact) =>
        artifact.violations.map((violation) => ({ artifact_id: artifact.id, ...violation }))
      )
    });
  }

  return output;
}

function inspectNpmPackArtifact({ artifact, roots, runner }) {
  const cwd = resolveArtifactCwd({ artifact, roots });
  const argv = artifact.inspect_argv;
  const result = runner(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: withBoundedNpmCacheEnv(process.env),
    shell: false
  });

  if (result.status !== 0) {
    throw new ReleasepressError("package_command_failed", "Package surface command failed", {
      artifact_id: artifact.id,
      argv,
      status: result.status,
      stderr: redactCommandOutput(String(result.stderr || "").trim())
    });
  }

  const packageFiles = parseNpmPackDryRunJson(result.stdout);
  const evaluation = evaluatePackageSurface(packageFiles, artifact.must_exclude);
  return {
    id: artifact.id,
    kind: artifact.kind,
    root: artifact.root,
    path: artifact.path,
    command: argv,
    package_files: packageFiles,
    violations: evaluation.violations,
    ok: evaluation.ok
  };
}

function resolveArtifactCwd({ artifact, roots }) {
  const root = artifact.root === "export" ? roots.export : roots.source;
  if (!root) {
    throw new ReleasepressError("missing_export_root", "Artifact root is export but no export root was provided", {
      artifact_id: artifact.id
    });
  }
  const cwd = path.resolve(root, artifact.path);
  if (!isInsidePath(root, cwd)) {
    throw new ReleasepressError("artifact_path_escape", "Artifact path escaped the selected root", {
      artifact_id: artifact.id,
      root: artifact.root,
      path: artifact.path
    });
  }
  return cwd;
}

export function parseNpmPackDryRunJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError("package_json_parse_failed", "npm pack dry-run output was not valid JSON", {
      reason: error.message
    });
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || !Array.isArray(item.files)) {
    throw new ReleasepressError("package_json_shape_invalid", "npm pack dry-run JSON did not contain a files array");
  }

  return item.files
    .map((file) => {
      if (!file || typeof file.path !== "string") {
        throw new ReleasepressError("package_json_shape_invalid", "Package file entry is missing path");
      }
      return file.path.replace(/\\/g, "/");
    })
    .sort();
}

export function evaluatePackageSurface(files, mustExclude) {
  const violations = [];
  for (const file of files) {
    const pattern = mustExclude.find((candidate) => packagePathMatches(file, candidate));
    if (pattern) {
      violations.push({ path: file, pattern });
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}

function redactCommandOutput(text) {
  let redacted = text;
  if (process.env.HOME) {
    redacted = redacted.split(process.env.HOME).join("~");
  }
  return redacted
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bGITEA_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/g, "GITEA_TOKEN=[REDACTED]");
}

function packagePathMatches(file, pattern) {
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return file === dir || file.startsWith(`${dir}/`);
  }
  return matchesPattern(file, pattern);
}
