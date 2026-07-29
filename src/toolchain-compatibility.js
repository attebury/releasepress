import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";

export const TOOLCHAIN_COMPATIBILITY_MATRIX_TYPE = "toolchain.compatibility_matrix.v1";
export const TOOLCHAIN_COMPATIBILITY_AUTHORITY = "compatibility_policy_only";

const REQUIRED_NOT_AUTHORITY_FOR = [
  "installed_tool_truth",
  "capability_truth",
  "producer_truth",
  "audit_judgment",
  "work_contract",
  "work_judgment",
  "forge_facts",
  "execution_facts",
  "attestation",
  "replay_execution",
  "merge",
  "release",
  "lane",
  "proof",
  "security",
  "telemetry",
  "promotion_execution"
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNSAFE_LOCAL_PATH_PATTERN = /(^|[\s"'=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/)/;
const CREDENTIAL_URL_PATTERN = /https?:\/\/[^\s/@]+:[^\s/@]+@/i;
const TOKEN_LIKE_PATTERN = /(?:\bsk-[A-Za-z0-9]{12,}|\bghp_[A-Za-z0-9_]{12,}|\btoken=|\bAuthorization:|\bapi[_-]?key\b)/i;
const PROMPT_PATTERN = /\b(?:system prompt|developer message|raw prompt)\b/i;
const ENV_DUMP_PATTERN = /\b(?:PATH|HOME|SHELL|GITEA_TOKEN|NPM_TOKEN)=/;
const RAW_LOG_PATTERN = /\b(?:raw log|raw stdout|raw stderr|full command output|jsonl sidecar)\b/i;
const PROVIDER_PRIVATE_PATTERN = /\b(?:provider_private|raw_provider_payload|provider-private)\b/i;
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "installed_tool_truth",
  "capability_truth",
  "producer_truth",
  "audit_judgment",
  "work_judgment",
  "forge_facts",
  "execution_facts",
  "attestation_truth",
  "merge_readiness",
  "release_readiness",
  "artifact_publication",
  "policy_authority",
  "security",
  "telemetry",
  "proof",
  "gate"
]);

export function validateToolchainCompatibilityFiles({ compatibilityPath }) {
  if (!compatibilityPath) {
    throw new ReleasepressError("missing_toolchain_compatibility", "--toolchain-compatibility is required");
  }
  const matrix = readJsonFile(compatibilityPath, "toolchain_compatibility");
  return validateToolchainCompatibilityMatrix({ matrix });
}

export function validateToolchainCompatibilityMatrix({ matrix }) {
  const blockers = [];
  validateMatrixShape(matrix, blockers);
  const ok = blockers.length === 0;
  return {
    ok,
    type: "releasepress_toolchain_compatibility_validate",
    schema_version: 1,
    status: ok ? "pass" : "fail",
    authority: "toolchain_compatibility_policy_validation_only",
    matrix: summarizeMatrix(matrix),
    checks: {
      matrix_schema: !blockers.some((blocker) => blocker.section === "matrix_schema"),
      required_tools: !blockers.some((blocker) => blocker.section === "required_tools"),
      promotion_policy: !blockers.some((blocker) => blocker.section === "promotion_policy"),
      stale_path_policy: !blockers.some((blocker) => blocker.section === "stale_path_policy"),
      downstream_smoke_policy: !blockers.some((blocker) => blocker.section === "downstream_smoke_policy"),
      privacy: !blockers.some((blocker) => blocker.section === "privacy"),
      authority: !blockers.some((blocker) => blocker.section === "authority")
    },
    blockers,
    advisories: [],
    not_authority_for: [...REQUIRED_NOT_AUTHORITY_FOR]
  };
}

export function resolveToolchainCompatibilityPolicy({
  config,
  sourceRoot = process.cwd(),
  toolchainCompatibility = null
}) {
  const policy = config.toolchain_compatibility ?? {};
  const matrixRef = toolchainCompatibility ?? policy.matrix ?? null;
  if (!matrixRef) {
    if (policy.required) {
      throw new ReleasepressError("toolchain_compatibility_required", "Toolchain compatibility evidence is required for provider delivery");
    }
    return {
      ok: true,
      type: "releasepress_toolchain_compatibility_gate",
      status: "skipped",
      reason: "toolchain_compatibility_not_configured"
    };
  }

  const matrixPath = resolveCompatibilityPath({ value: matrixRef, config, sourceRoot });
  const result = validateToolchainCompatibilityFiles({ compatibilityPath: matrixPath });
  if (!result.ok) {
    throw new ReleasepressError("toolchain_compatibility_invalid", "Toolchain compatibility evidence did not satisfy Releasepress policy", {
      status: result.status,
      blockers: result.blockers
    });
  }
  return {
    ok: true,
    type: "releasepress_toolchain_compatibility_gate",
    status: "passed",
    matrix: result.matrix,
    checks: result.checks
  };
}

function validateMatrixShape(matrix, blockers) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    addBlocker(blockers, "matrix_schema", "toolchain_compatibility_matrix_invalid");
    return;
  }
  hasOnlyKeys(matrix, [
    "type",
    "schema_version",
    "id",
    "created_at",
    "producer",
    "authority",
    "scope",
    "tool_rows",
    "promotion_policy",
    "stale_path_policy",
    "downstream_smoke_policy",
    "not_authority_for"
  ], "toolchain_compatibility_matrix", blockers, "matrix_schema");
  addMissing(matrix, [
    "type",
    "schema_version",
    "id",
    "producer",
    "authority",
    "scope",
    "tool_rows",
    "promotion_policy",
    "stale_path_policy",
    "downstream_smoke_policy",
    "not_authority_for"
  ], "toolchain_compatibility_matrix", blockers, "matrix_schema");
  if (matrix.type !== TOOLCHAIN_COMPATIBILITY_MATRIX_TYPE) addBlocker(blockers, "matrix_schema", "type_invalid");
  if (matrix.schema_version !== 1) addBlocker(blockers, "matrix_schema", "schema_version_invalid");
  if (matrix.authority !== TOOLCHAIN_COMPATIBILITY_AUTHORITY) addBlocker(blockers, "authority", "authority_invalid");
  validateProducer(matrix.producer, blockers);
  validateScope(matrix.scope, blockers);
  validateToolRows(matrix.tool_rows, matrix.scope, blockers);
  validatePromotionPolicy(matrix.promotion_policy, blockers);
  validateStalePathPolicy(matrix.stale_path_policy, blockers);
  validateDownstreamSmokePolicy(matrix.downstream_smoke_policy, blockers);
  validateNotAuthorityFor(matrix.not_authority_for, blockers);
  validateUnsafeContent(matrix, blockers);
}

