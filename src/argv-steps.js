import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withBoundedNpmCacheEnv } from "./npm-env.js";

export function runConfiguredArgvStep({
  step,
  cwd,
  timeoutMs,
  packetType = "releasepress_preflight_step",
  timeoutCode = "preflight_step_timeout",
  runner = spawnSync
}) {
  const startedAt = Date.now();
  if (step.argv[0] === "npm" && !fs.existsSync(path.join(cwd, "package.json"))) {
    return {
      type: packetType,
      id: step.id,
      ok: true,
      required: step.required,
      skipped: true,
      skip_reason: "package_json_missing",
      duration_ms: Date.now() - startedAt,
      exit_code: null
    };
  }

  const result = runner(step.argv[0], step.argv.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    env: withBoundedNpmCacheEnv(process.env)
  });
  const timedOut = result.error?.code === "ETIMEDOUT";

  return {
    type: packetType,
    id: step.id,
    ok: result.status === 0 && !timedOut,
    required: step.required,
    skipped: false,
    duration_ms: Date.now() - startedAt,
    exit_code: result.status ?? null,
    signal: result.signal ?? null,
    error_code: timedOut ? timeoutCode : result.error?.code ?? null
  };
}
