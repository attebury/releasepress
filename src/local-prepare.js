import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runConfiguredArgvStep } from "./argv-steps.js";
import { isInsidePath, ReleasepressError } from "./config.js";
import { resolveVersion } from "./release-meta.js";
import { MAX_REPORT_BYTES, readBoundedJson } from "./report-io.js";

export const LOCAL_PREPARE_TYPE = "releasepress_local_prepare";

const REPORT_DIR = ".releasepress-report";
const REPORT_NAME = "local-prepare.json";
const SOURCE_STATE_NAME = "source-state.json";
const SOURCE_COMMIT_NAME = "source-commit.txt";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ALLOWED_ROOT_ENTRIES = new Set([REPORT_DIR]);
const ALLOWED_REPORT_ENTRIES = new Set([
  REPORT_NAME,
  SOURCE_STATE_NAME,
  SOURCE_COMMIT_NAME,
  "local-promote.json"
]);
const RECEIPT_KEYS = new Set([
  "ok",
  "type",
  "schema_version",
  "tool",
  "surface",
  "authority",
  "source_commit",
  "source_dirty",
  "local_policy_digest",
  "strategy",
  "source_path_class",
  "installed_command",
  "target",
  "version",
  "checks",
  "prepared_at"
]);
const CHECK_KEYS = new Set([
  "type",
  "id",
  "ok",
  "required",
  "skipped",
  "skip_reason",
  "duration_ms",
  "exit_code",
  "signal",
  "error_code"
]);
const SOURCE_STATE_KEYS = new Set(["type", "schema_version", "commit", "dirty"]);

export function prepareLocal({
  config,
  outDir,
  sourceRoot = process.cwd(),
  runner = spawnSync,
  now = () => new Date()
}) {
  const local = requireSourceLocalPolicy(config);
  const roots = resolvePrepareRoots({ outDir, sourceRoot });
  const existing = readOptionalPrepareReport(roots.evidenceRoot);
  const sourceState = readCleanSourceState(roots.sourceRoot, "local_prepare");
  const version = resolveLocalVersion({ config, sourceRoot: roots.sourceRoot });
  assertLocalTarget({ sourceRoot: roots.sourceRoot, target: local.target });
  const policyDigest = localPolicyDigest(config);

  if (existing !== null) {
    validatePrepareReceipt({
      config,
      receipt: existing,
      sourceState,
      version,
      requirePassingChecks: false
    });
  }

  const checks = [];
  for (const step of local.prepare.steps) {
    const result = runConfiguredArgvStep({
      step,
      cwd: roots.sourceRoot,
      timeoutMs: local.prepare.timeout_ms,
      packetType: "releasepress_local_prepare_step",
      timeoutCode: "local_prepare_step_timeout",
      runner
    });
    if (result.skipped) {
      result.ok = false;
      result.error_code = "local_prepare_step_skipped";
    }
    checks.push(result);
    if (step.required && !result.ok) {
      break;
    }
  }

  const receipt = {
    ok: checks.every((check) => check.ok || !check.required),
    type: LOCAL_PREPARE_TYPE,
    schema_version: 1,
    tool: "releasepress",
    surface: "local",
    authority: "local_only",
    source_commit: sourceState.commit,
    source_dirty: false,
    local_policy_digest: policyDigest,
    strategy: local.strategy,
    source_path_class: local.source,
    installed_command: local.command_name,
    target: local.target ?? ".",
    version: version.version,
    checks,
    prepared_at: now().toISOString()
  };

  writePrepareBundle({ evidenceRoot: roots.evidenceRoot, sourceState, receipt });
  return receipt;
}

