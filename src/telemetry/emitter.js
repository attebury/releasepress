import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function emitTelemetryDiagnostic({
  config,
  candidate,
  sourceRoot = process.cwd(),
  runner = spawnSync
}) {
  const telemetry = config?.diagnostics?.telemetry;
  if (!telemetry?.enabled) {
    return { enabled: false, attempted: false };
  }
  if (!candidate?.event) {
    return { enabled: true, attempted: false, reason: "not_applicable" };
  }

  const cwd = resolveTelemetryCwd({ telemetry, sourceRoot });
  if (!cwd.ok) {
    return advisoryFailure({
      attempted: false,
      warning: cwd.warning,
      classification: "resource_failure"
    });
  }

  let tempDir = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "releasepress-telemetry-"));
    const eventFile = path.join(tempDir, "diagnostic-event.json");
    fs.writeFileSync(eventFile, `${JSON.stringify(candidate.event, null, 2)}\n`, "utf8");
    const argv = telemetry.command_argv.map((arg) => arg === "{file}" ? eventFile : arg);
    const result = runner(argv[0], argv.slice(1), {
      cwd: cwd.path,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      shell: false
    });

    if (result.error) {
      return advisoryFailure({
        attempted: true,
        warning: result.error.code === "ENOENT" ? "telemetry_cli_unavailable" : "telemetry_spawn_failed",
        classification: "resource_failure",
        error_code: result.error.code ?? null
      });
    }
    if (result.status !== 0) {
      return advisoryFailure({
        attempted: true,
        warning: "telemetry_emit_failed",
        classification: "resource_failure",
        status: result.status ?? null
      });
    }

    const parsed = parseTelemetryResult(result.stdout);
    if (!parsed.ok) {
      return advisoryFailure({
        attempted: true,
        warning: parsed.warning,
        classification: "resource_failure"
      });
    }

    const eventId = parsed.value.event_id ?? parsed.value.event?.id ?? candidate.event.id ?? null;
    const fingerprint = parsed.value.fingerprint
      ?? parsed.value.event?.fingerprint
      ?? parsed.value.event?.source_packet_ref
      ?? candidate.event.dedupe?.fingerprint
      ?? null;
    const duplicate = parsed.value.duplicate ?? false;
    const appended = parsed.value.appended ?? parsed.value.stored ?? false;

    return {
      enabled: true,
      attempted: true,
      ok: true,
      event_id: stringOrNull(eventId),
      fingerprint: stringOrNull(fingerprint),
      duplicate: booleanOrNull(duplicate),
      appended: booleanOrNull(appended)
    };
  } catch (error) {
    return advisoryFailure({
      attempted: true,
      warning: error?.code === "ENOENT" ? "telemetry_cli_unavailable" : "telemetry_emit_failed",
      classification: "resource_failure",
      error_code: error?.code ?? null
    });
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function resolveTelemetryCwd({ telemetry, sourceRoot }) {
  if (telemetry.cwd !== "source") {
    return { ok: false, warning: "telemetry_cwd_unsupported" };
  }
  const resolved = path.resolve(sourceRoot || ".");
  try {
    const linkStat = fs.lstatSync(resolved);
    if (linkStat.isSymbolicLink()) {
      return { ok: false, warning: "telemetry_source_symlink" };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, warning: "telemetry_source_not_directory" };
    }
  } catch {
    return { ok: false, warning: "telemetry_source_unavailable" };
  }
  return { ok: true, path: resolved };
}

function parseTelemetryResult(stdout) {
  try {
    const value = JSON.parse(String(stdout || "").trim());
    return { ok: true, value };
  } catch {
    return { ok: false, warning: "telemetry_result_invalid" };
  }
}

function advisoryFailure(fields) {
  return {
    enabled: true,
    attempted: fields.attempted,
    ok: false,
    warning: fields.warning,
    classification: fields.classification,
    ...(fields.status !== undefined ? { status: fields.status } : {}),
    ...(fields.error_code !== undefined ? { error_code: fields.error_code } : {})
  };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
