import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";
import { validateReleaseEvidenceManifest } from "./evidence-manifest.js";

export const RELEASE_EVIDENCE_BUNDLE_TYPE = "atteway.release_evidence_bundle.v1";
export const RELEASE_EVIDENCE_BUNDLE_AUTHORITY = "release_evidence_bundle_manifest_only";
export const REQUIRED_RELEASE_BUNDLE_ARTIFACTS = [
  "release_target",
  "release_evidence_manifest",
  "release_ready_evaluation",
  "quality_gate",
  "redaction_manifest"
];

const SHA256_PATTERN = /^sha256:[a-fA-F0-9]{64}$/;
const SHA_PATTERN = /^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/;
const SAFE_REL_PATTERN = /^(?!.*(?:^|\/\.\.?)(?:\/|$))(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/+#@:-]{0,239}$/;
const UNSAFE_LOCAL_PATH_PATTERN = /(^|[\s"'=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/)/;
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

const REQUIRED_NOT_AUTHORITY_FOR = [
  "producer_truth",
  "work_judgment_truth",
  "forge_truth",
  "execution_truth",
  "replay_execution",
  "signing_truth",
  "attestation_truth",
  "merge_readiness",
  "release_readiness",
  "artifact_publication",
  "releasepress_authority",
  "policy_authority",
  "security",
  "telemetry"
];

export function validateReleaseEvidenceBundleFiles({ bundlePath }) {
  if (!bundlePath) {
    throw new ReleasepressError("missing_evidence_bundle", "--evidence-bundle is required");
  }
  return validateReleaseEvidenceBundle({ bundleRoot: bundlePath });
}

export function validateReleaseEvidenceBundle({ bundleRoot }) {
  const blockers = [];
  const root = path.resolve(bundleRoot ?? ".");
  const rootStat = statRoot(root, blockers);
  if (!rootStat.ok) return result({ manifest: null, blockers });

  const manifest = readJson(path.join(root, "manifest.json"), "release_bundle_manifest", blockers);
  validateManifestShape(manifest, blockers);
  validateArtifactDigests(root, manifest, blockers);

  const artifacts = artifactMap(manifest);
  for (const kind of REQUIRED_RELEASE_BUNDLE_ARTIFACTS) {
    if (!artifacts.has(kind)) addBlocker(blockers, "required_artifact", `bundle_artifact_missing:${kind}`);
  }

  const releaseTarget = readArtifactJson(root, artifacts.get("release_target"), "release_target", blockers);
  const releaseManifest = readArtifactJson(root, artifacts.get("release_evidence_manifest"), "release_evidence_manifest", blockers);
  const releaseReady = readArtifactJson(root, artifacts.get("release_ready_evaluation"), "release_ready_evaluation", blockers);
  const qualityGate = readArtifactJson(root, artifacts.get("quality_gate"), "quality_gate", blockers);
  const redaction = readArtifactJson(root, artifacts.get("redaction_manifest"), "redaction_manifest", blockers);

  if (releaseManifest && releaseTarget) {
    const manifestValidation = validateReleaseEvidenceManifest({
      manifest: releaseManifest,
      releaseTarget,
      requiredKinds: ["audit_bundle", "verification_summary"]
    });
    for (const blocker of manifestValidation.blockers ?? []) {
      addBlocker(blockers, "release_evidence_manifest", `release_manifest:${blocker.code}`);
    }
  }

  validateTargetConsistency({ bundleManifest: manifest, releaseTarget, releaseManifest, blockers });
  if (!releaseReady || releaseReady.status !== "pass" || releaseReady.satisfies_policy !== true) {
    addBlocker(blockers, "release_ready", "release_ready_policy_not_satisfied");
  }
  if (!qualityGate || qualityGate.ok !== true || qualityGate.status === "fail") {
    addBlocker(blockers, "quality_gate", "quality_gate_not_satisfied");
  }
  if (!redaction || redaction.profile !== "customer_safe" || redaction.public_paths_only !== true) {
    addBlocker(blockers, "redaction", "redaction_manifest_invalid");
  }
  validateUnsafeContent({ manifest, releaseTarget, releaseManifest, releaseReady, qualityGate, redaction }, blockers);

  return result({ manifest, blockers });
}

export function assertReleaseEvidenceBundlePolicy({ bundlePath }) {
  const validation = validateReleaseEvidenceBundleFiles({ bundlePath });
  if (!validation.ok) {
    throw new ReleasepressError("release_evidence_bundle_invalid", "Release evidence bundle did not satisfy Releasepress policy", {
      status: validation.status,
      blockers: validation.blockers
    });
  }
  return {
    ok: true,
    type: "releasepress_release_evidence_bundle_gate",
    status: "passed",
    bundle: validation.bundle,
    checks: validation.checks
  };
}

function statRoot(root, blockers) {
  if (!fs.existsSync(root)) {
    addBlocker(blockers, "bundle_root", "bundle_missing");
    return { ok: false };
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    addBlocker(blockers, "bundle_root", "bundle_symlink");
    return { ok: false };
  }
  if (!stat.isDirectory()) {
    addBlocker(blockers, "bundle_root", "bundle_not_directory");
    return { ok: false };
  }
  return { ok: true };
}

function result({ manifest, blockers }) {
  const uniqueBlockers = uniqueByCode(blockers);
  const ok = uniqueBlockers.length === 0;
  return {
    ok,
    type: "releasepress_evidence_bundle_validate",
    schema_version: 1,
    status: ok ? "pass" : "fail",
    bundle: summarizeBundle(manifest),
    checks: {
      manifest_schema: !uniqueBlockers.some((blocker) => blocker.section === "manifest_schema"),
      artifact_digests: !uniqueBlockers.some((blocker) => blocker.section === "artifact_digests"),
      required_artifacts: !uniqueBlockers.some((blocker) => blocker.section === "required_artifact"),
      target_binding: !uniqueBlockers.some((blocker) => blocker.section === "target_binding"),
      release_evidence_manifest: !uniqueBlockers.some((blocker) => blocker.section === "release_evidence_manifest"),
      release_ready: !uniqueBlockers.some((blocker) => blocker.section === "release_ready"),
      quality_gate: !uniqueBlockers.some((blocker) => blocker.section === "quality_gate"),
      redaction: !uniqueBlockers.some((blocker) => blocker.section === "redaction"),
      privacy: !uniqueBlockers.some((blocker) => blocker.section === "privacy")
    },
    blockers: uniqueBlockers,
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
    addBlocker(blockers, "manifest_schema", "release_bundle_manifest_invalid");
    return;
  }
  for (const field of ["type", "schema_version", "authority", "target", "release_subject", "artifacts", "not_authority_for"]) {
    if (!Object.hasOwn(manifest, field)) addBlocker(blockers, "manifest_schema", `release_bundle_missing_field:${field}`);
  }
  if (manifest.type !== RELEASE_EVIDENCE_BUNDLE_TYPE) addBlocker(blockers, "manifest_schema", "release_bundle_type_invalid");
  if (manifest.schema_version !== 1) addBlocker(blockers, "manifest_schema", "release_bundle_schema_version_invalid");
  if (manifest.authority !== RELEASE_EVIDENCE_BUNDLE_AUTHORITY) addBlocker(blockers, "manifest_schema", "release_bundle_authority_invalid");
  if (!manifest.target || typeof manifest.target !== "object" || Array.isArray(manifest.target)) addBlocker(blockers, "target_binding", "release_bundle_target_invalid");
  else {
    if (typeof manifest.target.repo !== "string") addBlocker(blockers, "target_binding", "release_bundle_target_repo_invalid");
    if (!SHA_PATTERN.test(manifest.target.head_sha ?? "")) addBlocker(blockers, "target_binding", "release_bundle_target_head_sha_invalid");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 64) addBlocker(blockers, "manifest_schema", "release_bundle_artifacts_invalid");
  validateNotAuthorityFor(manifest.not_authority_for, blockers);
}

function validateNotAuthorityFor(value, blockers) {
  if (!Array.isArray(value)) {
    addBlocker(blockers, "manifest_schema", "release_bundle_not_authority_for_invalid");
    return;
  }
  const seen = new Set(value);
  for (const field of REQUIRED_NOT_AUTHORITY_FOR) {
    if (!seen.has(field)) addBlocker(blockers, "manifest_schema", `release_bundle_not_authority_for_missing:${field}`);
  }
}

function validateArtifactDigests(root, manifest, blockers) {
  if (!Array.isArray(manifest?.artifacts)) return;
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_invalid");
      continue;
    }
    if (!isSafeRelativePath(artifact.path)) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_path_unsafe", { artifact: artifact.kind ?? "unknown" });
      continue;
    }
    if (!SHA256_PATTERN.test(artifact.digest ?? "")) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_digest_invalid", { artifact: artifact.kind ?? "unknown" });
      continue;
    }
    const file = resolveInside(root, artifact.path);
    if (!file || !fs.existsSync(file)) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_missing", { artifact: artifact.kind ?? "unknown" });
      continue;
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_symlink", { artifact: artifact.kind ?? "unknown" });
      continue;
    }
    if (!stat.isFile()) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_not_file", { artifact: artifact.kind ?? "unknown" });
      continue;
    }
    if (sha256File(file) !== artifact.digest) {
      addBlocker(blockers, "artifact_digests", "bundle_artifact_digest_mismatch", { artifact: artifact.kind ?? "unknown" });
    }
  }
}