export function validateLocalPrepareEvidence({
  config,
  evidenceRoot,
  sourceRoot = process.cwd()
}) {
  requireSourceLocalPolicy(config);
  const roots = resolveExistingRoots({ evidenceRoot, sourceRoot });
  const receipt = readRequiredPrepareReport(roots.evidenceRoot);
  const sourceState = readCleanSourceState(roots.sourceRoot, "local_promote");
  const reportedState = readRequiredSourceState(roots.evidenceRoot);
  const reportedCommit = readRequiredSourceCommit(roots.evidenceRoot);
  const version = resolveLocalVersion({ config, sourceRoot: roots.sourceRoot });
  assertLocalTarget({ sourceRoot: roots.sourceRoot, target: config.surfaces.local.target });
  validatePrepareReceipt({
    config,
    receipt,
    sourceState,
    version,
    requirePassingChecks: true
  });
  if (
    !hasOnlyKeys(reportedState, SOURCE_STATE_KEYS)
    || reportedState?.type !== "releasepress_local_source_state"
    || reportedState.schema_version !== 1
    || reportedState.commit !== sourceState.commit
    || reportedState.dirty !== false
    || reportedCommit !== sourceState.commit
  ) {
    throw new ReleasepressError(
      "local_prepare_source_state_mismatch",
      "Local preparation source-state evidence does not match the current clean source"
    );
  }
  return {
    ok: true,
    type: "releasepress_local_prepare_validation",
    receipt: REPORT_NAME,
    source_commit: sourceState.commit,
    local_policy_digest: receipt.local_policy_digest
  };
}

export function localPolicyDigest(config) {
  const local = config?.surfaces?.local;
  return `sha256:${crypto
    .createHash("sha256")
    .update(stableStringify({
      local,
      version: config?.version ?? null
    }))
    .digest("hex")}`;
}

function requireSourceLocalPolicy(config) {
  const local = config?.surfaces?.local;
  if (!local?.enabled) {
    throw new ReleasepressError(
      "local_surface_disabled",
      "surfaces.local.enabled must be true for local preparation"
    );
  }
  if (local.source !== "source") {
    throw new ReleasepressError(
      "local_prepare_source_unsupported",
      "releasepress local prepare only supports source-backed local surfaces"
    );
  }
  if (!local.prepare?.enabled || local.prepare.steps.length === 0) {
    throw new ReleasepressError(
      "local_prepare_checks_required",
      "Source-backed local promotion requires configured surfaces.local.prepare steps"
    );
  }
  if (!local.prepare.steps.some((step) => step.required)) {
    throw new ReleasepressError(
      "local_prepare_required_check_missing",
      "Source-backed local promotion requires at least one required preparation check"
    );
  }
  if (!local.smoke_check) {
    throw new ReleasepressError(
      "local_prepare_smoke_check_required",
      "Source-backed local promotion requires surfaces.local.smoke_check"
    );
  }
  if (config.version?.source !== "source") {
    throw new ReleasepressError(
      "local_prepare_version_source_unsupported",
      "Source-backed local preparation requires version.source to be source"
    );
  }
  return local;
}

function resolvePrepareRoots({ outDir, sourceRoot }) {
  if (!outDir) {
    throw new ReleasepressError("missing_out", "--out is required");
  }
  const source = resolveExistingDirectory(sourceRoot, "source");
  const evidence = path.resolve(outDir);
  assertSafeEvidenceRoot(evidence);
  if (isInsidePath(source, evidence) || isInsidePath(evidence, source)) {
    throw new ReleasepressError(
      "local_prepare_path_overlap",
      "Local evidence root and source root must not contain one another"
    );
  }
  if (fs.existsSync(evidence)) {
    assertDirectory(evidence, "local evidence");
  } else {
    fs.mkdirSync(evidence, { recursive: true });
    assertDirectory(evidence, "local evidence");
  }
  const realSource = fs.realpathSync(source);
  const realEvidence = fs.realpathSync(evidence);
  assertSafeEvidenceRoot(realEvidence);
  if (isInsidePath(realSource, realEvidence) || isInsidePath(realEvidence, realSource)) {
    throw new ReleasepressError(
      "local_prepare_path_overlap",
      "Local evidence root and source root must not contain one another"
    );
  }
  assertEvidenceRootContents(realEvidence);
  prepareReportDirectory(realEvidence);
  return { sourceRoot: realSource, evidenceRoot: realEvidence };
}

function resolveExistingRoots({ evidenceRoot, sourceRoot }) {
  if (!evidenceRoot) {
    throw new ReleasepressError("missing_path", "--path is required");
  }
  const source = resolveExistingDirectory(sourceRoot, "source");
  const evidence = resolveExistingDirectory(evidenceRoot, "local evidence");
  assertSafeEvidenceRoot(evidence);
  const realSource = fs.realpathSync(source);
  const realEvidence = fs.realpathSync(evidence);
  assertSafeEvidenceRoot(realEvidence);
  if (isInsidePath(realSource, realEvidence) || isInsidePath(realEvidence, realSource)) {
    throw new ReleasepressError(
      "local_prepare_path_overlap",
      "Local evidence root and source root must not contain one another"
    );
  }
  assertEvidenceRootContents(realEvidence);
  assertReportDirectory(realEvidence);
  return { sourceRoot: realSource, evidenceRoot: realEvidence };
}

