import fs from "node:fs";
import path from "node:path";
import {
  isLocalishRepo,
  repoHasEmbeddedCredentials,
  repoIsProbablyExplicitRemote,
  TARGET_VISIBILITIES
} from "./target.js";

export const DEFAULT_PACKAGE_COMMAND = "npm pack --dry-run --json";
export const DEFAULT_PACKAGE_ARGV = ["npm", "pack", "--dry-run", "--json"];
export const PREFLIGHT_STEP_IDS = ["install", "git_init", "test", "coverage", "secrets"];
export const GITHUB_LATEST_POLICIES = ["beta_as_latest", "prerelease", "stable_latest"];
export const ARTIFACT_KINDS = ["npm_pack"];
export const ARTIFACT_ROOTS = ["source", "export"];
export const REVIEW_TARGET_KINDS = ["git_ref"];
export const DELIVERY_PROVIDER_KINDS = ["git_host", "package_registry"];
export const DELIVERY_LAUNCH_ROOTS = ["source", "export"];
export const LOCAL_PROMOTE_STRATEGIES = ["bin_shim", "npm_prefix"];
export const LOCAL_PROMOTE_SOURCES = ["source", "export"];
export const STAGE_STRATEGIES = ["fast-forward-only", "replace-main", "unique-ref"];
export const PUBLIC_REVIEW_STRATEGIES = ["fast-forward-only", "replace-ref"];
export const PUBLIC_REVIEW_VISIBILITIES = TARGET_VISIBILITIES.filter((value) => value !== "registry");
export const RELEASE_EVIDENCE_REQUIRED_KINDS = ["audit_bundle", "verification_summary"];
export const RELEASE_EVIDENCE_KINDS = [
  "audit_bundle",
  "verification_summary",
  "customer_safe_report",
  "attestation",
  "replay_summary"
];
export const TELEMETRY_DIAGNOSTIC_CWDS = ["source"];
const TELEMETRY_OWNED_EVENT_FLAGS = new Set([
  "--producer",
  "--event-kind",
  "--classification",
  "--impact",
  "--scope",
  "--evidence-ref",
  "--evidence-snippet",
  "--expected",
  "--actual",
  "--suggested-owner",
  "--suggested-next-action",
  "--summary",
  "--source-packet-ref",
  "--authority",
  "--proof",
  "--gate",
  "--security",
  "--lifecycle",
  "--readiness"
]);
export const DEFAULT_DISALLOWED_SURFACE_PROFILES = [
  "private-tooling",
  "tool-manifests",
  "agent-private-skills",
  "node-artifacts"
];
export const DISALLOWED_SURFACE_PROFILES = {
  "private-tooling": [
    ".runlane/**",
    ".remogram.json",
    ".cursor/**",
    ".codex/**",
    ".agents/**",
    ".claude/**",
    ".releasepress-report/**",
    "topo/**",
    "topogram.*",
    "skillpress.config.json",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".npmrc",
    "**/.npmrc",
    ".netrc",
    "**/.netrc",
    "id_rsa*",
    "**/id_rsa*",
    ".aws/credentials",
    "**/.aws/credentials",
    "*.pem",
    "**/*.pem"
  ],
  "tool-manifests": [
    "*.manifest.json",
    "skillpress.manifest.json",
    "releasepress.manifest.json",
    "topogram.activation-status.json",
    "topogram.forge-facts.json"
  ],
  "agent-private-skills": [
    "agent-skills/src/**/**-dogfood/**",
    "agent-skills/src/**/**-atteway/**",
    "agent-skills/src/**/**-*-lane/**",
    "agent-skills/src/**/**-sdlc-core/**",
    "agent-skills/src/**/**-observer/**"
  ],
  "node-artifacts": [
    "node_modules/**",
    "coverage/**"
  ]
};

export class ReleasepressError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleasepressError";
    this.code = code;
    this.details = details;
  }
}

export function structuredError(error) {
  if (error instanceof ReleasepressError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "unexpected_error",
      message: error?.message || String(error)
    }
  };
}

export function loadConfig(configPath, cwd = process.cwd()) {
  if (!configPath) {
    throw new ReleasepressError("missing_config", "--config is required");
  }

  const resolved = path.resolve(cwd, configPath);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("missing_config", "Config file does not exist", {
        path: configPath
      });
    }
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReleasepressError("invalid_config_json", "Config file is not valid JSON", {
      path: configPath,
      reason: error.message
    });
  }

  return validateConfig(raw, resolved);
}

export function validateConfig(raw, configPath = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "Config must be a JSON object");
  }
  assertNoLegacyPublicSurfaces(raw.surfaces ?? {});

  const include = requireStringArray(raw.include, "include", { min: 1 });
  const exclude = requireStringArray(raw.exclude ?? [], "exclude");
  const forbiddenStrings = requireStringArray(raw.forbidden_strings ?? [], "forbidden_strings");
  const defaultsConfig = normalizeDefaultsConfig(raw.defaults ?? {});

  for (const pattern of include) {
    assertSafePattern(pattern, "include");
  }
  for (const pattern of exclude) {
    assertSafePattern(pattern, "exclude");
  }
  assertIncludePatternsDoNotTargetDisallowed(include, defaultsConfig.expanded_disallowed_patterns);

  const artifactsConfig = normalizeArtifactsConfig(raw.artifacts, raw.package ?? {});
  const packageConfig = normalizePackageConfigFromArtifacts({
    rawPackage: raw.package ?? {},
    artifacts: artifactsConfig
  });
  const versionConfig = normalizeVersionConfig(raw.version ?? {});
  const releaseNotesConfig = normalizeReleaseNotesConfig(raw.release_notes ?? {});
  const releaseEvidenceConfig = normalizeReleaseEvidenceConfig(raw.release_evidence ?? {});
  const toolchainCompatibilityConfig = normalizeToolchainCompatibilityConfig(raw.toolchain_compatibility ?? {});
  const tagConfig = normalizeTagConfig(raw.tag ?? {});
  const preflightConfig = normalizePreflightConfig(raw.preflight ?? {});
  const scanConfig = normalizeScanConfig(raw.scan ?? {});
  const diagnosticsConfig = normalizeDiagnosticsConfig(raw.diagnostics ?? {});
  const stageConfig = normalizeStageConfig(raw.stage ?? {});
  const reviewTargetsConfig = normalizeReviewTargetsConfig(raw.review_targets, raw.public_review ?? {});
  const deliveryConfig = normalizeDeliveryConfig(raw.delivery ?? {}, {
    artifacts: artifactsConfig,
    reviewTargets: reviewTargetsConfig
  });
  const publicReviewConfig = selectPublicReviewConfig(reviewTargetsConfig, deliveryConfig);
  const surfacesConfig = normalizeSurfacesConfig(raw.surfaces ?? {});
  validatePublicReviewRequirements(publicReviewConfig, {
    delivery: deliveryConfig
  });

  for (const pattern of scanConfig.exclude) {
    assertSafePattern(pattern, "scan.exclude");
  }

  return {
    config_path: configPath,
    public_repo: optionalString(raw.public_repo, "public_repo") ?? derivePublicRepoFromDelivery(deliveryConfig),
    stage_repo: optionalString(raw.stage_repo, "stage_repo"),
    defaults: defaultsConfig,
    include,
    exclude,
    disallowed_patterns: defaultsConfig.expanded_disallowed_patterns.map((entry) => entry.pattern),
    forbidden_strings: forbiddenStrings,
    scan: scanConfig,
    diagnostics: diagnosticsConfig,
    stage: stageConfig,
    public_review: publicReviewConfig,
    review_targets: reviewTargetsConfig,
    artifacts: artifactsConfig,
    delivery: deliveryConfig,
    package: packageConfig,
    version: versionConfig,
    release_notes: releaseNotesConfig,
    release_evidence: releaseEvidenceConfig,
    toolchain_compatibility: toolchainCompatibilityConfig,
    tag: tagConfig,
    preflight: preflightConfig,
    surfaces: surfacesConfig
  };
}

function normalizeToolchainCompatibilityConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "toolchain_compatibility must be an object");
  }
  const required = optionalBoolean(raw.required ?? false, "toolchain_compatibility.required");
  const matrix = optionalString(raw.matrix ?? null, "toolchain_compatibility.matrix");
  if (matrix !== null) {
    assertSafeFilePath(matrix, "toolchain_compatibility.matrix");
  }
  return {
    required,
    matrix: matrix === null ? null : normalizePattern(matrix)
  };
}

function normalizeReleaseEvidenceConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "release_evidence must be an object");
  }
  const required = optionalBoolean(raw.required ?? false, "release_evidence.required");
  const manifest = optionalString(raw.manifest ?? null, "release_evidence.manifest");
  const releaseTarget = optionalString(raw.release_target ?? null, "release_evidence.release_target");
  const bundle = optionalString(raw.bundle ?? null, "release_evidence.bundle");
  const requiredKinds = requireStringArray(
    raw.required_kinds ?? RELEASE_EVIDENCE_REQUIRED_KINDS,
    "release_evidence.required_kinds",
    { min: 1 }
  );
  const seen = new Set();
  for (const kind of requiredKinds) {
    if (!RELEASE_EVIDENCE_KINDS.includes(kind)) {
      throw new ReleasepressError("invalid_config", "release_evidence.required_kinds contains an unsupported evidence kind", {
        kind
      });
    }
    if (seen.has(kind)) {
      throw new ReleasepressError("invalid_config", "release_evidence.required_kinds must not contain duplicates", {
        kind
      });
    }
    seen.add(kind);
  }
  if (manifest !== null) {
    assertSafeFilePath(manifest, "release_evidence.manifest");
  }
  if (releaseTarget !== null) {
    assertSafeFilePath(releaseTarget, "release_evidence.release_target");
  }
  if (bundle !== null) {
    assertSafeDirectoryPath(bundle, "release_evidence.bundle");
  }
  return {
    required,
    manifest: manifest === null ? null : normalizePattern(manifest),
    release_target: releaseTarget === null ? null : normalizePattern(releaseTarget),
    bundle: bundle === null ? null : normalizePattern(bundle),
    required_kinds: requiredKinds
  };
}

function assertNoLegacyPublicSurfaces(rawSurfaces) {
  if (!rawSurfaces || typeof rawSurfaces !== "object" || Array.isArray(rawSurfaces)) {
    return;
  }
  for (const key of ["github", "npm"]) {
    if (Object.hasOwn(rawSurfaces, key)) {
      throw new ReleasepressError(
        "legacy_public_surface_config_unsupported",
        `surfaces.${key} has been replaced by delivery.providers[]`,
        {
          legacy_field: `surfaces.${key}`,
          replacement: "delivery.providers[]"
        }
      );
    }
  }
}

function normalizeArtifactsConfig(rawArtifacts, rawPackage) {
  if (rawArtifacts === undefined) {
    const packageConfig = normalizePackageConfig(rawPackage);
    return [
      {
        id: "npm-package",
        kind: "npm_pack",
        inspect_argv: packageConfig.argv,
        root: "source",
        path: ".",
        must_exclude: packageConfig.must_exclude
      }
    ];
  }
  if (!Array.isArray(rawArtifacts)) {
    throw new ReleasepressError("invalid_config", "artifacts must be an array");
  }
  const seen = new Set();
  return rawArtifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new ReleasepressError("invalid_config", `artifacts[${index}] must be an object`);
    }
    const field = `artifacts[${index}]`;
    const id = optionalString(artifact.id, `${field}.id`);
    assertSafeId(id, `${field}.id`);
    if (seen.has(id)) {
      throw new ReleasepressError("invalid_config", "artifact ids must be unique", { id });
    }
    seen.add(id);

    const kind = optionalEnum(artifact.kind, `${field}.kind`, ARTIFACT_KINDS);
    const inspectArgv = artifact.inspect_argv === undefined
      ? [...DEFAULT_PACKAGE_ARGV]
      : requireStringArray(artifact.inspect_argv, `${field}.inspect_argv`, { min: 1 });
    assertSafeArgv(inspectArgv, `${field}.inspect_argv`);
    const root = optionalEnum(artifact.root ?? "source", `${field}.root`, ARTIFACT_ROOTS);
    const artifactPath = optionalString(artifact.path ?? ".", `${field}.path`);
    assertSafeDirectoryPath(artifactPath, `${field}.path`);
    const mustExclude = requireStringArray(artifact.must_exclude ?? [], `${field}.must_exclude`);
    for (const pattern of mustExclude) {
      assertSafePattern(pattern, `${field}.must_exclude`);
    }
    if (artifact.command !== undefined) {
      throw new ReleasepressError("invalid_config", `${field}.command is not supported; use inspect_argv`);
    }

    return {
      id,
      kind,
      inspect_argv: inspectArgv,
      root,
      path: normalizePattern(artifactPath),
      must_exclude: mustExclude
    };
  });
}

function normalizePackageConfigFromArtifacts({ rawPackage, artifacts }) {
  const artifact = artifacts.find((candidate) => candidate.kind === "npm_pack");
  if (!artifact) {
    return normalizePackageConfig(rawPackage);
  }
  return {
    argv: artifact.inspect_argv,
    command: artifact.inspect_argv.join(" "),
    must_exclude: artifact.must_exclude,
    artifact_id: artifact.id,
    root: artifact.root,
    path: artifact.path
  };
}