function artifactMap(manifest) {
  const map = new Map();
  for (const artifact of manifest?.artifacts ?? []) {
    if (artifact?.kind && artifact?.path && !map.has(artifact.kind)) map.set(artifact.kind, artifact);
  }
  return map;
}

function readArtifactJson(root, artifact, label, blockers) {
  if (!artifact) return null;
  const file = resolveInside(root, artifact.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    addBlocker(blockers, label, `${label}_invalid_json`);
    return null;
  }
}

function readJson(file, label, blockers) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    addBlocker(blockers, "manifest_schema", `${label}_invalid_json`);
    return null;
  }
}

function validateTargetConsistency({ bundleManifest, releaseTarget, releaseManifest, blockers }) {
  if (!bundleManifest || !releaseTarget) return;
  const target = bundleManifest.target ?? {};
  if (target.repo !== releaseTarget.repo) addBlocker(blockers, "target_binding", "release_bundle_repo_target_mismatch");
  if (target.head_sha !== releaseTarget.release_commit) addBlocker(blockers, "target_binding", "release_bundle_commit_target_mismatch");
  if (bundleManifest.release_subject && JSON.stringify(bundleManifest.release_subject) !== JSON.stringify(releaseTarget)) {
    addBlocker(blockers, "target_binding", "release_bundle_subject_target_mismatch");
  }
  if (releaseManifest?.release_subject && JSON.stringify(releaseManifest.release_subject) !== JSON.stringify(releaseTarget)) {
    addBlocker(blockers, "target_binding", "release_bundle_manifest_subject_mismatch");
  }
}

