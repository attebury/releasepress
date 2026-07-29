import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig, ReleasepressError } from "./config.js";

const GITIGNORE_ENTRY = ".releasepress-report/";
const LOCAL_SURFACE_COMPARE_KEYS = ["enabled", "strategy", "command_name", "source", "target", "bin_dir"];

export function bootstrapLocalSurface({
  sourceRoot = process.cwd(),
  configPath,
  binDir,
  commandName = null,
  smokeCheckArgv = ["--version"],
  force = false
}) {
  const resolvedSourceRoot = resolveSourceRoot(sourceRoot);
  if (!binDir) {
    throw new ReleasepressError("missing_flag_value", "--bin-dir is required");
  }
  if (!Array.isArray(smokeCheckArgv) || smokeCheckArgv.length === 0) {
    throw new ReleasepressError("invalid_config", "--smoke-check-arg requires at least one value");
  }

  // loadConfig validates the existing base config (stage/review/include policy)
  // is already sound; bootstrap only ever adds/updates surfaces.local on top of
  // a working config, it does not author stage_repo or review_targets policy.
  loadConfig(configPath);
  const resolvedConfigPath = path.resolve(configPath);
  const rawConfig = readRawConfig(resolvedConfigPath);

  const pkg = readPackageJson(resolvedSourceRoot);
  const binEntry = resolvePrimaryBinEntry(pkg, commandName);

  const candidateLocal = {
    enabled: true,
    strategy: "bin_shim",
    bin_dir: path.resolve(binDir),
    command_name: binEntry.commandName,
    source: "source",
    target: binEntry.target,
    smoke_check: { argv: smokeCheckArgv }
  };

  const existingLocal = rawConfig.surfaces?.local ?? null;
  const matches = localSurfaceMatches(existingLocal, candidateLocal);

  if (!matches && existingLocal?.enabled && !force) {
    throw new ReleasepressError("bootstrap_local_surface_conflict", "surfaces.local is already configured differently; pass --force to overwrite", {
      existing: existingLocal,
      candidate: candidateLocal
    });
  }

  const nextRawConfig = {
    ...rawConfig,
    surfaces: {
      ...(rawConfig.surfaces ?? {}),
      local: candidateLocal
    }
  };

  // Validate the merged config before writing anything so a conflict with
  // unrelated policy (e.g. disallowed profiles) fails closed pre-mutation.
  const validated = validateConfig(nextRawConfig, resolvedConfigPath);

  const changed = !matches;
  if (changed) {
    fs.writeFileSync(resolvedConfigPath, `${JSON.stringify(nextRawConfig, null, 2)}\n`);
  }

  const gitignoreUpdated = ensureGitignoreEntry(resolvedSourceRoot);

  return {
    ok: true,
    type: "releasepress_bootstrap_local",
    config_path: resolvedConfigPath,
    config_changed: changed,
    gitignore_updated: gitignoreUpdated,
    surfaces_local: validated.surfaces.local
  };
}

function resolveSourceRoot(sourceRoot) {
  const resolved = path.resolve(sourceRoot);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", "--source path does not exist", { path: sourceRoot });
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", "--source must be a directory", { path: sourceRoot });
  }
  return resolved;
}

function readRawConfig(resolvedConfigPath) {
  const text = fs.readFileSync(resolvedConfigPath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError("invalid_config_json", "Config file is not valid JSON", {
      path: resolvedConfigPath,
      reason: error.message
    });
  }
}

function readPackageJson(resolvedSourceRoot) {
  const pkgPath = path.join(resolvedSourceRoot, "package.json");
  let text;
  try {
    text = fs.readFileSync(pkgPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("bootstrap_package_json_missing", "releasepress bootstrap local requires a package.json with a bin entry", {
        path: pkgPath
      });
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError("bootstrap_package_json_invalid", "package.json is not valid JSON", {
      path: pkgPath,
      reason: error.message
    });
  }
}

function resolvePrimaryBinEntry(pkg, requestedCommandName) {
  const bin = pkg.bin;
  if (!bin) {
    throw new ReleasepressError("bootstrap_bin_entry_missing", "package.json has no bin entry to promote locally");
  }

  if (typeof bin === "string") {
    if (!pkg.name) {
      throw new ReleasepressError("bootstrap_bin_entry_missing", "package.json bin is a string but package.json has no name to derive a command name from");
    }
    return { commandName: requestedCommandName || pkg.name, target: bin };
  }

  if (typeof bin !== "object" || Array.isArray(bin)) {
    throw new ReleasepressError("bootstrap_bin_entry_invalid", "package.json bin must be a string or an object");
  }

  const keys = Object.keys(bin);
  if (keys.length === 0) {
    throw new ReleasepressError("bootstrap_bin_entry_missing", "package.json bin has no entries");
  }

  if (requestedCommandName) {
    if (!Object.hasOwn(bin, requestedCommandName)) {
      throw new ReleasepressError("bootstrap_bin_entry_missing", `package.json bin has no entry named "${requestedCommandName}"`, {
        available: keys
      });
    }
    return { commandName: requestedCommandName, target: bin[requestedCommandName] };
  }

  if (keys.length > 1) {
    throw new ReleasepressError("bootstrap_bin_entry_ambiguous", "package.json bin has multiple entries; pass --command-name to select one", {
      available: keys
    });
  }

  return { commandName: keys[0], target: bin[keys[0]] };
}

function localSurfaceMatches(existing, candidate) {
  if (!existing || typeof existing !== "object") {
    return false;
  }
  for (const key of LOCAL_SURFACE_COMPARE_KEYS) {
    if (existing[key] !== candidate[key]) {
      return false;
    }
  }
  const existingArgv = existing.smoke_check?.argv;
  const candidateArgv = candidate.smoke_check.argv;
  if (!Array.isArray(existingArgv) || existingArgv.length !== candidateArgv.length) {
    return false;
  }
  return existingArgv.every((value, index) => value === candidateArgv[index]);
}

function ensureGitignoreEntry(resolvedSourceRoot) {
  const gitignorePath = path.join(resolvedSourceRoot, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(gitignorePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const alreadyPresent = text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === GITIGNORE_ENTRY || trimmed === ".releasepress-report";
  });
  if (alreadyPresent) {
    return false;
  }
  const needsNewline = text.length > 0 && !text.endsWith("\n");
  fs.writeFileSync(gitignorePath, `${text}${needsNewline ? "\n" : ""}${GITIGNORE_ENTRY}\n`);
  return true;
}
