import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";

export const RELEASE_EVIDENCE_MANIFEST_TYPE = "release.evidence_manifest.v1";
export const RELEASE_EVIDENCE_AUTHORITY = "release_evidence_binding_only";
export const DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS = ["audit_bundle", "verification_summary"];
export const RELEASE_EVIDENCE_KINDS = [
  "audit_bundle",
  "verification_summary",
  "customer_safe_report",
  "attestation",
  "replay_summary"
];
export const RELEASE_EVIDENCE_VERIFICATION_STATUSES = [
  "pass",
  "fail",
  "blocked",
  "unavailable",
  "not_applicable"
];
export const REQUIRED_NOT_AUTHORITY_FOR = [
  "producer_truth",
  "work_judgment",
  "forge_facts",
  "execution_facts",
  "replay_execution",
  "signing_truth",
  "attestation_truth",
  "merge_readiness",
  "release_readiness",
  "artifact_publication",
  "policy_authority",
  "security",
  "telemetry"
];

const REQUIRED_FIELDS = [
  "type",
  "schema_version",
  "id",
  "created_at",
  "producer",
  "authority",
  "release_subject",
  "evidence",
  "private_artifact_exclusions",
  "privacy",
  "not_authority_for"
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/;
const SHA256_PATTERN = /^sha256:[a-fA-F0-9]{64}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+#@:-]*$/;
const REASON_PATTERN = /^[a-z][a-z0-9_:-]*$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+/-]*$/;
const PATH_TRAVERSAL_PATTERN = /(^|\/)\.\.?(?:\/|$)/;
const PATH_EMPTY_SEGMENT_PATTERN = /\/\//;
const UNSAFE_LOCAL_PATH_PATTERN = /(^|[\s"'=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/)/;
const CREDENTIAL_URL_PATTERN = /https?:\/\/[^\s/@]+:[^\s/@]+@/i;
const TOKEN_LIKE_PATTERN = /(?:\bsk-[A-Za-z0-9]{12,}|\bghp_[A-Za-z0-9_]{12,}|\btoken=|\bAuthorization:|\bapi[_-]?key\b)/i;
const PROMPT_PATTERN = /\b(?:system prompt|developer message|raw prompt)\b/i;
const ENV_DUMP_PATTERN = /\b(?:PATH|HOME|SHELL|GITEA_TOKEN|NPM_TOKEN)=/;
const RAW_LOG_PATTERN = /\b(?:raw log|raw stdout|raw stderr|full command output|jsonl sidecar)\b/i;
const PROVIDER_PRIVATE_PATTERN = /\b(?:provider_private|raw_provider_payload|provider-private)\b/i;
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "producer_truth",
  "work_judgment",
  "forge_facts",
  "execution_facts",
  "replay_execution",
  "signing_truth",
  "attestation_truth",
  "merge_readiness",
  "release_readiness",
  "artifact_publication",
  "policy_authority",
  "security",
  "telemetry",
  "judgment",
  "proof",
  "gate"
]);

export function validateReleaseEvidenceFiles({
  manifestPath,
  releaseTargetPath,
  requiredKinds = DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS
}) {
  if (!manifestPath) {
    throw new ReleasepressError("missing_manifest", "--manifest is required");
  }
  if (!releaseTargetPath) {
    throw new ReleasepressError("missing_release_target", "--release-target is required");
  }
  const manifest = readJsonFile(manifestPath, "release_evidence_manifest");
  const releaseTarget = readJsonFile(releaseTargetPath, "release_target");
  return validateReleaseEvidenceManifest({ manifest, releaseTarget, requiredKinds });
}

export function validateReleaseEvidenceManifest({
  manifest,
  releaseTarget = null,
  requiredKinds = DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS
}) {
  const blockers = [];
  validateManifestShape(manifest, blockers);
  if (releaseTarget !== null) {
    validateReleaseTargetBinding(manifest, releaseTarget, blockers);
  }
  validateRequiredEvidencePolicy(manifest, requiredKinds, blockers);
  const ok = blockers.length === 0;
  return {
    ok,
    type: "releasepress_evidence_validate",
    schema_version: 1,
    status: ok ? "pass" : "fail",
    manifest: summarizeManifest(manifest),
    checks: {
      manifest_schema: !blockers.some((blocker) => blocker.section === "manifest_schema"),
      target_binding: !blockers.some((blocker) => blocker.section === "target_binding"),
      required_evidence: !blockers.some((blocker) => blocker.section === "required_evidence"),
      privacy: !blockers.some((blocker) => blocker.section === "privacy"),
      authority: !blockers.some((blocker) => blocker.section === "authority")
    },
    required_kinds: [...requiredKinds],
    blockers,
    advisories: [],
    not_authority_for: [
      "producer_truth",
      "work_judgment",
      "forge_facts",
      "execution_facts",
      "replay_execution",
      "signing_truth",
      "attestation_truth",
      "merge_readiness",
      "release_readiness",
      "artifact_publication",
      "policy_authority",
      "security",
      "telemetry"
    ]
  };
}