function normalizeReviewTargetsConfig(rawReviewTargets, rawPublicReview) {
  if (rawReviewTargets === undefined) {
    const review = normalizePublicReviewConfig(rawPublicReview);
    if (!review.repo) {
      return [];
    }
    return [
      {
        id: "public-review",
        kind: "git_ref",
        ...review
      }
    ];
  }
  if (!Array.isArray(rawReviewTargets)) {
    throw new ReleasepressError("invalid_config", "review_targets must be an array");
  }
  const seen = new Set();
  return rawReviewTargets.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new ReleasepressError("invalid_config", `review_targets[${index}] must be an object`);
    }
    const field = `review_targets[${index}]`;
    const id = optionalString(target.id, `${field}.id`);
    assertSafeId(id, `${field}.id`);
    if (seen.has(id)) {
      throw new ReleasepressError("invalid_config", "review target ids must be unique", { id });
    }
    seen.add(id);
    const kind = optionalEnum(target.kind, `${field}.kind`, REVIEW_TARGET_KINDS);
    const review = normalizePublicReviewConfig(target, field);
    if (!review.repo) {
      throw new ReleasepressError("invalid_config", `${field}.repo is required`);
    }
    return {
      id,
      kind,
      ...review
    };
  });
}

function normalizeDeliveryConfig(raw, { artifacts, reviewTargets }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "delivery must be an object");
  }
  const rawPlugins = raw.plugins ?? {};
  if (typeof rawPlugins !== "object" || Array.isArray(rawPlugins)) {
    throw new ReleasepressError("invalid_config", "delivery.plugins must be an object");
  }
  const plugins = {};
  for (const [kind, plugin] of Object.entries(rawPlugins)) {
    assertSafeId(kind, `delivery.plugins.${kind}`);
    plugins[kind] = normalizeDeliveryPlugin(kind, plugin);
  }
  const customKinds = Object.keys(plugins);
  const allowedKinds = [...DELIVERY_PROVIDER_KINDS, ...customKinds];

  const rawProviders = raw.providers ?? [];
  if (!Array.isArray(rawProviders)) {
    throw new ReleasepressError("invalid_config", "delivery.providers must be an array");
  }
  const seen = new Set();
  const providers = rawProviders.map((provider, index) =>
    normalizeDeliveryProvider({
      provider,
      index,
      seen,
      artifacts,
      reviewTargets,
      allowedKinds
    })
  );
  return {
    plugins,
    providers
  };
}

const DELIVERY_PLUGIN_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const DELIVERY_PLUGIN_RELATIVE = /^\.\/[A-Za-z0-9._/-]+$/;
const MAX_SECRET_DETECTOR_PATTERN_LENGTH = 256;
const NESTED_QUANTIFIER_PATTERN = /(\([^)]*[+*][^)]*\))[+*]|([+*]\s*){2,}/;

function normalizeDeliveryPlugin(kind, plugin) {
  const field = `delivery.plugins.${kind}`;
  const value = optionalString(plugin, field);
  if (!value) {
    throw new ReleasepressError("invalid_config", `${field} must be a non-empty string`);
  }
  if (value.includes("\0") || value.includes("..")) {
    throw new ReleasepressError("invalid_config", `${field} must not contain null bytes or parent path segments`, {
      plugin: value
    });
  }
  if (path.isAbsolute(value)) {
    throw new ReleasepressError(
      "invalid_config",
      `${field} must be a package name or a ./ relative path under the source root`,
      { plugin: value }
    );
  }
  if (value.startsWith("./")) {
    if (!DELIVERY_PLUGIN_RELATIVE.test(value) || value.includes("//")) {
      throw new ReleasepressError("invalid_config", `${field} relative plugin path is invalid`, {
        plugin: value
      });
    }
    return value;
  }
  if (!DELIVERY_PLUGIN_PACKAGE.test(value)) {
    throw new ReleasepressError(
      "invalid_config",
      `${field} must be a package name or a ./ relative path under the source root`,
      { plugin: value }
    );
  }
  return value;
}

function normalizeDeliveryProvider({ provider, index, seen, artifacts, reviewTargets, allowedKinds }) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new ReleasepressError("invalid_config", `delivery.providers[${index}] must be an object`);
  }
  const field = `delivery.providers[${index}]`;
  const id = optionalString(provider.id, `${field}.id`);
  assertSafeId(id, `${field}.id`);
  if (seen.has(id)) {
    throw new ReleasepressError("invalid_config", "delivery provider ids must be unique", { id });
  }
  seen.add(id);

  const kind = optionalEnum(provider.kind, `${field}.kind`, allowedKinds);
  const providerName = optionalString(provider.provider ?? null, `${field}.provider`);
  if (providerName !== null) {
    assertSafeId(providerName, `${field}.provider`);
  }
  const enabled = optionalBoolean(provider.enabled ?? false, `${field}.enabled`);
  const reviewTarget = optionalString(provider.review_target ?? null, `${field}.review_target`);
  const artifact = optionalString(provider.artifact ?? null, `${field}.artifact`);
  const launchRoot = optionalEnum(provider.launch_root ?? "export", `${field}.launch_root`, DELIVERY_LAUNCH_ROOTS);
  if (kind === "git_host" && launchRoot !== "export") {
    throw new ReleasepressError(
      "invalid_config",
      `${field}.launch_root must be export for git_host providers`,
      {
        provider_id: id,
        kind,
        launch_root: launchRoot
      }
    );
  }
  if (kind === "package_registry" && launchRoot !== "export") {
    throw new ReleasepressError(
      "invalid_config",
      `${field}.launch_root must be export for package_registry providers`,
      {
        provider_id: id,
        kind,
        launch_root: launchRoot
      }
    );
  }
  const launchPath = optionalString(provider.launch_path ?? ".", `${field}.launch_path`);
  assertSafeDirectoryPath(launchPath, `${field}.launch_path`);
  const launcher = normalizeProviderLauncher(provider.launcher ?? {}, `${field}.launcher`, enabled);
  const preflight = normalizeProviderPreflight(provider.preflight ?? {}, `${field}.preflight`);
  const verify = normalizeProviderVerify(provider.verify ?? {}, `${field}.verify`);

  if (reviewTarget !== null) {
    assertReferenceExists(reviewTargets, reviewTarget, `${field}.review_target`);
  }
  if (artifact !== null) {
    assertReferenceExists(artifacts, artifact, `${field}.artifact`);
  }
  if (enabled && !reviewTarget) {
    throw new ReleasepressError("invalid_config", `${field}.review_target is required when delivery provider is enabled`);
  }
  if (enabled && kind === "package_registry" && !artifact) {
    throw new ReleasepressError("invalid_config", `${field}.artifact is required for enabled package registry providers`);
  }

  const normalized = {
    id,
    kind,
    provider: providerName,
    enabled,
    review_target: reviewTarget,
    artifact,
    launch_root: launchRoot,
    launch_path: normalizePattern(launchPath),
    launcher,
    preflight,
    verify
  };

  if (kind === "git_host") {
    Object.assign(normalized, normalizeGitHostProviderFields(provider, field, enabled));
  }
  if (kind === "package_registry") {
    Object.assign(normalized, normalizePackageRegistryProviderFields(provider, field, enabled));
  }

  return normalized;
}

function normalizeProviderLauncher(raw, field, enabled) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }
  const commandArgv = raw.command_argv === undefined
    ? []
    : requireStringArray(raw.command_argv, `${field}.command_argv`, { min: 1 });
  assertSafeArgv(commandArgv, `${field}.command_argv`);
  if (enabled && commandArgv.length === 0) {
    throw new ReleasepressError("invalid_config", `${field}.command_argv is required when delivery provider is enabled`);
  }
  return {
    command_argv: commandArgv
  };
}

