import { ReleasepressError } from "./config.js";
import { releasepressEnvelope } from "./packet-envelope.js";
import { promoteProvider } from "./promote-provider.js";
import { spawnSync } from "node:child_process";

export function promotePublic({
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  approved = false,
  evidenceManifest = null,
  releaseTarget = null,
  evidenceBundle = null,
  toolchainCompatibility = null,
  runner = spawnSync
}) {
  if (!approved) {
    throw new ReleasepressError("public_promote_approval_required", "Public promote requires explicit approval");
  }

  const enabledProviders = (config?.delivery?.providers ?? []).filter((provider) => provider.enabled);
  if (enabledProviders.length === 0) {
    throw new ReleasepressError("public_promote_surfaces_disabled", "At least one public promote surface must be enabled");
  }

  const providerResults = [];
  let npm = null;
  let github = null;

  for (const provider of enabledProviders) {
    const result = promoteProvider({
      providerId: provider.id,
      config,
      exportRoot,
      sourceRoot,
      approvedProviderId: provider.id,
      evidenceManifest,
      releaseTarget,
      evidenceBundle,
      toolchainCompatibility,
      runner
    });
    if (provider.kind === "package_registry" && provider.provider === "npm" && !npm) {
      npm = result;
    }
    if (provider.kind === "git_host" && provider.provider === "github" && !github) {
      github = result;
    }
    providerResults.push({ id: provider.id, kind: provider.kind, provider: provider.provider, result });
  }

  return {
    ...releasepressEnvelope({ ok: true, type: "releasepress_promote_public" }),
    version: github?.version ?? npm?.version ?? null,
    tag: github?.tag ?? null,
    providers: providerResults,
    npm,
    github
  };
}