function validateManifestShape(manifest, blockers) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    addBlocker(blockers, "manifest_schema", "release_evidence_manifest_invalid");
    return;
  }
  hasOnlyKeys(manifest, REQUIRED_FIELDS, "release_evidence_manifest", blockers, "manifest_schema");
  addMissing(manifest, REQUIRED_FIELDS, "release_evidence_manifest", blockers, "manifest_schema");
  if (manifest.type !== RELEASE_EVIDENCE_MANIFEST_TYPE) addBlocker(blockers, "manifest_schema", "type_invalid");
  if (manifest.schema_version !== 1) addBlocker(blockers, "manifest_schema", "schema_version_invalid");
  validateString(manifest.id, "$.id", blockers, "manifest_schema", { pattern: ID_PATTERN, max: 160 });
  validateString(manifest.created_at, "$.created_at", blockers, "manifest_schema", { pattern: ISO_PATTERN, max: 30 });
  if (manifest.authority !== RELEASE_EVIDENCE_AUTHORITY) addBlocker(blockers, "authority", "authority_invalid");
  validateProducer(manifest.producer, blockers);
  validateReleaseSubject(manifest.release_subject, blockers);
  validateEvidence(manifest.evidence, blockers);
  validatePrivateExclusions(manifest.private_artifact_exclusions, blockers);
  validatePrivacy(manifest.privacy, blockers);
  validateNotAuthorityFor(manifest.not_authority_for, blockers);
  validateUnsafeContent(manifest, blockers);
}

function validateReleaseTargetBinding(manifest, target, blockers) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    addBlocker(blockers, "target_binding", "release_target_invalid");
    return;
  }
  const subject = manifest?.release_subject;
  if (!subject || typeof subject !== "object") {
    return;
  }
  compareField(blockers, "repo", subject.repo, target.repo);
  compareField(blockers, "release_commit", subject.release_commit, target.release_commit);
  compareField(blockers, "version", subject.version, target.version);
  compareOptionalField(blockers, "tag", subject.tag, target.tag);
  compareOptionalField(blockers, "ref", subject.ref, target.ref);
  compareOptionalField(blockers, "change_ref", subject.change_ref, target.change_ref);
  const artifact = subject.artifact ?? {};
  const targetArtifact = target.artifact ?? {};
  compareField(blockers, "artifact.name", artifact.name, targetArtifact.name);
  compareField(blockers, "artifact.digest", artifact.digest, targetArtifact.digest);
  compareField(blockers, "artifact.digest_algorithm", artifact.digest_algorithm, targetArtifact.digest_algorithm);
  compareField(blockers, "artifact.media_type", artifact.media_type, targetArtifact.media_type);
  if (targetArtifact.path !== undefined || artifact.path !== undefined) {
    compareOptionalField(blockers, "artifact.path", artifact.path, targetArtifact.path);
  }
  if (targetArtifact.id !== undefined || artifact.id !== undefined) {
    compareOptionalField(blockers, "artifact.id", artifact.id, targetArtifact.id);
  }
  if (targetArtifact.public !== true) {
    addBlocker(blockers, "target_binding", "release_target_artifact_not_public");
  }
}

function validateRequiredEvidencePolicy(manifest, requiredKinds, blockers) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.evidence)) {
    return;
  }
  const seen = new Map(manifest.evidence.map((entry) => [entry?.kind, entry]));
  for (const kind of requiredKinds) {
    const entry = seen.get(kind);
    if (!entry) {
      addBlocker(blockers, "required_evidence", `evidence_kind_missing:${kind}`);
      continue;
    }
    if (entry.verification_status !== "pass") {
      addBlocker(blockers, "required_evidence", `required_evidence_status_not_pass:${kind}`);
    }
  }
  for (const entry of manifest.evidence) {
    if (["fail", "blocked", "unavailable"].includes(entry?.verification_status)) {
      addBlocker(blockers, "required_evidence", `evidence_status_blocking:${entry?.kind ?? "unknown"}`);
    }
  }
}