function normalizeProviderPreflight(raw, field) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }
  const enabled = optionalBoolean(raw.enabled ?? false, `${field}.enabled`);
  const commandArgv = raw.command_argv === undefined
    ? []
    : requireStringArray(raw.command_argv, `${field}.command_argv`, { min: 1 });
  assertSafeArgv(commandArgv, `${field}.command_argv`);
  return {
    enabled,
    command_argv: commandArgv,
    expect: normalizeVerifyExpect(raw.expect ?? {}, `${field}.expect`)
  };
}

function normalizeProviderVerify(raw, field) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }
  const kind = raw.kind === undefined
    ? null
    : optionalEnum(raw.kind, `${field}.kind`, ["git_ref", "argv"]);
  if (kind === "git_ref") {
    const remote = optionalString(raw.remote ?? null, `${field}.remote`);
    const ref = optionalString(raw.ref ?? null, `${field}.ref`);
    if (!remote) {
      throw new ReleasepressError("invalid_config", `${field}.remote is required for git_ref verify`);
    }
    if (!ref) {
      throw new ReleasepressError("invalid_config", `${field}.ref is required for git_ref verify`);
    }
    assertSafeGitVerifyRemote(remote, `${field}.remote`);
    assertSafeGitVerifyRefTemplate(ref, `${field}.ref`);
    return { kind, remote, ref };
  }
  if (kind === "argv") {
    const commandArgv = requireStringArray(raw.command_argv, `${field}.command_argv`, { min: 1 });
    assertSafeArgv(commandArgv, `${field}.command_argv`);
    return { kind, command_argv: commandArgv, expect: normalizeVerifyExpect(raw.expect ?? {}, `${field}.expect`) };
  }
  if (raw.command_argv !== undefined) {
    const commandArgv = requireStringArray(raw.command_argv, `${field}.command_argv`, { min: 1 });
    assertSafeArgv(commandArgv, `${field}.command_argv`);
    return { kind: "argv", command_argv: commandArgv, expect: normalizeVerifyExpect(raw.expect ?? {}, `${field}.expect`) };
  }
  return { kind: null };
}

function normalizeGitHostProviderFields(provider, field, enabled) {
  const repo = optionalString(provider.repo ?? null, `${field}.repo`);
  const ref = optionalString(provider.ref ?? null, `${field}.ref`);
  const remoteName = optionalString(provider.remote_name ?? null, `${field}.remote_name`);
  const allowForcePush = optionalBoolean(provider.allow_force_push ?? false, `${field}.allow_force_push`);
  const requireNpmPromote = optionalBoolean(provider.require_npm_promote ?? true, `${field}.require_npm_promote`);
  const release = normalizeGithubReleaseConfig(provider.release ?? {}, `${field}.release`);
  if (repo !== null) {
    assertSafeGitHostRepo(repo, `${field}.repo`, provider.provider ?? null);
  }
  if (ref !== null) {
    assertSafeStageRef(ref, `${field}.ref`);
  }
  if (remoteName !== null) {
    assertGitRemoteName(remoteName, `${field}.remote_name`);
  }
  if (provider.launcher?.command_argv?.length) {
    assertSafeGitHostLauncher(provider.launcher.command_argv, `${field}.launcher.command_argv`);
  }
  if (enabled) {
    if (!repo) {
      throw new ReleasepressError("invalid_config", `${field}.repo is required for enabled git_host providers`);
    }
    if (!ref) {
      throw new ReleasepressError("invalid_config", `${field}.ref is required for enabled git_host providers`);
    }
  }
  return {
    repo,
    ref,
    remote_name: remoteName,
    allow_force_push: allowForcePush,
    require_npm_promote: requireNpmPromote,
    release
  };
}

function normalizePackageRegistryProviderFields(provider, field, enabled) {
  const channel = optionalString(provider.channel ?? null, `${field}.channel`);
  const workspace = optionalBoolean(provider.workspace ?? false, `${field}.workspace`);
  if (enabled && provider.provider === "npm" && !channel) {
    throw new ReleasepressError("invalid_config", `${field}.channel is required for enabled npm providers`);
  }
  return {
    channel,
    dist_tag: channel,
    workspace
  };
}

function normalizeVerifyExpect(raw, field) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }
  const expect = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ReleasepressError("invalid_config", `${field}.${key} must be a non-empty string`);
    }
    expect[key] = value;
  }
  return expect;
}

function selectPublicReviewConfig(reviewTargets, delivery) {
  const referenced = delivery.providers.find((provider) => provider.enabled && provider.review_target)?.review_target;
  const target = referenced
    ? reviewTargets.find((candidate) => candidate.id === referenced)
    : reviewTargets[0];
  if (!target) {
    return normalizePublicReviewConfig({});
  }
  return {
    id: target.id,
    kind: target.kind,
    repo: target.repo,
    visibility: target.visibility,
    strategy: target.strategy,
    ref: target.ref,
    requires_human_attestation: target.requires_human_attestation
  };
}

function derivePublicRepoFromDelivery(delivery) {
  const githubProvider = delivery.providers.find((provider) => provider.kind === "git_host" && provider.provider === "github");
  return githubProvider?.verify?.remote ?? null;
}

function assertReferenceExists(collection, id, field) {
  assertSafeId(id, field);
  if (!collection.some((entry) => entry.id === id)) {
    throw new ReleasepressError("invalid_config", `${field} references an unknown id`, { id });
  }
}

function normalizeDefaultsConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "defaults must be an object");
  }

  const customProfiles = raw.custom_disallowed_profiles ?? {};
  if (typeof customProfiles !== "object" || Array.isArray(customProfiles)) {
    throw new ReleasepressError("invalid_config", "defaults.custom_disallowed_profiles must be an object");
  }

  const mergedProfiles = { ...DISALLOWED_SURFACE_PROFILES };
  for (const [profileName, patterns] of Object.entries(customProfiles)) {
    if (!Array.isArray(patterns)) {
      throw new ReleasepressError("invalid_config", `defaults.custom_disallowed_profiles.${profileName} must be an array of strings`);
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string") {
        throw new ReleasepressError("invalid_config", `defaults.custom_disallowed_profiles.${profileName} must contain only strings`);
      }
    }
    mergedProfiles[profileName] = patterns;
  }

  const disallowedProfiles = requireStringArray(
    raw.disallowed_profiles ?? DEFAULT_DISALLOWED_SURFACE_PROFILES,
    "defaults.disallowed_profiles"
  );
  const seenProfiles = new Set();
  for (const profile of disallowedProfiles) {
    if (!Object.hasOwn(mergedProfiles, profile)) {
      throw new ReleasepressError("invalid_config", `Unknown disallowed surface profile: ${profile}`, {
        profile,
        known_profiles: Object.keys(mergedProfiles)
      });
    }
    if (seenProfiles.has(profile)) {
      throw new ReleasepressError("invalid_config", "defaults.disallowed_profiles must not contain duplicates", {
        profile
      });
    }
    seenProfiles.add(profile);
  }

  const disallowedPatterns = requireStringArray(raw.disallowed_patterns ?? [], "defaults.disallowed_patterns");
  for (const pattern of disallowedPatterns) {
    assertSafePattern(pattern, "defaults.disallowed_patterns");
  }

  return {
    disallowed_profiles: disallowedProfiles,
    disallowed_patterns: disallowedPatterns,
    expanded_disallowed_patterns: expandDisallowedPatterns({
      disallowedProfiles,
      disallowedPatterns,
      mergedProfiles
    })
  };
}

