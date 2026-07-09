import { spawnSync } from "node:child_process";
import { ReleasepressError } from "./config.js";
import { redactTargetValue } from "./target.js";

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
    encoding: interactive ? undefined : "utf8"
  });
  const status = typeof result.status === "number" ? result.status : result.error ? 1 : 0;
  if (status !== 0) {
    throw new ReleasepressError(errorCode, "Provider launcher command failed", {
      id,
      argv: redactArgv(argv),
      status,
      error_code: result.error?.code ?? null,
      stderr: interactive ? null : redactTargetValue(String(result.stderr || "").trim())
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
