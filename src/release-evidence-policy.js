import { ReleasepressError } from "./config.js";
import { assertReleaseEvidenceBundlePolicy } from "./evidence-bundle.js";
import {
  DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS,
  resolveEvidencePath,
  validateReleaseEvidenceFiles
} from "./evidence-manifest.js";

export function resolveReleaseEvidencePolicy({
  config,
  sourceRoot = process.cwd(),
  evidenceManifest = null,
  releaseTarget = null,
  evidenceBundle = null
}) {
  const policy = config.release_evidence ?? {};
  const manifestRef = evidenceManifest ?? policy.manifest ?? null;
  const targetRef = releaseTarget ?? policy.release_target ?? null;
  const bundleRef = evidenceBundle ?? policy.bundle ?? null;
  if (!manifestRef && !bundleRef) {
    if (policy.required) {
      throw new ReleasepressError("release_evidence_required", "Release evidence manifest or bundle is required for provider delivery");
    }
    return {
      ok: true,
      type: "releasepress_release_evidence_gate",
      status: "skipped",
      reason: "release_evidence_not_configured"
    };
  }

  let manifestResult = null;
  if (manifestRef) {
    if (!targetRef) {
      throw new ReleasepressError("release_evidence_target_required", "Release evidence validation requires --release-target with --evidence-manifest");
    }
    const manifestPath = resolveEvidencePath({ value: manifestRef, config, sourceRoot });
    const targetPath = resolveEvidencePath({ value: targetRef, config, sourceRoot });
    manifestResult = validateReleaseEvidenceFiles({
      manifestPath,
      releaseTargetPath: targetPath,
      requiredKinds: policy.required_kinds ?? DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS
    });
    if (!manifestResult.ok) {
      throw new ReleasepressError("release_evidence_invalid", "Release evidence manifest did not satisfy Releasepress policy", {
        status: manifestResult.status,
        blockers: manifestResult.blockers
      });
    }
  }

  let bundleResult = null;
  if (bundleRef) {
    const bundlePath = resolveEvidencePath({ value: bundleRef, config, sourceRoot });
    bundleResult = assertReleaseEvidenceBundlePolicy({ bundlePath });
  }

  if (manifestResult && bundleResult) {
    const manifestSubject = manifestResult.manifest?.release_subject ?? null;
    const bundleSubject = bundleResult.bundle?.release_subject ?? null;
    if (JSON.stringify(manifestSubject ?? null) !== JSON.stringify(bundleSubject ?? null)) {
      throw new ReleasepressError("release_evidence_bundle_mismatch", "Release evidence manifest and bundle describe different release subjects", {
        manifest: manifestSubject,
        bundle: bundleSubject
      });
    }
  }

  return {
    ok: true,
    type: "releasepress_release_evidence_gate",
    status: "passed",
    ...(manifestResult ? {
      manifest: manifestResult.manifest,
      required_kinds: manifestResult.required_kinds,
      checks: manifestResult.checks
    } : {
      manifest: null,
      required_kinds: policy.required_kinds ?? DEFAULT_RELEASE_EVIDENCE_REQUIRED_KINDS,
      checks: {}
    }),
    ...(bundleResult ? { bundle: bundleResult.bundle, bundle_checks: bundleResult.checks } : {})
  };
}