function expandDisallowedPatterns({ disallowedProfiles, disallowedPatterns, mergedProfiles }) {
  const expanded = [];
  const seen = new Set();

  function add(pattern, source) {
    const normalized = normalizePattern(pattern);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    expanded.push({ pattern: normalized, source });
  }

  for (const profile of disallowedProfiles) {
    for (const pattern of mergedProfiles[profile]) {
      add(pattern, `profile:${profile}`);
    }
  }
  for (const pattern of disallowedPatterns) {
    add(pattern, "defaults.disallowed_patterns");
  }

  return expanded;
}

function assertIncludePatternsDoNotTargetDisallowed(include, disallowedEntries) {
  for (const includePattern of include) {
    const normalizedInclude = normalizePattern(includePattern);
    for (const disallowed of disallowedEntries) {
      if (includeDirectlyTargetsDisallowed(normalizedInclude, disallowed.pattern)) {
        throw new ReleasepressError(
          "disallowed_include_pattern",
          "include must not explicitly target a configured disallowed private surface",
          {
            include_pattern: includePattern,
            disallowed_pattern: disallowed.pattern,
            source: disallowed.source
          }
        );
      }
    }
  }
}

function includeDirectlyTargetsDisallowed(includePattern, disallowedPattern) {
  if (includePattern === disallowedPattern) {
    return true;
  }

  if (!includePattern.includes("*") && matchesPattern(includePattern, disallowedPattern)) {
    return true;
  }

  const disallowedRoot = patternStaticRoot(disallowedPattern);
  if (!disallowedRoot) {
    const representativeIncludePath = representativePathForPattern(includePattern);
    return matchesPattern(representativeIncludePath, disallowedPattern);
  }

  return includePattern === disallowedRoot || includePattern.startsWith(`${disallowedRoot}/`);
}

function representativePathForPattern(pattern) {
  return pattern
    .split("/")
    .map((segment, index, segments) => {
      if (segment === "**" || segment === "*") {
        return index === segments.length - 1 ? "file" : "segment";
      }
      if (segment.includes("*")) {
        return segment.replace(/\*+/g, "private");
      }
      return segment;
    })
    .join("/");
}

function patternStaticRoot(pattern) {
  const normalized = normalizePattern(pattern);
  if (normalized.includes("*") && !normalized.endsWith("/**")) {
    return null;
  }
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex !== -1 && normalized.slice(wildcardIndex) !== "**") {
    return null;
  }
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  if (prefix.includes("*")) {
    return null;
  }
  const withoutSuffix = prefix.replace(/\/+$/, "");
  if (!withoutSuffix || withoutSuffix === ".") {
    return null;
  }
  if (wildcardIndex === -1) {
    return withoutSuffix;
  }
  const slashIndex = withoutSuffix.lastIndexOf("/");
  return slashIndex === -1 ? withoutSuffix : withoutSuffix.slice(0, slashIndex);
}

function normalizeScanConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "scan must be an object");
  }

  const rawDetectors = raw.secret_detectors ?? [];
  if (!Array.isArray(rawDetectors)) {
    throw new ReleasepressError("invalid_config", "scan.secret_detectors must be an array");
  }

  const secretDetectors = rawDetectors.map((detector, index) => {
    if (!detector || typeof detector !== "object" || Array.isArray(detector)) {
      throw new ReleasepressError("invalid_config", `scan.secret_detectors[${index}] must be an object`);
    }
    const id = optionalString(detector.id, `scan.secret_detectors[${index}].id`);
    assertSafeId(id, `scan.secret_detectors[${index}].id`);
    const patternStr = optionalString(detector.pattern, `scan.secret_detectors[${index}].pattern`);
    if (!patternStr) {
      throw new ReleasepressError("invalid_config", `scan.secret_detectors[${index}].pattern is required`);
    }
    if (patternStr.length > MAX_SECRET_DETECTOR_PATTERN_LENGTH) {
      throw new ReleasepressError(
        "invalid_config",
        `scan.secret_detectors[${index}].pattern exceeds ${MAX_SECRET_DETECTOR_PATTERN_LENGTH} characters`
      );
    }
    if (NESTED_QUANTIFIER_PATTERN.test(patternStr)) {
      throw new ReleasepressError(
        "invalid_config",
        `scan.secret_detectors[${index}].pattern looks vulnerable to ReDoS (nested quantifiers)`
      );
    }
    try {
      // Compile once at config time so invalid patterns fail closed early.
      // eslint-disable-next-line no-new
      new RegExp(patternStr, "g");
    } catch (err) {
      throw new ReleasepressError(
        "invalid_config",
        `scan.secret_detectors[${index}].pattern is not a valid regular expression: ${err.message}`
      );
    }

    return {
      id,
      pattern: patternStr
    };
  });

  return {
    exclude: requireStringArray(raw.exclude ?? [], "scan.exclude"),
    secret_detectors: secretDetectors
  };
}

function normalizeDiagnosticsConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "diagnostics must be an object");
  }

  return {
    telemetry: normalizeTelemetryDiagnosticsConfig(raw.telemetry ?? {})
  };
}

function normalizeTelemetryDiagnosticsConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "diagnostics.telemetry must be an object");
  }

  const enabled = optionalBoolean(raw.enabled ?? false, "diagnostics.telemetry.enabled");
  const cwd = optionalEnum(raw.cwd ?? "source", "diagnostics.telemetry.cwd", TELEMETRY_DIAGNOSTIC_CWDS);
  const commandArgv = raw.command_argv === undefined
    ? ["telemetry", "sink", "record", "--file", "{file}", "--json"]
    : requireStringArray(raw.command_argv, "diagnostics.telemetry.command_argv", { min: 1 });

  assertSafeArgv(commandArgv, "diagnostics.telemetry.command_argv");
  assertTelemetryCommandPrefixArgv(commandArgv);

  return {
    enabled,
    cwd,
    command_argv: commandArgv
  };
}

function assertTelemetryCommandPrefixArgv(commandArgv) {
  const filePlaceholders = commandArgv.filter((arg) => arg === "{file}");
  if (filePlaceholders.length !== 1) {
    throw new ReleasepressError(
      "invalid_config",
      "diagnostics.telemetry.command_argv must include exactly one {file} placeholder for the diagnostic event JSON file"
    );
  }

  commandArgv.forEach((arg, index) => {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (TELEMETRY_OWNED_EVENT_FLAGS.has(flag)) {
      throw new ReleasepressError(
        "invalid_config",
        `diagnostics.telemetry.command_argv[${index}] must not set diagnostic event fields; Releasepress writes the bounded event file`
      );
    }
  });
}

function normalizeStageConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "stage must be an object");
  }

  const id = optionalString(raw.id ?? "stage", "stage.id");
  const strategy = optionalEnum(raw.strategy ?? "fast-forward-only", "stage.strategy", STAGE_STRATEGIES);
  const ref = optionalString(raw.ref ?? "main", "stage.ref");
  const refPrefix = optionalString(raw.ref_prefix ?? "releasepress", "stage.ref_prefix");

  assertSafeId(id, "stage.id");
  assertSafeStageRef(ref, "stage.ref");
  assertSafeStageRef(refPrefix, "stage.ref_prefix");

  return {
    id,
    strategy,
    ref,
    ref_prefix: refPrefix
  };
}

function normalizePublicReviewConfig(raw, field = "public_review") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }

  const repo = optionalString(raw.repo ?? null, `${field}.repo`);
  const visibility = optionalEnum(raw.visibility ?? "local", `${field}.visibility`, PUBLIC_REVIEW_VISIBILITIES);
  const strategy = optionalEnum(raw.strategy ?? "fast-forward-only", `${field}.strategy`, PUBLIC_REVIEW_STRATEGIES);
  const ref = optionalString(raw.ref ?? "main", `${field}.ref`);
  const requiresHumanAttestation = optionalBoolean(
    raw.requires_human_attestation ?? true,
    `${field}.requires_human_attestation`
  );

  assertSafeStageRef(ref, `${field}.ref`);
  if (repo !== null) {
    assertSafeReviewRepo(repo, visibility, `${field}.repo`);
  }

  return {
    repo,
    visibility,
    strategy,
    ref,
    requires_human_attestation: requiresHumanAttestation
  };
}

function validatePublicReviewRequirements(publicReview, config) {
  if (!publicPromotionRequired(config)) {
    return;
  }
  if (!publicReview.repo) {
    throw new ReleasepressError(
      "invalid_config",
      "public_review.repo is required when public delivery providers are enabled"
    );
  }
  if (publicReview.requires_human_attestation !== true) {
    throw new ReleasepressError(
      "invalid_config",
      "public_review.requires_human_attestation must be true when public delivery providers are enabled"
    );
  }
  for (const provider of config.delivery.providers.filter((candidate) => candidate.enabled)) {
    if (provider.review_target !== publicReview.id) {
      throw new ReleasepressError(
        "invalid_config",
        "enabled delivery providers must use the selected public review target in this releasepress slice",
        {
          provider_id: provider.id,
          review_target: provider.review_target,
          selected_review_target: publicReview.id ?? null
        }
      );
    }
  }
}

function normalizePackageConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "package must be an object");
  }

  const mustExclude = requireStringArray(raw.must_exclude ?? [], "package.must_exclude");
  for (const pattern of mustExclude) {
    assertSafePattern(pattern, "package.must_exclude");
  }

  let argv = DEFAULT_PACKAGE_ARGV;
  if (raw.argv !== undefined) {
    argv = requireStringArray(raw.argv, "package.argv", { min: 1 });
  }

  if (raw.command !== undefined) {
    const command = optionalString(raw.command, "package.command");
    if (command.trim() !== DEFAULT_PACKAGE_COMMAND) {
      throw new ReleasepressError(
        "package_command_shell_string_unsupported",
        "package.command only accepts the built-in npm pack dry-run command in v1; use package.argv for argv-based commands"
      );
    }
    argv = [...DEFAULT_PACKAGE_ARGV];
  }

  return {
    argv,
    command: argv.join(" "),
    must_exclude: mustExclude
  };
}

function normalizeVersionConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "version must be an object");
  }

  const source = optionalEnum(raw.source ?? "source", "version.source", ["source", "export"]);
  const file = optionalString(raw.file ?? "package.json", "version.file");
  const field = optionalString(raw.field ?? "version", "version.field");
  assertSafeFilePath(file, "version.file");
  if (field.includes("\0") || field.trim() !== field || field.length === 0) {
    throw new ReleasepressError("invalid_config", "version.field must be a non-empty field path");
  }

  return {
    source,
    file,
    field
  };
}

function normalizeReleaseNotesConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "release_notes must be an object");
  }

  const source = optionalEnum(raw.source ?? "source", "release_notes.source", ["source", "export"]);
  const file = optionalString(raw.file ?? "CHANGELOG.md", "release_notes.file");
  const sectionPattern = optionalString(
    raw.section_pattern ?? "^## \\[{version}\\]",
    "release_notes.section_pattern"
  );
  const fallback = raw.fallback === undefined || raw.fallback === null
    ? null
    : optionalEnum(raw.fallback, "release_notes.fallback", ["file"]);

  assertSafeFilePath(file, "release_notes.file");
  if (!sectionPattern.includes("{version}")) {
    throw new ReleasepressError("invalid_config", "release_notes.section_pattern must include {version}");
  }
  try {
    new RegExp(sectionPattern.replace("{version}", "0.0.0"));
  } catch (error) {
    throw new ReleasepressError("invalid_config", "release_notes.section_pattern must be a valid regular expression", {
      reason: error.message
    });
  }

  return {
    source,
    file,
    section_pattern: sectionPattern,
    fallback
  };
}

function normalizeTagConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "tag must be an object");
  }

  const prefix = optionalString(raw.prefix ?? "v", "tag.prefix");
  const format = optionalString(raw.format ?? "{prefix}{version}", "tag.format");
  if (!format.includes("{version}")) {
    throw new ReleasepressError("invalid_config", "tag.format must include {version}");
  }
  if (prefix.includes("\0") || format.includes("\0")) {
    throw new ReleasepressError("invalid_config", "tag fields must not contain NUL bytes");
  }

  return {
    prefix,
    format
  };
}

function normalizePreflightConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "preflight must be an object");
  }

  const enabled = optionalBoolean(raw.enabled ?? false, "preflight.enabled");
  const cwd = optionalEnum(raw.cwd ?? "export", "preflight.cwd", ["export", "source"]);
  const timeoutMs = optionalPositiveInteger(raw.timeout_ms ?? 600000, "preflight.timeout_ms");
  const steps = normalizePreflightSteps(raw.steps ?? [], "preflight.steps");

  return {
    enabled,
    cwd,
    timeout_ms: timeoutMs,
    steps
  };
}