function validateProducer(producer, blockers) {
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) {
    addBlocker(blockers, "matrix_schema", "producer_invalid");
    return;
  }
  if (producer.id !== "atteware") addBlocker(blockers, "matrix_schema", "producer_invalid");
  validateId(producer.component, "$.producer.component", blockers, "matrix_schema");
  validateId(producer.version, "$.producer.version", blockers, "matrix_schema");
}

function validateScope(scope, blockers) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    addBlocker(blockers, "matrix_schema", "scope_invalid");
    return;
  }
  validateId(scope.toolchain_id, "$.scope.toolchain_id", blockers, "matrix_schema");
  validateId(scope.policy_profile, "$.scope.policy_profile", blockers, "matrix_schema");
  validateIdArray(scope.required_tool_ids, "$.scope.required_tool_ids", blockers, "matrix_schema", { min: 1 });
  validateIdArray(scope.optional_tool_ids, "$.scope.optional_tool_ids", blockers, "matrix_schema");
}

function validateToolRows(rows, scope, blockers) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32) {
    addBlocker(blockers, "matrix_schema", "tool_rows_invalid");
    return;
  }
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      addBlocker(blockers, "matrix_schema", `tool_row_invalid:${index}`);
      continue;
    }
    validateId(row.tool_id, `$.tool_rows[${index}].tool_id`, blockers, "matrix_schema");
    if (seen.has(row.tool_id)) addBlocker(blockers, "matrix_schema", `tool_row_duplicate:${row.tool_id}`);
    seen.add(row.tool_id);
    if (!REPO_PATTERN.test(String(row.owner_repo ?? ""))) addBlocker(blockers, "matrix_schema", `owner_repo_invalid:${index}`);
    if (typeof row.required !== "boolean") addBlocker(blockers, "matrix_schema", `required_invalid:${index}`);
    validateInstalledCli(row.installed_cli, index, blockers);
    validateVersion(row.version, index, blockers);
    validateCapabilityManifest(row.capability_manifest, index, blockers);
    validateContracts(row.contracts, index, blockers);
    validatePromotion(row.promotion, index, blockers);
    validateSmoke(row.smoke, index, blockers);
    if (row.owner_hint && row.owner_hint !== row.owner_repo) addBlocker(blockers, "matrix_schema", `owner_hint_mismatch:${index}`);
  }
  for (const id of scope?.required_tool_ids ?? []) {
    if (!seen.has(id)) addBlocker(blockers, "required_tools", `required_tool_missing_row:${id}`);
  }
}

function validateInstalledCli(installedCli, index, blockers) {
  if (!installedCli || typeof installedCli !== "object" || Array.isArray(installedCli)) {
    addBlocker(blockers, "matrix_schema", `installed_cli_invalid:${index}`);
    return;
  }
  validateId(installedCli.binary, `$.tool_rows[${index}].installed_cli.binary`, blockers, "matrix_schema");
  validateId(installedCli.path_label, `$.tool_rows[${index}].installed_cli.path_label`, blockers, "matrix_schema");
}

