import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createChecklist } from "./checklist.js";
import { isInsidePath, ReleasepressError } from "./config.js";
import { resolveVersion } from "./release-meta.js";

export const LOCAL_PROMOTE_RECEIPT_TYPE = "releasepress_local_promote_receipt";

const REPORT_DIR = ".releasepress-report";
const REPORT_NAME = "local-promote.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHIM_MARKER = "releasepress local promote shim v1";
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bGITEA_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/,
  /\bNPM_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/,
  /\/\/[^\s:]+\/?:_authToken=[A-Za-z0-9_.\-+/=]+/,
  /\b_authToken\s*=\s*[A-Za-z0-9_.\-+/=]+/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{24,}/i
];

export function promoteLocal({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  approved = false,
  runner = spawnSync,
  now = () => new Date()
}) {
  assertLocalSurface(config);
  if (!approved) {
    throw new ReleasepressError("local_promote_approval_required", "Local promote requires explicit approval");
  }

  const roots = resolveRoots({ exportRoot, sourceRoot });
  assertExistingReportGates({ config, roots });
  const checklist = createChecklist({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  if (!checklist.promote.ready) {
    throw new ReleasepressError("promote_prerequisites_failed", "Promote prerequisites are not satisfied", {
      blockers: checklist.promote.blockers
    });
  }

  const sourceCommit = readSourceCommit(roots.exportRoot);
  assertFullSha(sourceCommit, "source_commit");
  assertSourceStateAllowsLocalPromote({ local: config.surfaces.local, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const version = resolveVersion({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  const local = config.surfaces.local;
  const installed = local.strategy === "bin_shim"
    ? installBinShim({ local, roots })
    : installNpmPrefix({ local, roots, runner });

  const receipt = {
    type: LOCAL_PROMOTE_RECEIPT_TYPE,
    schema_version: 1,
    ok: true,
    tool: "releasepress",
    surface: "local",
    strategy: local.strategy,
    source_commit: sourceCommit,
    promoted_commit: sourceCommit,
    installed_command: local.command_name,
    installed_version: version.version,
    installed_path: installed.installedPath,
    source_path_class: local.source,
    target: installed.target,
    report_dir: REPORT_DIR,
    promoted_at: now().toISOString()
  };

  validateLocalPromoteReceipt({
    config,
    exportRoot: roots.exportRoot,
    sourceRoot: roots.sourceRoot,
    receipt,
    requireInstalled: true
  });
  writeJson(path.join(roots.exportRoot, REPORT_DIR, REPORT_NAME), receipt);
  return receipt;
}

export function validateLocalPromoteReceipt({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  receipt,
  requireInstalled = true
}) {
  assertLocalSurface(config);
  const roots = resolveRoots({ exportRoot, sourceRoot });
  assertReceiptEnvelope(receipt);
  assertNoReceiptSecretMaterial(receipt);

  const local = config.surfaces.local;
  const mismatches = [];
  compareField(mismatches, "strategy", local.strategy, receipt.strategy);
  compareField(mismatches, "installed_command", local.command_name, receipt.installed_command);
  compareField(mismatches, "source_path_class", local.source, receipt.source_path_class);
  compareField(mismatches, "report_dir", REPORT_DIR, receipt.report_dir);
  compareField(mismatches, "source_commit", readSourceCommit(roots.exportRoot), receipt.source_commit);
  compareField(mismatches, "promoted_commit", receipt.source_commit, receipt.promoted_commit);

  const version = resolveVersion({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  if (receipt.installed_version !== undefined) {
    compareField(mismatches, "installed_version", version.version, receipt.installed_version);
  }

  const expectedPath = expectedInstalledPath(local);
  compareField(mismatches, "installed_path", expectedPath, receipt.installed_path);
  if (mismatches.length > 0) {
    throw new ReleasepressError("local_promote_receipt_mismatch", "Local promote receipt does not match config or export reports", {
      mismatches
    });
  }

  if (requireInstalled) {
    assertInstalledCommand({
      local,
      installedPath: receipt.installed_path,
      allowedRoot: local.strategy === "npm_prefix" ? local.prefix : local.bin_dir
    });
  }

  return {
    ok: true,
    type: "releasepress_local_promote_receipt_validation",
    receipt: REPORT_NAME
  };
}

function assertLocalSurface(config) {
  if (!config?.surfaces?.local?.enabled) {
    throw new ReleasepressError("local_surface_disabled", "surfaces.local.enabled must be true to promote local");
  }
  if (!config.surfaces.local.command_name) {
    throw new ReleasepressError("missing_local_command_name", "surfaces.local.command_name is required for local promote");
  }
}

function resolveRoots({ exportRoot, sourceRoot }) {
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

function assertExistingReportGates({ config, roots }) {
  const checklist = readJsonReport(roots.exportRoot, "checklist.json");
  if (!checklist.ok) {
    throw new ReleasepressError("local_promote_checklist_required", "Local promote requires an existing passing checklist report", {
      report: `${REPORT_DIR}/checklist.json`,
      reason: checklist.reason
    });
  }
  if (checklist.value?.type !== "releasepress_checklist" || !checklist.value.ok || checklist.value.promote?.ready !== true) {
    throw new ReleasepressError("local_promote_checklist_failed", "Local promote requires a passing checklist report", {
      report: `${REPORT_DIR}/checklist.json`
    });
  }

  const verify = readJsonReport(roots.exportRoot, "verify-results.json");
  if (!verify.ok) {
    throw new ReleasepressError("local_promote_verify_required", "Local promote requires an existing passing verify report", {
      report: `${REPORT_DIR}/verify-results.json`,
      reason: verify.reason
    });
  }
  if (verify.value?.type !== "releasepress_verify" || !verify.value.ok) {
    throw new ReleasepressError("local_promote_verify_failed", "Local promote requires a passing verify report", {
      report: `${REPORT_DIR}/verify-results.json`
    });
  }

  const refreshed = createChecklist({ config, exportRoot: roots.exportRoot, sourceRoot: roots.sourceRoot });
  if (!refreshed.promote.ready) {
    throw new ReleasepressError("promote_prerequisites_failed", "Promote prerequisites are not satisfied", {
      blockers: refreshed.promote.blockers
    });
  }
}

function installBinShim({ local, roots }) {
  const sourceRoot = selectedSourceRoot({ local, roots });
  const targetPath = resolveTargetPath({ root: sourceRoot, target: local.target });
  const binDir = prepareLocalDirectory(local.bin_dir, "surfaces.local.bin_dir");
  const installedPath = path.join(binDir, local.command_name);
  if (!isInsidePath(binDir, installedPath)) {
    throw new ReleasepressError("local_promote_path_escape", "Local promote command path escaped bin_dir", {
      command_name: local.command_name
    });
  }

  assertOwnedOrAbsentShim({ installedPath, commandName: local.command_name, targetPath });
  fs.writeFileSync(installedPath, renderNodeShim({ commandName: local.command_name, targetPath }));
  fs.chmodSync(installedPath, 0o755);

  return {
    installedPath,
    target: local.target
  };
}

function installNpmPrefix({ local, roots, runner }) {
  const sourceRoot = selectedSourceRoot({ local, roots });
  const prefix = prepareLocalDirectory(local.prefix, "surfaces.local.prefix");
  const argv = ["npm", "install", "--prefix", prefix, "--ignore-scripts", "--offline", sourceRoot];
  const result = runner(argv[0], argv.slice(1), {
    cwd: sourceRoot,
    encoding: "utf8",
    shell: false
  });
  const status = typeof result.status === "number" ? result.status : result.error ? 1 : 0;
  if (status !== 0) {
    throw new ReleasepressError("local_promote_command_failed", "Local npm-prefix promote command failed", {
      argv,
      status,
      error_code: result.error?.code ?? null,
      stderr: redactCommandOutput(String(result.stderr || "").trim())
    });
  }

  const installedPath = path.join(prefix, "bin", local.command_name);
  assertInstalledCommand({ local, installedPath, allowedRoot: prefix });
  return {
    installedPath,
    target: "."
  };
}

function selectedSourceRoot({ local, roots }) {
  return local.source === "export" ? roots.exportRoot : roots.sourceRoot;
}

function resolveTargetPath({ root, target }) {
  const resolved = path.resolve(root, target);
  if (!isInsidePath(root, resolved)) {
    throw new ReleasepressError("local_promote_target_escape", "Local promote target escaped selected root", {
      target
    });
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", "Local promote target does not exist", { target });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Local promote target must not be a symlink", { target });
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("invalid_path", "Local promote target must be a file", { target });
  }

  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(resolved);
  if (!isInsidePath(realRoot, realTarget)) {
    throw new ReleasepressError("local_promote_target_escape", "Local promote target escaped selected root", {
      target
    });
  }
  return resolved;
}

function prepareLocalDirectory(dir, field) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `${field} must not be a symlink`, { path: dir });
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `${field} must be a directory`, { path: dir });
  }

  const real = fs.realpathSync(resolved);
  assertNotSystemPath(real, field);
  return resolved;
}

function assertOwnedOrAbsentShim({ installedPath, commandName, targetPath }) {
  let stat;
  try {
    stat = fs.lstatSync(installedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("local_promote_existing_command_unowned", "Local promote refuses to replace a symlink command", {
      installed_path: installedPath
    });
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("local_promote_existing_command_unowned", "Local promote refuses to replace a non-file command", {
      installed_path: installedPath
    });
  }

  const text = fs.readFileSync(installedPath, "utf8");
  if (!text.includes(SHIM_MARKER) || !text.includes(`commandName = ${JSON.stringify(commandName)}`)) {
    throw new ReleasepressError("local_promote_existing_command_unowned", "Local promote refuses to overwrite an unowned command", {
      installed_path: installedPath
    });
  }
  if (!text.includes(`target = ${JSON.stringify(targetPath)}`)) {
    throw new ReleasepressError("local_promote_existing_command_stale", "Existing Releasepress shim points at a different target", {
      installed_path: installedPath
    });
  }
}

function renderNodeShim({ commandName, targetPath }) {
  return [
    "#!/usr/bin/env node",
    `// ${SHIM_MARKER}`,
    "const { spawnSync } = require(\"node:child_process\");",
    `const commandName = ${JSON.stringify(commandName)};`,
    `const target = ${JSON.stringify(targetPath)};`,
    "const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: \"inherit\", shell: false });",
    "if (result.error) {",
    "  process.stderr.write(`${commandName}: ${result.error.message}\\n`);",
    "  process.exit(1);",
    "}",
    "process.exit(typeof result.status === \"number\" ? result.status : 0);",
    ""
  ].join("\n");
}

function expectedInstalledPath(local) {
  if (local.strategy === "bin_shim") {
    return path.join(path.resolve(local.bin_dir), local.command_name);
  }
  return path.join(path.resolve(local.prefix), "bin", local.command_name);
}

function assertInstalledCommand({ local, installedPath, allowedRoot }) {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedPath = path.resolve(installedPath);
  if (!isInsidePath(resolvedRoot, resolvedPath)) {
    throw new ReleasepressError("local_promote_path_escape", "Installed command escaped the configured local root", {
      installed_path: installedPath
    });
  }

  let stat;
  try {
    stat = fs.lstatSync(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("local_promote_installed_command_missing", "Installed command was not created", {
        installed_path: installedPath,
        strategy: local.strategy
      });
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realPath = fs.realpathSync(resolvedPath);
    if (!isInsidePath(realRoot, realPath)) {
      throw new ReleasepressError("local_promote_path_escape", "Installed command symlink escaped the configured local root", {
        installed_path: installedPath
      });
    }
    return;
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("invalid_path", "Installed command must be a file or in-root symlink", {
      installed_path: installedPath
    });
  }
}

function assertReceiptEnvelope(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ReleasepressError("local_promote_receipt_invalid", "Local promote receipt must be a JSON object");
  }
  const required = {
    type: LOCAL_PROMOTE_RECEIPT_TYPE,
    schema_version: 1,
    ok: true,
    tool: "releasepress",
    surface: "local"
  };
  for (const [field, expected] of Object.entries(required)) {
    if (receipt[field] !== expected) {
      throw new ReleasepressError("local_promote_receipt_invalid", "Local promote receipt has an invalid envelope", {
        field,
        expected,
        actual: receipt[field] ?? null
      });
    }
  }
  for (const field of ["strategy", "source_commit", "promoted_commit", "installed_command", "source_path_class", "installed_path", "report_dir", "promoted_at"]) {
    if (typeof receipt[field] !== "string" || receipt[field].length === 0) {
      throw new ReleasepressError("local_promote_receipt_invalid", "Local promote receipt is missing a required string field", {
        field
      });
    }
  }
  assertFullSha(receipt.source_commit, "source_commit");
  assertFullSha(receipt.promoted_commit, "promoted_commit");
  if (Number.isNaN(Date.parse(receipt.promoted_at))) {
    throw new ReleasepressError("local_promote_receipt_invalid", "Local promote receipt has an invalid promoted_at timestamp");
  }
  if (receipt.public_repo || receipt.github || receipt.npm || receipt.registry || receipt.dist_tag || receipt.release_url || receipt.published === true) {
    throw new ReleasepressError("local_promote_receipt_public_claim", "Local promote receipt must not claim public or package publication");
  }
}

function assertFullSha(value, field) {
  if (!SHA_PATTERN.test(String(value || ""))) {
    throw new ReleasepressError("local_promote_receipt_invalid", `${field} must be a full lowercase git SHA`, {
      field
    });
  }
}

function assertNoReceiptSecretMaterial(receipt) {
  const text = JSON.stringify(receipt);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new ReleasepressError("local_promote_receipt_secret_material", "Local promote receipt contains token-looking material");
  }
}

function compareField(mismatches, field, expected, actual) {
  if (expected !== actual) {
    mismatches.push({ field, expected, actual: actual ?? null });
  }
}

function readSourceCommit(exportRoot) {
  let value;
  try {
    value = fs.readFileSync(path.join(exportRoot, REPORT_DIR, "source-commit.txt"), "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("local_promote_source_commit_missing", "Local promote requires source-commit.txt");
    }
    throw error;
  }
  return value;
}

function assertSourceStateAllowsLocalPromote({ local, exportRoot, sourceRoot }) {
  const state = readJsonReport(exportRoot, "source-state.json");
  if (!state.ok || !state.value || typeof state.value !== "object") {
    throw new ReleasepressError("local_promote_source_state_required", "Local promote requires source-state.json");
  }
  if (local.source === "source" && state.value.dirty === true) {
    throw new ReleasepressError("local_promote_dirty_source", "Local promote refuses to install from a dirty source checkout", {
      source: local.source
    });
  }
  if (local.source === "source") {
    assertLiveSourceCleanForInstall(sourceRoot);
  }
}

function assertLiveSourceCleanForInstall(sourceRoot) {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: sourceRoot,
    encoding: "utf8",
    shell: false
  });
  if (status.status !== 0) {
    throw new ReleasepressError("local_promote_source_state_required", "Local promote could not verify live source state", {
      stderr: redactCommandOutput(String(status.stderr || "").trim())
    });
  }
  const dirtyPaths = parseStatusPaths(String(status.stdout || "")).filter((file) => !isReportPath(file));
  if (dirtyPaths.length > 0) {
    throw new ReleasepressError("local_promote_dirty_source", "Local promote refuses to install from a dirty source checkout", {
      paths: dirtyPaths
    });
  }
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
    const file = record.slice(3).replace(/\\/g, "/");
    paths.push(file);
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
      if (records[index]) {
        paths.push(records[index].replace(/\\/g, "/"));
      }
    }
  }
  return paths;
}

function isReportPath(file) {
  return file === REPORT_DIR || file.startsWith(`${REPORT_DIR}/`);
}

function readJsonReport(root, report) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, REPORT_DIR, report), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, status: "missing", reason: "report_missing", report };
    }
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: "invalid", reason: "report_json_invalid", report };
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

function assertNotSystemPath(resolved, field) {
  const forbiddenRoots = [
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/local",
    "/opt/homebrew",
    "/System",
    "/Library"
  ];
  if (forbiddenRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new ReleasepressError("invalid_path", `${field} targets a system-managed directory`, {
      path: resolved
    });
  }
}

function redactCommandOutput(text) {
  let redacted = text;
  if (process.env.HOME) {
    redacted = redacted.split(process.env.HOME).join("~");
  }
  return redacted
    .replace(/\bNPM_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/g, "NPM_TOKEN=[REDACTED]")
    .replace(/\/\/[^\s:]+\/?:_authToken=[A-Za-z0-9_.\-+/=]+/g, "//registry/:_authToken=[REDACTED]")
    .replace(/\b_authToken\s*=\s*[A-Za-z0-9_.\-+/=]+/g, "_authToken=[REDACTED]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