function normalizePreflightSteps(rawSteps, field, { safeArgv = false } = {}) {
  if (!Array.isArray(rawSteps)) {
    throw new ReleasepressError("invalid_config", `${field} must be an array`);
  }

  const seen = new Set();
  return rawSteps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must be an object`);
    }

    const id = optionalEnum(step.id, `${field}[${index}].id`, PREFLIGHT_STEP_IDS);
    if (seen.has(id)) {
      throw new ReleasepressError("invalid_config", `${field} ids must be unique`, { id });
    }
    seen.add(id);

    const argv = requireStringArray(step.argv, `${field}[${index}].argv`, { min: 1 });
    if (safeArgv) {
      assertSafeArgv(argv, `${field}[${index}].argv`);
    }
    const required = optionalBoolean(step.required ?? true, `${field}[${index}].required`);

    return {
      id,
      argv,
      required
    };
  });
}

function normalizeSurfacesConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "surfaces must be an object");
  }

  return {
    local: normalizeLocalSurface(raw.local ?? {})
  };
}

function normalizeGithubReleaseConfig(raw, field = "delivery.providers[].release") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", `${field} must be an object`);
  }

  return {
    latest_policy: optionalEnum(raw.latest_policy ?? "stable_latest", `${field}.latest_policy`, GITHUB_LATEST_POLICIES)
  };
}

function normalizeLocalSurface(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "surfaces.local must be an object");
  }

  const enabled = optionalBoolean(raw.enabled ?? false, "surfaces.local.enabled");
  const strategy = optionalEnum(raw.strategy ?? "bin_shim", "surfaces.local.strategy", LOCAL_PROMOTE_STRATEGIES);
  const commandName = optionalString(raw.command_name ?? null, "surfaces.local.command_name");
  const source = optionalEnum(raw.source ?? "source", "surfaces.local.source", LOCAL_PROMOTE_SOURCES);
  const target = optionalString(raw.target ?? null, "surfaces.local.target");
  const binDir = optionalString(raw.bin_dir ?? null, "surfaces.local.bin_dir");
  const prefix = optionalString(raw.prefix ?? null, "surfaces.local.prefix");
  const prepare = normalizeLocalPrepare(raw.prepare);
  const smokeCheck = normalizeLocalSmokeCheck(raw.smoke_check);

  if (commandName) {
    assertSafeCommandName(commandName, "surfaces.local.command_name");
  }
  if (target) {
    assertSafeFilePath(target, "surfaces.local.target");
  }
  if (binDir) {
    assertSafeLocalMutationRoot(binDir, "surfaces.local.bin_dir");
  }
  if (prefix) {
    assertSafeLocalMutationRoot(prefix, "surfaces.local.prefix");
  }

  if (enabled) {
    if (!commandName) {
      throw new ReleasepressError("invalid_config", "surfaces.local.command_name is required when local promote is enabled");
    }
    if (strategy === "bin_shim") {
      if (!binDir) {
        throw new ReleasepressError("invalid_config", "surfaces.local.bin_dir is required for bin_shim local promote");
      }
      if (!target) {
        throw new ReleasepressError("invalid_config", "surfaces.local.target is required for bin_shim local promote");
      }
    }
    if (strategy === "npm_prefix" && !prefix) {
      throw new ReleasepressError("invalid_config", "surfaces.local.prefix is required for npm_prefix local promote");
    }
  }

  return {
    enabled,
    strategy,
    command_name: commandName,
    source,
    target: target ? normalizePattern(target) : null,
    bin_dir: binDir,
    prefix,
    prepare,
    smoke_check: smokeCheck
  };
}

function normalizeLocalPrepare(raw) {
  if (raw === undefined || raw === null) {
    return {
      enabled: false,
      timeout_ms: 600000,
      steps: []
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "surfaces.local.prepare must be an object");
  }
  const enabled = optionalBoolean(raw.enabled ?? true, "surfaces.local.prepare.enabled");
  const timeoutMs = optionalPositiveInteger(raw.timeout_ms ?? 600000, "surfaces.local.prepare.timeout_ms");
  const steps = normalizePreflightSteps(
    raw.steps ?? [],
    "surfaces.local.prepare.steps",
    { safeArgv: true }
  );
  return {
    enabled,
    timeout_ms: timeoutMs,
    steps
  };
}

function normalizeLocalSmokeCheck(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("invalid_config", "surfaces.local.smoke_check must be an object");
  }
  const argv = requireStringArray(raw.argv, "surfaces.local.smoke_check.argv", { min: 1 });
  assertSafeArgv(argv, "surfaces.local.smoke_check.argv");
  const timeoutMs = optionalPositiveInteger(raw.timeout_ms ?? 30000, "surfaces.local.smoke_check.timeout_ms");
  return { argv, timeout_ms: timeoutMs };
}

function assertSafeReviewRepo(value, visibility, field) {
  if (value.trim() !== value || value.length === 0 || /[\0\r\n`<>|;&$]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe characters`);
  }
  if (repoHasEmbeddedCredentials(value)) {
    throw new ReleasepressError("invalid_config", `${field} must not contain embedded credentials`);
  }
  if (!repoIsProbablyExplicitRemote(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be an explicit repo URL or local path`);
  }
  if (visibility === "local" && !isLocalishRepo(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be local, file://, or localhost when visibility is local`);
  }
}

