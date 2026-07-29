import { spawnSync } from "node:child_process";
import { ReleasepressError } from "./config.js";
import { redactTargetValue } from "./target.js";

const LAUNCHER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LAUNCHER_OUTPUT_BYTES = 1024 * 1024;

export function runLauncher({
  id,
  argv,
  cwd,
  env = process.env,
  runner = spawnSync,
  interactive = true,
  errorCode = "launcher_command_failed"
}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ReleasepressError("launcher_argv_missing", "Launcher argv must be a non-empty array", { id });
  }

  const result = runner(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    stdio: interactive ? "inherit" : "pipe",
    encoding: interactive ? undefined : "utf8",
    timeout: LAUNCHER_TIMEOUT_MS,
    maxBuffer: MAX_LAUNCHER_OUTPUT_BYTES
  });
  const status = typeof result.status === "number" ? result.status : result.error ? 1 : 0;
  if (status !== 0) {
    const timedOut = result.error?.code === "ETIMEDOUT";
    const blockerReason = timedOut
      ? `Launcher command timed out after ${LAUNCHER_TIMEOUT_MS}ms`
      : `Launcher command failed with exit code ${status}`;
    throw new ReleasepressError(errorCode, "Provider launcher command failed", {
      id,
      argv: redactArgv(argv),
      status,
      error_code: result.error?.code ?? null,
      timeout_ms: LAUNCHER_TIMEOUT_MS,
      stderr: interactive || timedOut ? null : redactTargetValue(String(result.stderr || "").trim()),
      reason: blockerReason
    });
  }

  return {
    id,
    argv: redactArgv(argv),
    status,
    cwd
  };
}

export function redactArgv(argv) {
  return argv.map((arg) => redactTargetValue(arg));
}