function validateVersion(version, index, blockers) {
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    addBlocker(blockers, "matrix_schema", `version_invalid:${index}`);
    return;
  }
  if (!["installed_cli", "capability_manifest", "not_applicable"].includes(version.source)) addBlocker(blockers, "matrix_schema", `version_source_invalid:${index}`);
  if (!["must_report", "optional_report"].includes(version.policy)) addBlocker(blockers, "matrix_schema", `version_policy_invalid:${index}`);
}

function validateCapabilityManifest(manifest, index, blockers) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    addBlocker(blockers, "matrix_schema", `capability_manifest_invalid:${index}`);
    return;
  }
  if (typeof manifest.required !== "boolean") addBlocker(blockers, "matrix_schema", `capability_manifest_required_invalid:${index}`);
  if (manifest.digest_algorithm !== "sha256") addBlocker(blockers, "matrix_schema", `capability_manifest_digest_algorithm_invalid:${index}`);
  if (manifest.required === true && manifest.digest_policy !== "runtime_required") {
    addBlocker(blockers, "promotion_policy", `capability_manifest_digest_policy_invalid:${index}`);
  }
}

function validateContracts(contracts, index, blockers) {
  if (!Array.isArray(contracts) || contracts.length < 1 || contracts.length > 24) {
    addBlocker(blockers, "matrix_schema", `contracts_invalid:${index}`);
    return;
  }
  for (const [contractIndex, contract] of contracts.entries()) {
    validateId(contract?.type, `$.tool_rows[${index}].contracts[${contractIndex}].type`, blockers, "matrix_schema");
    if (!Number.isInteger(contract?.version) || contract.version < 1) {
      addBlocker(blockers, "matrix_schema", `contract_version_invalid:${index}:${contractIndex}`);
    }
    if (!["standard", "producer", "consumer", "validator", "sink"].includes(contract?.role)) {
      addBlocker(blockers, "matrix_schema", `contract_role_invalid:${index}:${contractIndex}`);
    }
  }
}

function validatePromotion(promotion, index, blockers) {
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) {
    addBlocker(blockers, "matrix_schema", `promotion_invalid:${index}`);
    return;
  }
  if (promotion.local_source === "lanes_root" || promotion.active_path_label === "sunsetted_lanes_root") {
    addBlocker(blockers, "stale_path_policy", `stale_lane_path_as_active_source:${index}`);
  }
  validateIdArray(promotion.legacy_denied_path_labels ?? [], `$.tool_rows[${index}].promotion.legacy_denied_path_labels`, blockers, "matrix_schema");
}

function validateSmoke(smoke, index, blockers) {
  if (!smoke || typeof smoke !== "object" || Array.isArray(smoke)) {
    addBlocker(blockers, "matrix_schema", `smoke_invalid:${index}`);
    return;
  }
  if (typeof smoke.required !== "boolean") addBlocker(blockers, "matrix_schema", `smoke_required_invalid:${index}`);
  validateId(smoke.capability_ref, `$.tool_rows[${index}].smoke.capability_ref`, blockers, "matrix_schema");
  validateId(smoke.command_ref, `$.tool_rows[${index}].smoke.command_ref`, blockers, "matrix_schema");
}

function validatePromotionPolicy(policy, blockers) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    addBlocker(blockers, "promotion_policy", "promotion_policy_invalid");
    return;
  }
  for (const key of ["active_source_required", "promoted_cli_path_label_required", "capability_manifest_digest_required", "installed_version_required"]) {
    if (policy[key] !== true) addBlocker(blockers, "promotion_policy", `${key}_not_true`);
  }
  if (policy.shell_execution_policy !== "argv_only_no_shell") addBlocker(blockers, "promotion_policy", "shell_execution_policy_invalid");
}

function validateStalePathPolicy(policy, blockers) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    addBlocker(blockers, "stale_path_policy", "stale_path_policy_invalid");
    return;
  }
  if (policy.policy !== "block") addBlocker(blockers, "stale_path_policy", "stale_path_policy_not_block");
  if (!Array.isArray(policy.denied_path_labels) || !policy.denied_path_labels.includes("sunsetted_lanes_root")) {
    addBlocker(blockers, "stale_path_policy", "sunsetted_lanes_root_not_denied");
  }
  validateIdArray(policy.denied_path_labels ?? [], "$.stale_path_policy.denied_path_labels", blockers, "stale_path_policy");
  validateIdArray(policy.denied_path_patterns ?? [], "$.stale_path_policy.denied_path_patterns", blockers, "stale_path_policy");
}