function validateUnsafeContent(value, blockers) {
  walk(value, (node, pathParts) => {
    const key = pathParts[pathParts.length - 1] ?? "";
    const keyPath = pathParts.join(".");
    if (FORBIDDEN_AUTHORITY_KEYS.has(key) && keyPath !== "not_authority_for" && !keyPath.startsWith("not_authority_for.")) {
      addBlocker(blockers, "privacy", `authority_claim_field:${keyPath}`);
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

function summarizeBundle(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return {
      type: null,
      bundle_id: null,
      target: null,
      release_subject: null
    };
  }
  return {
    type: manifest.type ?? null,
    bundle_id: manifest.bundle_id ?? null,
    target: {
      repo: manifest.target?.repo ?? null,
      head_sha: manifest.target?.head_sha ?? null,
      change_ref: manifest.target?.change_ref ?? null
    },
    release_subject: {
      repo: manifest.release_subject?.repo ?? null,
      release_commit: manifest.release_subject?.release_commit ?? null,
      version: manifest.release_subject?.version ?? null,
      artifact_digest: manifest.release_subject?.artifact?.digest ?? null
    },
    artifact_count: Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0
  };
}

function isSafeRelativePath(value) {
  return typeof value === "string" && SAFE_REL_PATTERN.test(value) && !path.isAbsolute(value) && !value.includes("\0");
}

function resolveInside(root, rel) {
  if (!isSafeRelativePath(rel)) return null;
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, rel);
  if (!file.startsWith(`${resolvedRoot}${path.sep}`) && file !== resolvedRoot) return null;
  return file;
}

function sha256File(file) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function addBlocker(blockers, section, code, details = {}) {
  blockers.push({
    code,
    section,
    severity: "blocking",
    ...details
  });
}

function uniqueByCode(blockers) {
  return [...new Map(blockers.map((blocker) => [`${blocker.section}:${blocker.code}:${blocker.artifact ?? ""}`, blocker])).values()];
}

function walk(value, visit, pathParts = []) {
  visit(value, pathParts);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, pathParts.concat(String(index))));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, visit, pathParts.concat(key));
  }
}
