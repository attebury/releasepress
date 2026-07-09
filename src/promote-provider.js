import { ReleasepressError } from "./config.js";
import { assertProviderLaunchPrerequisites } from "./provider-gate.js";
import { promoteGitHostProvider } from "./providers/git-host.js";
import { promotePackageRegistryProvider } from "./providers/package-registry.js";

export { assertProviderLaunchPrerequisites };

import { getReleaseIdentity } from "./release-identity.js";
import { runProviderPreflight } from "./provider-preflight.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const BUILTIN_PROVIDERS = {
  "git_host": promoteGitHostProvider,
  "package_registry": promotePackageRegistryProvider
};

export function promoteProvider({
  providerId,
  config,
  exportRoot,
  sourceRoot = process.cwd(),
  approvedProviderId = null,
  runner
}) {
  const provider = findProvider(config, providerId);
  if (!provider.enabled) {
    throw new ReleasepressError("delivery_provider_disabled", "Delivery provider is disabled", {
      provider_id: provider.id
    });
  }
  if (approvedProviderId !== provider.id) {
    throw new ReleasepressError("public_promote_approval_required", "Provider promote requires explicit provider approval", {
      provider_id: provider.id
    });
  }

  // Pre-promotion provider preflight
  const releaseIdentity = getReleaseIdentity({ config, sourceRoot });
  const preflightResults = runProviderPreflight({
    config,
    releaseIdentity,
    exportRoot,
    sourceRoot,
    runner
  });
  
  if (!preflightResults.ok) {
    const r = preflightResults.results.find((res) => res.provider_id === provider.id);
    if (r && !r.ok) {
      throw new ReleasepressError(r.blocker, r.details.reason, {
        provider_id: provider.id
      });
    }
  }

  const builtin = BUILTIN_PROVIDERS[provider.kind];
  if (builtin) {
    return builtin({
      provider,
      config,
      exportRoot,
      sourceRoot,
      runner
    });
  }

  const pluginName = config.delivery?.plugins?.[provider.kind];
  if (pluginName) {
    let plugin;
    try {
      plugin = require(pluginName);
    } catch (error) {
      throw new ReleasepressError("delivery_plugin_load_failed", `Failed to load delivery plugin for kind '${provider.kind}': ${error.message}`, {
        provider_id: provider.id,
        kind: provider.kind,
        plugin: pluginName
      });
    }

    const promoteFunc = plugin.promote ?? (typeof plugin === "function" ? plugin : null);
    if (typeof promoteFunc !== "function") {
      throw new ReleasepressError("delivery_plugin_invalid", `Plugin '${pluginName}' does not export a promote function`, {
        provider_id: provider.id,
        kind: provider.kind,
        plugin: pluginName
      });
    }

    return promoteFunc({
      provider,
      config,
      exportRoot,
      sourceRoot,
      runner
    });
  }

  throw new ReleasepressError("delivery_provider_unsupported", "Delivery provider kind is not supported", {
    provider_id: provider.id,
    kind: provider.kind,
    provider: provider.provider
  });
}

function findProvider(config, providerId) {
  if (!providerId) {
    throw new ReleasepressError("missing_provider", "Provider id is required");
  }
  const provider = (config.delivery?.providers ?? []).find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new ReleasepressError("delivery_provider_unknown", "Delivery provider is not configured", {
      provider_id: providerId
    });
  }
  return provider;
}