function assertSafeGitVerifyRemote(value, field) {
  if (value.trim() !== value || value.length === 0 || /[\0\r\n`<>|;&$?]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe characters`);
  }
  if (repoHasEmbeddedCredentials(value)) {
    throw new ReleasepressError("invalid_config", `${field} must not contain embedded credentials`);
  }
  if (!repoIsProbablyExplicitRemote(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be an explicit repo URL or local path`);
  }
}

function assertSafeGitVerifyRefTemplate(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleasepressError("invalid_config", `${field} must be a non-empty git ref template`);
  }
  if (
    value.trim() !== value ||
    value.includes("\0") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".lock") ||
    /[\s~:?*[\]\\`$&;|<>()!"'#]/.test(value)
  ) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe git or shell characters`);
  }
  if (!value.startsWith("refs/")) {
    throw new ReleasepressError("invalid_config", `${field} must be an explicit refs/* template`);
  }
  for (const match of value.matchAll(/\{([^}]+)\}/g)) {
    if (!["version", "tag", "branch", "ref", "commit"].includes(match[1])) {
      throw new ReleasepressError("invalid_config", `${field} contains an unknown template key`);
    }
  }
  const stripped = value
    .replace(/\{(?:version|tag|branch|ref|commit)\}/g, "template")
    .replace(/\^\{\}/g, "^dereference");
  if (!/^[A-Za-z0-9._\/^-]+$/.test(stripped) || stripped.includes("{") || stripped.includes("}")) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe template characters`);
  }
}

function isRepoSlug(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function assertSafeGitHostRepo(value, field, providerName) {
  if (value.trim() !== value || value.length === 0 || /[\0\r\n`<>|;&$?]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe characters`);
  }
  if (repoHasEmbeddedCredentials(value)) {
    throw new ReleasepressError("invalid_config", `${field} must not contain embedded credentials`);
  }
  if (providerName === "github" && isRepoSlug(value)) {
    return;
  }
  if (!repoIsProbablyExplicitRemote(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be an explicit repo URL or local path`);
  }
  if (
    !path.isAbsolute(value) &&
    !value.startsWith("./") &&
    !value.startsWith("../") &&
    !value.startsWith("file://") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) &&
    !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:.+/.test(value) &&
    !value.includes("/")
  ) {
    throw new ReleasepressError("invalid_config", `${field} must not be an implicit remote name`);
  }
}

function assertSafeGitHostLauncher(argv, field) {
  argv.forEach((arg, index) => {
    if (
      arg === "--force" ||
      arg === "-f" ||
      arg === "--mirror" ||
      arg === "--delete" ||
      arg.startsWith("--force=") ||
      arg.startsWith("--force-with-lease") ||
      arg.startsWith("+") ||
      /^:refs\//.test(arg)
    ) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] uses an unsafe public git push option`);
    }
  });
}

function assertGitRefSegment(value, field) {
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/") || /[\s~^:?*[\]\\]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} is not a safe git ref segment`);
  }
}

export function assertSafeStageRef(value, field = "stage.ref") {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleasepressError("invalid_config", `${field} must be a non-empty git branch ref`);
  }
  if (value.trim() !== value || value.includes("\0")) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe characters`);
  }
  if (
    value.startsWith("refs/") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("-") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".lock") ||
    value.endsWith(".")
  ) {
    throw new ReleasepressError("invalid_config", `${field} is not a safe stage branch ref`);
  }
  if (/[\s~^:?*[\]\\`$&;|<>(){}!"'#@]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe git or shell characters`);
  }

  for (const segment of value.split("/")) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.startsWith("-") ||
      segment.endsWith(".lock") ||
      segment.endsWith(".")
    ) {
      throw new ReleasepressError("invalid_config", `${field} contains an unsafe ref segment`);
    }
  }
}

function assertGitRemoteName(value, field) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} must contain only letters, numbers, dot, underscore, or dash`);
  }
}

function assertSafeId(value, field) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.startsWith("-")) {
    throw new ReleasepressError("invalid_config", `${field} must be a simple identifier`);
  }
}

export function assertSafeDirectoryPath(relPath, field) {
  assertSafePattern(relPath, field);
  const normalized = normalizePattern(relPath);
  if (normalized.includes("*")) {
    throw new ReleasepressError("unsafe_pattern", `${field} must name a directory, not a glob`, { path: relPath });
  }
}

function assertSafeArgv(argv, field) {
  argv.forEach((arg, index) => {
    if (arg.includes("\0")) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain NUL bytes`);
    }
    if (index === 0 && /\s/.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[0] must be an executable argv item, not a shell string`);
    }
    if (/(?:NPM_TOKEN|_authToken|npm_[A-Za-z0-9]{20,})/i.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain npm token material`);
    }
    if (/\b(?:GITHUB_TOKEN|GH_TOKEN)\b/i.test(arg) || /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/.test(arg) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain GitHub token material`);
    }
    if (/\b(?:GITEA_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|API_TOKEN|SECRET|PASSWORD|PASSWD)\b/i.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain token or password material`);
    }
    if (/\b(?:token|secret|password|passwd|api[_-]?key|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain token or password material`);
    }
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not contain bearer token material`);
    }
    if (arg === "--otp" || arg.startsWith("--otp=")) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must not pass npm OTP values through config`);
    }
    if (/[;&|`<>$]/.test(arg)) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] contains shell metacharacters`);
    }
  });
}

export function publicPromotionRequired(configOrSurfaces) {
  const providers = configOrSurfaces?.delivery?.providers ?? configOrSurfaces?.providers ?? [];
  return providers.some((provider) => provider.enabled);
}

function assertSafeCommandName(value, field) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.startsWith("-")) {
    throw new ReleasepressError("invalid_config", `${field} must be a simple command name`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new ReleasepressError("invalid_config", `${field} must not contain path separators or NUL bytes`);
  }
}

function assertSafeLocalMutationRoot(value, field) {
  if (!path.isAbsolute(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be an absolute local path`);
  }
  if (/[\0\r\n`<>|;&$]/.test(value)) {
    throw new ReleasepressError("invalid_config", `${field} contains unsafe characters`);
  }

  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new ReleasepressError("invalid_config", `${field} must not be the filesystem root`);
  }

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
    throw new ReleasepressError("invalid_config", `${field} targets a system-managed directory`);
  }
}

function optionalString(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleasepressError("invalid_config", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalEnum(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new ReleasepressError("invalid_config", `${field} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ReleasepressError("invalid_config", `${field} must be a positive integer`);
  }
  return value;
}

function requireStringArray(value, field, options = {}) {
  if (!Array.isArray(value)) {
    throw new ReleasepressError("invalid_config", `${field} must be an array of strings`);
  }
  if (options.min && value.length < options.min) {
    throw new ReleasepressError("invalid_config", `${field} must contain at least ${options.min} item`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new ReleasepressError("invalid_config", `${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

export function assertSafePattern(pattern, field = "pattern") {
  if (pattern.includes("\0")) {
    throw new ReleasepressError("unsafe_pattern", `${field} contains a NUL byte`, { pattern });
  }
  if (pattern.includes("\\")) {
    throw new ReleasepressError("unsafe_pattern", `${field} must use POSIX-style / separators`, { pattern });
  }
  if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern)) {
    throw new ReleasepressError("unsafe_pattern", `${field} must be relative to the source repo`, { pattern });
  }

  const normalized = normalizePattern(pattern);
  const checkPath = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const segments = checkPath.split("/");
  if (segments.includes("..")) {
    throw new ReleasepressError("unsafe_pattern", `${field} must not escape the source repo`, { pattern });
  }
  if (segments.includes("")) {
    throw new ReleasepressError("unsafe_pattern", `${field} contains an empty path segment`, { pattern });
  }
}

export function assertSafeFilePath(relPath, field = "path") {
  assertSafePattern(relPath, field);
  const normalized = normalizePattern(relPath);
  if (normalized === ".") {
    throw new ReleasepressError("unsafe_pattern", `${field} must name a file`, { path: relPath });
  }
  if (normalized.includes("*")) {
    throw new ReleasepressError("unsafe_pattern", `${field} must name a file, not a glob`, { path: relPath });
  }
  if (normalized.endsWith("/")) {
    throw new ReleasepressError("unsafe_pattern", `${field} must name a file, not a directory`, { path: relPath });
  }
}

export function normalizePattern(pattern) {
  let normalized = pattern.trim();
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.endsWith("/") && normalized.length > 1) {
    return normalized;
  }
  return path.posix.normalize(normalized);
}

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function isInsidePath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function matchesAny(relPath, patterns) {
  return patterns.some((pattern) => matchesPattern(relPath, pattern));
}

export function matchesPattern(relPath, pattern) {
  const rel = normalizeRelPath(relPath);
  const normalized = normalizePattern(pattern);

  if (normalized.endsWith("/") && !normalized.slice(0, -1).includes("*")) {
    const dir = normalized.slice(0, -1);
    return rel === dir || rel.startsWith(`${dir}/`);
  }

  if (normalized.endsWith("/**") && !normalized.slice(0, -3).includes("*")) {
    const dir = normalized.slice(0, -3);
    return rel === dir || rel.startsWith(`${dir}/`);
  }

  if (!normalized.includes("*")) {
    return rel === normalized;
  }

  return globToRegExp(normalized).test(rel);
}

export function normalizeRelPath(relPath) {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(char) {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