function validateDownstreamSmokePolicy(policy, blockers) {
  if (!Array.isArray(policy) || policy.length < 1 || policy.length > 32) {
    addBlocker(blockers, "downstream_smoke_policy", "downstream_smoke_policy_invalid");
    return;
  }
  for (const [index, entry] of policy.entries()) {
    validateId(entry?.trigger, `$.downstream_smoke_policy[${index}].trigger`, blockers, "downstream_smoke_policy");
    validateId(entry?.smoke_ref, `$.downstream_smoke_policy[${index}].smoke_ref`, blockers, "downstream_smoke_policy");
    if (typeof entry?.required !== "boolean") addBlocker(blockers, "downstream_smoke_policy", `required_invalid:${index}`);
    if (!REPO_PATTERN.test(String(entry?.owner_repo_hint ?? ""))) addBlocker(blockers, "downstream_smoke_policy", `owner_repo_hint_invalid:${index}`);
  }
}

function validateNotAuthorityFor(values, blockers) {
  if (!Array.isArray(values)) {
    addBlocker(blockers, "authority", "not_authority_for_invalid");
    return;
  }
  for (const required of REQUIRED_NOT_AUTHORITY_FOR) {
    if (!values.includes(required)) addBlocker(blockers, "authority", `not_authority_for_missing:${required}`);
  }
}

function validateUnsafeContent(value, blockers, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateUnsafeContent(item, blockers, pathParts.concat(String(index))));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const keyPath = pathParts.concat(key).join(".");
      if (FORBIDDEN_AUTHORITY_KEYS.has(key) && keyPath !== "not_authority_for" && !keyPath.startsWith("not_authority_for.")) {
        addBlocker(blockers, "authority", `authority_overclaim:${keyPath}`);
      }
      validateUnsafeContent(child, blockers, pathParts.concat(key));
    }
    return;
  }
  if (typeof value !== "string") return;
  const keyPath = pathParts.join(".");
  if (UNSAFE_LOCAL_PATH_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_local_path:${keyPath}`);
  if (CREDENTIAL_URL_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_credential_url:${keyPath}`);
  if (TOKEN_LIKE_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_token_like_text:${keyPath}`);
  if (PROMPT_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_prompt_text:${keyPath}`);
  if (ENV_DUMP_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_env_dump:${keyPath}`);
  if (RAW_LOG_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_raw_log:${keyPath}`);
  if (PROVIDER_PRIVATE_PATTERN.test(value)) addBlocker(blockers, "privacy", `unsafe_provider_private_payload:${keyPath}`);
}

function summarizeMatrix(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return {
      id: null,
      policy_profile: null,
      required_tool_count: 0,
      optional_tool_count: 0,
      tool_row_count: 0
    };
  }
  return {
    id: safeRef(matrix.id),
    policy_profile: safeRef(matrix.scope?.policy_profile),
    required_tool_count: Array.isArray(matrix.scope?.required_tool_ids) ? matrix.scope.required_tool_ids.length : 0,
    optional_tool_count: Array.isArray(matrix.scope?.optional_tool_ids) ? matrix.scope.optional_tool_ids.length : 0,
    tool_row_count: Array.isArray(matrix.tool_rows) ? matrix.tool_rows.length : 0,
    stale_path_policy: safeRef(matrix.stale_path_policy?.policy),
    downstream_smoke_count: Array.isArray(matrix.downstream_smoke_policy) ? matrix.downstream_smoke_policy.length : 0
  };
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ReleasepressError(`${label}_json_invalid`, `${label} must be readable JSON`);
  }
}

function resolveCompatibilityPath({ value, config, sourceRoot }) {
  const base = config.config_path ? path.dirname(config.config_path) : sourceRoot;
  return path.resolve(base, value);
}

function addMissing(value, keys, label, blockers, section) {
  if (!value || typeof value !== "object") return;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) addBlocker(blockers, section, `${label}_missing:${key}`);
  }
}

function hasOnlyKeys(value, keys, label, blockers, section) {
  if (!value || typeof value !== "object") return;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addBlocker(blockers, section, `${label}_unexpected:${key}`);
  }
}

function validateId(value, pathLabel, blockers, section) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !ID_PATTERN.test(value)) {
    addBlocker(blockers, section, `id_invalid:${pathLabel}`);
  }
}

function validateIdArray(value, pathLabel, blockers, section, options = {}) {
  if (!Array.isArray(value) || value.length < (options.min ?? 0) || value.length > 32) {
    addBlocker(blockers, section, `array_invalid:${pathLabel}`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    validateId(item, `${pathLabel}[${index}]`, blockers, section);
    if (seen.has(item)) addBlocker(blockers, section, `array_duplicate:${pathLabel}:${item}`);
    seen.add(item);
  }
}

function safeRef(value) {
  const normalized = String(value ?? "");
  return ID_PATTERN.test(normalized) && normalized.length <= 160 ? normalized : null;
}

function addBlocker(blockers, section, code) {
  blockers.push({ section, code });
}