function validateProducer(producer, blockers) {
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) {
    addBlocker(blockers, "manifest_schema", "producer_invalid");
    return;
  }
  hasOnlyKeys(producer, ["id", "component", "version"], "producer", blockers, "manifest_schema");
  addMissing(producer, ["id", "component"], "producer", blockers, "manifest_schema");
  validateString(producer.id, "$.producer.id", blockers, "manifest_schema", { pattern: TOOL_PATTERN, max: 64 });
  validateString(producer.component, "$.producer.component", blockers, "manifest_schema", { pattern: REF_PATTERN });
  if (producer.version != null) {
    validateString(producer.version, "$.producer.version", blockers, "manifest_schema", { pattern: REF_PATTERN });
  }
}

function validateReleaseSubject(subject, blockers) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    addBlocker(blockers, "manifest_schema", "release_subject_invalid");
    return;
  }
  hasOnlyKeys(subject, ["repo", "release_commit", "version", "tag", "ref", "change_ref", "artifact"], "release_subject", blockers, "manifest_schema");
  addMissing(subject, ["repo", "release_commit", "version", "artifact"], "release_subject", blockers, "manifest_schema");
  validateString(subject.repo, "$.release_subject.repo", blockers, "manifest_schema", { pattern: REPO_PATTERN, max: 160 });
  validateString(subject.release_commit, "$.release_subject.release_commit", blockers, "manifest_schema", { pattern: SHA_PATTERN, min: 40, max: 64 });
  validateString(subject.version, "$.release_subject.version", blockers, "manifest_schema", { pattern: REF_PATTERN });
  if (subject.tag != null) validateString(subject.tag, "$.release_subject.tag", blockers, "manifest_schema", { pattern: REF_PATTERN });
  if (subject.ref != null) validateString(subject.ref, "$.release_subject.ref", blockers, "manifest_schema", { pattern: REF_PATTERN });
  if (subject.change_ref != null) validateString(subject.change_ref, "$.release_subject.change_ref", blockers, "manifest_schema", { pattern: REF_PATTERN });
  validateArtifact(subject.artifact, blockers);
}

function validateArtifact(artifact, blockers) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    addBlocker(blockers, "manifest_schema", "release_artifact_invalid");
    return;
  }
  hasOnlyKeys(artifact, ["name", "path", "id", "digest", "digest_algorithm", "media_type", "public"], "release_artifact", blockers, "manifest_schema");
  addMissing(artifact, ["name", "digest", "digest_algorithm", "media_type", "public"], "release_artifact", blockers, "manifest_schema");
  validateSafePath(artifact.name, "$.release_subject.artifact.name", blockers);
  if (artifact.path != null) validateSafePath(artifact.path, "$.release_subject.artifact.path", blockers);
  if (artifact.id != null) validateString(artifact.id, "$.release_subject.artifact.id", blockers, "manifest_schema", { pattern: ID_PATTERN, max: 160 });
  validateString(artifact.digest, "$.release_subject.artifact.digest", blockers, "manifest_schema", { pattern: SHA256_PATTERN, min: 71, max: 71 });
  if (artifact.digest_algorithm !== "sha256") addBlocker(blockers, "manifest_schema", "release_artifact_digest_algorithm_not_sha256");
  validateString(artifact.media_type, "$.release_subject.artifact.media_type", blockers, "manifest_schema", { pattern: MEDIA_TYPE_PATTERN, max: 120 });
  if (artifact.public !== true) addBlocker(blockers, "privacy", "release_artifact_not_public");
}