function resolveExistingDirectory(value, purpose) {
  const resolved = path.resolve(value);
  assertDirectory(resolved, purpose);
  return resolved;
}

function assertDirectory(resolved, purpose) {
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_path", `${purpose} path does not exist`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", `${purpose} path must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new ReleasepressError("invalid_path", `${purpose} path must be a directory`);
  }
}

function assertSafeEvidenceRoot(resolved) {
  const root = path.parse(resolved).root;
  const forbidden = [
    root,
    path.join(root, "bin"),
    path.join(root, "etc"),
    path.join(root, "sbin"),
    path.join(root, "usr"),
    path.join(root, "System"),
    path.join(root, "Library"),
    path.join(root, "opt", "homebrew")
  ];
  if (forbidden.some((entry) => resolved === entry || resolved.startsWith(`${entry}${path.sep}`))) {
    throw new ReleasepressError(
      "local_prepare_unsafe_evidence_root",
      "Local evidence root must not target a system-managed path"
    );
  }
}

function assertEvidenceRootContents(root) {
  const unexpected = fs.readdirSync(root).filter((entry) => !ALLOWED_ROOT_ENTRIES.has(entry));
  if (unexpected.length > 0) {
    throw new ReleasepressError(
      "local_prepare_evidence_root_not_empty",
      "Local evidence root contains files outside the Releasepress report bundle",
      { unexpected_entry_count: unexpected.length }
    );
  }
}

function prepareReportDirectory(root) {
  const reportDir = path.join(root, REPORT_DIR);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir);
  }
  assertReportDirectory(root);
}

function assertReportDirectory(root) {
  const reportDir = path.join(root, REPORT_DIR);
  if (!fs.existsSync(reportDir)) {
    throw new ReleasepressError(
      "local_prepare_receipt_required",
      "Source-backed local promotion requires local preparation evidence"
    );
  }
  assertDirectory(reportDir, "local evidence report");
  const unexpected = fs.readdirSync(reportDir).filter((entry) => !ALLOWED_REPORT_ENTRIES.has(entry));
  if (unexpected.length > 0) {
    throw new ReleasepressError(
      "local_prepare_report_bundle_conflict",
      "Local evidence report bundle contains unexpected files",
      { unexpected_entry_count: unexpected.length }
    );
  }
  for (const entry of fs.readdirSync(reportDir)) {
    const file = path.join(reportDir, entry);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new ReleasepressError("symlink_selected", "Local evidence reports must not be symlinks");
    }
    if (!stat.isFile()) {
      throw new ReleasepressError("invalid_path", "Local evidence reports must be regular files");
    }
    if (stat.size > MAX_REPORT_BYTES) {
      throw new ReleasepressError("local_prepare_report_oversized", "Local evidence report exceeds the size limit");
    }
  }
}

function readCleanSourceState(sourceRoot, prefix) {
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
    shell: false
  });
  const commit = String(commitResult.stdout ?? "").trim();
  if (commitResult.status !== 0 || !SHA_PATTERN.test(commit)) {
    throw new ReleasepressError(
      `${prefix}_source_state_required`,
      "Local preparation requires a Git source with a full current commit"
    );
  }
  const statusResult = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: sourceRoot,
    encoding: "utf8",
    shell: false
  });
  if (statusResult.status !== 0) {
    throw new ReleasepressError(
      `${prefix}_source_state_required`,
      "Local preparation could not verify source cleanliness"
    );
  }
  const dirtyPaths = parseStatusPaths(String(statusResult.stdout ?? ""))
    .filter((file) => file !== REPORT_DIR && !file.startsWith(`${REPORT_DIR}/`));
  if (dirtyPaths.length > 0) {
    throw new ReleasepressError(
      `${prefix}_dirty_source`,
      "Local preparation requires a clean source checkout",
      { dirty_path_count: dirtyPaths.length }
    );
  }
  return { commit, dirty: false };
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
    paths.push(record.slice(3).replace(/\\/g, "/"));
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
      if (records[index]) {
        paths.push(records[index].replace(/\\/g, "/"));
      }
    }
  }
  return paths;
}

function resolveLocalVersion({ config, sourceRoot }) {
  return resolveVersion({ config, sourceRoot, exportRoot: null });
}

function assertLocalTarget({ sourceRoot, target }) {
  if (!target) {
    return;
  }
  const resolved = path.resolve(sourceRoot, target);
  if (!isInsidePath(sourceRoot, resolved)) {
    throw new ReleasepressError("local_prepare_target_escape", "Local command target escaped source root");
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("local_prepare_target_missing", "Local command target does not exist");
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Local command target must not be a symlink");
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("invalid_path", "Local command target must be a regular file");
  }
  const realSource = fs.realpathSync(sourceRoot);
  const realTarget = fs.realpathSync(resolved);
  if (!isInsidePath(realSource, realTarget)) {
    throw new ReleasepressError("local_prepare_target_escape", "Local command target escaped source root");
  }
}

function validatePrepareReceipt({
  config,
  receipt,
  sourceState,
  version,
  requirePassingChecks
}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ReleasepressError("local_prepare_receipt_invalid", "Local preparation receipt must be a JSON object");
  }
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_KEYS.has(key)) {
      throw new ReleasepressError(
        "local_prepare_receipt_invalid",
        "Local preparation receipt contains an unexpected field",
        { field: key }
      );
    }
  }
  const expectedEnvelope = {
    type: LOCAL_PREPARE_TYPE,
    schema_version: 1,
    tool: "releasepress",
    surface: "local",
    authority: "local_only"
  };
  for (const [field, expected] of Object.entries(expectedEnvelope)) {
    if (receipt[field] !== expected) {
      throw new ReleasepressError(
        "local_prepare_receipt_invalid",
        "Local preparation receipt has an invalid envelope",
        { field }
      );
    }
  }
  if (typeof receipt.ok !== "boolean" || receipt.source_dirty !== false) {
    throw new ReleasepressError("local_prepare_receipt_invalid", "Local preparation receipt has invalid status fields");
  }
  if (!SHA_PATTERN.test(receipt.source_commit ?? "") || receipt.source_commit !== sourceState.commit) {
    throw new ReleasepressError(
      "local_prepare_source_mismatch",
      "Local preparation receipt does not match the current source commit"
    );
  }
  const local = config.surfaces.local;
  const comparisons = [
    ["local_policy_digest", localPolicyDigest(config), receipt.local_policy_digest],
    ["strategy", local.strategy, receipt.strategy],
    ["source_path_class", "source", receipt.source_path_class],
    ["installed_command", local.command_name, receipt.installed_command],
    ["target", local.target ?? ".", receipt.target],
    ["version", version.version, receipt.version]
  ];
  const mismatches = comparisons
    .filter(([, expected, actual]) => expected !== actual)
    .map(([field]) => ({ field }));
  if (mismatches.length > 0) {
    throw new ReleasepressError(
      "local_prepare_receipt_mismatch",
      "Local preparation receipt does not match the current local policy",
      { mismatches }
    );
  }
  if (
    !Array.isArray(receipt.checks)
    || receipt.checks.length > local.prepare.steps.length
    || (receipt.ok === true && receipt.checks.length !== local.prepare.steps.length)
  ) {
    throw new ReleasepressError(
      "local_prepare_checks_mismatch",
      "Local preparation receipt does not contain the configured checks"
    );
  }
  for (let index = 0; index < receipt.checks.length; index += 1) {
    const expected = local.prepare.steps[index];
    const actual = receipt.checks[index];
    const resultIsPassing = (
      actual?.exit_code === 0
      && actual.signal === null
      && actual.error_code === null
    );
    if (
      !hasOnlyKeys(actual, CHECK_KEYS)
      || actual?.type !== "releasepress_local_prepare_step"
      || actual.id !== expected.id
      || actual.required !== expected.required
      || typeof actual.ok !== "boolean"
      || actual.ok !== resultIsPassing
      || actual.skipped !== false
      || actual.skip_reason !== undefined
      || !Number.isInteger(actual.duration_ms)
      || actual.duration_ms < 0
      || !(actual.exit_code === null || Number.isInteger(actual.exit_code))
      || !(actual.signal === null || typeof actual.signal === "string")
      || !(actual.error_code === null || typeof actual.error_code === "string")
    ) {
      throw new ReleasepressError(
        "local_prepare_checks_mismatch",
        "Local preparation receipt check identity does not match configured policy",
        { check_index: index }
      );
    }
    if (requirePassingChecks && expected.required && actual.ok !== true) {
      throw new ReleasepressError(
        "local_prepare_checks_failed",
        "Local preparation receipt contains a failed required check",
        { check_id: expected.id }
      );
    }
  }
  if (requirePassingChecks && receipt.ok !== true) {
    throw new ReleasepressError(
      "local_prepare_checks_failed",
      "Local preparation receipt is not passing"
    );
  }
  if (Number.isNaN(Date.parse(receipt.prepared_at ?? ""))) {
    throw new ReleasepressError(
      "local_prepare_receipt_invalid",
      "Local preparation receipt has an invalid prepared_at timestamp"
    );
  }
}

function hasOnlyKeys(value, allowed) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key))
  );
}

function readOptionalPrepareReport(root) {
  const file = path.join(root, REPORT_DIR, REPORT_NAME);
  if (!fs.existsSync(file)) {
    return null;
  }
  return readBoundedJsonLocal(file, "local_prepare_receipt_invalid");
}

function readRequiredPrepareReport(root) {
  const file = path.join(root, REPORT_DIR, REPORT_NAME);
  if (!fs.existsSync(file)) {
    throw new ReleasepressError(
      "local_prepare_receipt_required",
      "Source-backed local promotion requires local-prepare.json"
    );
  }
  return readBoundedJsonLocal(file, "local_prepare_receipt_invalid");
}

function readRequiredSourceState(root) {
  const file = path.join(root, REPORT_DIR, SOURCE_STATE_NAME);
  if (!fs.existsSync(file)) {
    throw new ReleasepressError(
      "local_prepare_source_state_required",
      "Source-backed local promotion requires source-state.json"
    );
  }
  return readBoundedJsonLocal(file, "local_prepare_source_state_invalid");
}

function readRequiredSourceCommit(root) {
  const file = path.join(root, REPORT_DIR, SOURCE_COMMIT_NAME);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError(
        "local_prepare_source_commit_required",
        "Source-backed local promotion requires source-commit.txt"
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleasepressError("symlink_selected", "Local source commit report must be a regular file");
  }
  if (stat.size > 128) {
    throw new ReleasepressError("local_prepare_report_oversized", "Local source commit report exceeds the size limit");
  }
  const value = fs.readFileSync(file, "utf8").trim();
  if (!SHA_PATTERN.test(value)) {
    throw new ReleasepressError("local_prepare_source_commit_invalid", "Local source commit report is invalid");
  }
  return value;
}

function readBoundedJsonLocal(file, invalidCode) {
  return readBoundedJson(file, invalidCode, {
    oversizedCode: "local_prepare_report_oversized",
    oversizedMessage: "Local evidence report exceeds the size limit",
    invalidMessage: "Local evidence report is not valid JSON",
    symlinkMessage: "Local evidence report must not be a symlink",
    notFileMessage: "Local evidence report must be a regular file"
  });
}

function writePrepareBundle({ evidenceRoot, sourceState, receipt }) {
  const reportDir = path.join(evidenceRoot, REPORT_DIR);
  atomicWrite(path.join(reportDir, SOURCE_COMMIT_NAME), `${sourceState.commit}\n`);
  atomicWrite(path.join(reportDir, SOURCE_STATE_NAME), `${JSON.stringify({
    type: "releasepress_local_source_state",
    schema_version: 1,
    commit: sourceState.commit,
    dirty: false
  }, null, 2)}\n`);
  atomicWrite(path.join(reportDir, REPORT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);
}

function atomicWrite(file, text) {
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) {
    throw new ReleasepressError("local_prepare_report_oversized", "Local evidence report exceeds the size limit");
  }
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ReleasepressError("symlink_selected", "Local evidence report must be a regular file");
    }
  }
  const temporary = `${file}.tmp`;
  if (fs.existsSync(temporary)) {
    const stat = fs.lstatSync(temporary);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ReleasepressError("symlink_selected", "Local evidence temporary file must be a regular file");
    }
  }
  fs.writeFileSync(temporary, text, { flag: "w", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
