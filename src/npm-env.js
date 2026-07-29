import os from "node:os";
import path from "node:path";

const BOUNDED_CACHE_DIR_NAME = "releasepress-npm-cache";

export function boundedNpmCacheDir() {
  return path.join(os.tmpdir(), BOUNDED_CACHE_DIR_NAME);
}

export function withBoundedNpmCacheEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    NPM_CONFIG_CACHE: baseEnv.NPM_CONFIG_CACHE || boundedNpmCacheDir()
  };
}