function validateEvidence(evidence, blockers) {
  if (!Array.isArray(evidence)) {
    addBlocker(blockers, "manifest_schema", "evidence_not_array");
    return;
  }
  if (evidence.length < 1 || evidence.length > 32) addBlocker(blockers, "manifest_schema", "evidence_length_invalid");
  const refs = new Set();
  evidence.forEach((entry, index) => {
    const path = `$.evidence[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addBlocker(blockers, "manifest_schema", `evidence_entry_invalid:${index}`);
      return;
    }
    hasOnlyKeys(entry, ["kind", "producer", "ref", "digest", "digest_algorithm", "media_type", "verification_status", "policy_profile", "public", "summary", "reason_codes"], "evidence_entry", blockers, "manifest_schema");
    addMissing(entry, ["kind", "producer", "ref", "digest", "digest_algorithm", "media_type", "verification_status", "policy_profile", "public", "summary"], "evidence_entry", blockers, "manifest_schema");
    if (!RELEASE_EVIDENCE_KINDS.includes(entry.kind)) addBlocker(blockers, "manifest_schema", `evidence_kind_invalid:${index}`);
    validateString(entry.producer, `${path}.producer`, blockers, "manifest_schema", { pattern: TOOL_PATTERN, max: 64 });
    validateSafePath(entry.ref, `${path}.ref`, blockers);
    validateString(entry.digest, `${path}.digest`, blockers, "manifest_schema", { pattern: SHA256_PATTERN, min: 71, max: 71 });
    if (entry.digest_algorithm !== "sha256") addBlocker(blockers, "manifest_schema", `evidence_digest_algorithm_not_sha256:${index}`);
    validateString(entry.media_type, `${path}.media_type`, blockers, "manifest_schema", { pattern: MEDIA_TYPE_PATTERN, max: 120 });
    if (!RELEASE_EVIDENCE_VERIFICATION_STATUSES.includes(entry.verification_status)) {
      addBlocker(blockers, "manifest_schema", `evidence_verification_status_invalid:${index}`);
    }
    validateString(entry.policy_profile, `${path}.policy_profile`, blockers, "manifest_schema", { pattern: REF_PATTERN });
    if (entry.public !== true) addBlocker(blockers, "privacy", `evidence_entry_not_public:${index}`);
    validateString(entry.summary, `${path}.summary`, blockers, "manifest_schema", { max: 420 });
    validateReasonCodes(entry.reason_codes, `${path}.reason_codes`, blockers);
    if (refs.has(entry.ref)) addBlocker(blockers, "manifest_schema", `evidence_ref_duplicate:${entry.ref}`);
    refs.add(entry.ref);
  });
}

function validatePrivateExclusions(exclusions, blockers) {
  if (!Array.isArray(exclusions)) {
    addBlocker(blockers, "manifest_schema", "private_artifact_exclusions_not_array");
    return;
  }
  if (exclusions.length > 32) addBlocker(blockers, "manifest_schema", "private_artifact_exclusions_length_invalid");
  exclusions.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addBlocker(blockers, "manifest_schema", `private_artifact_exclusion_invalid:${index}`);
      return;
    }
    hasOnlyKeys(entry, ["ref", "reason"], "private_artifact_exclusion", blockers, "manifest_schema");
    addMissing(entry, ["ref", "reason"], "private_artifact_exclusion", blockers, "manifest_schema");
    validateSafePath(entry.ref, `$.private_artifact_exclusions[${index}].ref`, blockers);
    validateString(entry.reason, `$.private_artifact_exclusions[${index}].reason`, blockers, "manifest_schema", { max: 96, pattern: REASON_PATTERN });
  });
}

function validatePrivacy(privacy, blockers) {
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) {
    addBlocker(blockers, "privacy", "privacy_invalid");
    return;
  }
  for (const key of ["contains_private_keys", "contains_private_artifacts", "contains_raw_logs", "contains_env_dump", "contains_prompts", "contains_secrets", "contains_provider_private_payloads"]) {
    if (privacy[key] !== false) addBlocker(blockers, "privacy", `privacy_${key}_must_be_false`);
  }
}

function validateNotAuthorityFor(value, blockers) {
  if (!Array.isArray(value)) {
    addBlocker(blockers, "authority", "not_authority_for_not_array");
    return;
  }
  const seen = new Set(value);
  for (const field of REQUIRED_NOT_AUTHORITY_FOR) {
    if (!seen.has(field)) addBlocker(blockers, "authority", `not_authority_for_missing:${field}`);
  }
}

function validateReasonCodes(value, path, blockers) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    addBlocker(blockers, "manifest_schema", `${path}_not_array`);
    return;
  }
  if (value.length > 32) addBlocker(blockers, "manifest_schema", `${path}_length_invalid`);
  const seen = new Set();
  value.forEach((item, index) => {
    validateString(item, `${path}[${index}]`, blockers, "manifest_schema", { max: 96, pattern: REASON_PATTERN });
    if (seen.has(item)) addBlocker(blockers, "manifest_schema", `${path}_duplicate:${item}`);
    seen.add(item);
  });
}

function validateUnsafeContent(value, blockers) {
  walk(value, (node, pathParts) => {
    const key = pathParts[pathParts.length - 1] ?? "";
    const keyPath = pathParts.join(".");
    if (FORBIDDEN_AUTHORITY_KEYS.has(key) && keyPath !== "not_authority_for" && !keyPath.startsWith("not_authority_for.")) {
      addBlocker(blockers, "authority", `authority_claim_field:${keyPath}`);
    }
    if (/private_?key/i.test(key) && node !== false) addBlocker(blockers, "privacy", `unsafe_private_key_field:${keyPath}`);
    if (typeof node !== "string") return;
    if (UNSAFE_LOCAL_PATH_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_local_path:${keyPath}`);
    if (CREDENTIAL_URL_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_credential_url:${keyPath}`);
    if (TOKEN_LIKE_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_token_like_text:${keyPath}`);
    if (PROMPT_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_prompt_text:${keyPath}`);
    if (ENV_DUMP_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_env_dump:${keyPath}`);
    if (RAW_LOG_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_raw_log:${keyPath}`);
    if (PROVIDER_PRIVATE_PATTERN.test(node)) addBlocker(blockers, "privacy", `unsafe_provider_private_payload:${keyPath}`);
  });
}

function compareField(blockers, field, expected, actual) {
  if (expected !== actual) {
    addBlocker(blockers, "target_binding", `target_mismatch:${field}`, {
      field,
      expected_present: expected !== undefined && expected !== null,
      actual_present: actual !== undefined && actual !== null
    });
  }
}

function compareOptionalField(blockers, field, expected, actual) {
  if (expected !== undefined && actual !== undefined && expected !== actual) {
    compareField(blockers, field, expected, actual);
  }
}

function validateSafePath(value, label, blockers) {
  validateString(value, label, blockers, "manifest_schema", { pattern: SAFE_PATH_PATTERN });
  if (typeof value !== "string") return;
  if (PATH_TRAVERSAL_PATTERN.test(value)) addBlocker(blockers, "privacy", `${label}_path_traversal`);
  if (PATH_EMPTY_SEGMENT_PATTERN.test(value)) addBlocker(blockers, "privacy", `${label}_path_empty_segment`);
}

function validateString(value, label, blockers, section, options = {}) {
  if (typeof value !== "string") {
    addBlocker(blockers, section, `${label}_not_string`);
    return;
  }
  const min = options.min ?? 1;
  const max = options.max ?? 220;
  if (value.length < min || value.length > max) addBlocker(blockers, section, `${label}_length_invalid`);
  if (options.pattern && !options.pattern.test(value)) addBlocker(blockers, section, `${label}_pattern_invalid`);
}

function hasOnlyKeys(value, allowed, label, blockers, section) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addBlocker(blockers, section, `${label}_unknown_field:${key}`);
  }
}

function addMissing(value, fields, label, blockers, section) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) addBlocker(blockers, section, `${label}_missing_field:${field}`);
  }
}

function addBlocker(blockers, section, code, details = {}) {
  blockers.push({
    code,
    section,
    severity: "blocking",
    ...details
  });
}

function summarizeManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return {
      type: null,
      id: null,
      producer_id: null,
      release_subject: null
    };
  }
  return {
    type: manifest.type ?? null,
    id: manifest.id ?? null,
    producer_id: manifest.producer?.id ?? null,
    release_subject: {
      repo: manifest.release_subject?.repo ?? null,
      release_commit: manifest.release_subject?.release_commit ?? null,
      version: manifest.release_subject?.version ?? null,
      artifact_digest: manifest.release_subject?.artifact?.digest ?? null
    }
  };
}

export function resolveEvidencePath({ value, config, sourceRoot }) {
  if (path.isAbsolute(value)) {
    return value;
  }
  const base = config.config_path ? path.dirname(config.config_path) : sourceRoot;
  return path.resolve(base, value);
}

function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError(`${label}_missing`, `${label} file does not exist`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError(`${label}_invalid_json`, `${label} file is not valid JSON`, {
      reason: error.message
    });
  }
}

function walk(value, visit, pathParts = []) {
  visit(value, pathParts);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, pathParts.concat(String(index))));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visit, pathParts.concat(key));
    }
  }
}
