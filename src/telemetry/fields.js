import crypto from "node:crypto";
import path from "node:path";

const TELEMETRY_COMMANDS = new Set(["export", "scan", "package", "preflight", "checklist", "stage", "verify", "local prepare", "promote local"]);
const REPORT_BY_COMMAND = new Map([
  ["export", ".releasepress-report/public-files.json"],
  ["scan", ".releasepress-report/scan-results.json"],
  ["package", ".releasepress-report/package-files.json"],
  ["preflight", ".releasepress-report/preflight-results.json"],
  ["checklist", ".releasepress-report/checklist.json"],
  ["stage", ".releasepress-report/stage-results.json"],
  ["verify", ".releasepress-report/verify-results.json"],
  ["local prepare", ".releasepress-report/local-prepare.json"],
  ["promote local", ".releasepress-report/local-promote.json"]
]);

const NOT_AUTHORITY_FOR = [
  "evidence",
  "judgment",
  "merge",
  "release",
  "lane",
  "gate",
  "proof",
  "security",
  "replay",
  "contract",
  "attestation",
  "packet_authority"
];

export function buildTelemetryDiagnosticEvent({
  command,
  packet,
  sourceRoot = process.cwd(),
  now = new Date()
}) {
  if (!TELEMETRY_COMMANDS.has(command) || packet?.ok !== false) {
    return null;
  }

  const summary = summarizeCommandFailure(command, packet);
  const commandRef = `releasepress ${command}`;
  const reasonCodes = reasonCodesFor({ command, packet, classification: summary.classification });
  const evidenceRefs = buildEvidenceRefs(command, commandRef, summary.snippets);
  const eventCore = {
    producer: "releasepress",
    classification: summary.classification,
    scope: {
      tool: "releasepress",
      command: commandRef,
      workspace_kind: "repo"
    },
    summary: safeText(summary.actual, 320),
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs
  };
  const fingerprint = digestOf(eventCore);
  const time = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const event = {
    specversion: "1.0",
    type: "diagnostic.event.v1",
    id: `diag_releasepress_${fingerprint.slice("sha256:".length, "sha256:".length + 24)}`,
    source: "urn:atteware:tool:releasepress",
    time,
    producer: {
      id: "releasepress"
    },
    authority: "telemetry_only",
    classification: eventCore.classification,
    severity: severityFor(eventCore.classification),
    scope: eventCore.scope,
    summary: eventCore.summary,
    reason_codes: eventCore.reason_codes,
    evidence_refs: eventCore.evidence_refs,
    dedupe: {
      strategy: "semantic_fingerprint",
      fingerprint
    },
    privacy: {
      data_classification: "internal_only",
      redaction: "summary_only",
      contains_raw_logs: false,
      contains_env_dump: false,
      contains_prompts: false,
      contains_secrets: false,
      contains_provider_private_payloads: false
    },
    not_authority_for: NOT_AUTHORITY_FOR
  };

  return {
    type: "releasepress_telemetry_diagnostic_event",
    command,
    event
  };
}

export function commandSupportsTelemetry(command) {
  return TELEMETRY_COMMANDS.has(command);
}

function buildEvidenceRefs(command, commandRef, snippets = []) {
  const snippetSummary = summarizeSnippets(snippets);
  const refs = [
    safeText(`command:${commandRef}#${digestOf({ command: commandRef })}`, 220)
  ];
  if (snippetSummary) {
    refs.push(safeText(`summary:${snippetSummary}`, 220));
  }
  const report = REPORT_BY_COMMAND.get(command);
  if (report) {
    refs.push(safeText(`artifact:${report}#${digestOf({ command, report })}`, 220));
  }
  return refs;
}

function summarizeSnippets(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) {
    return null;
  }
  return safeText(snippets.map(([label, text]) => `${safeKey(label)}:${safeText(text, 160)}`).join("; "), 240);
}

function reasonCodesFor({ command, packet, classification }) {
  const commandCode = reasonCode(`releasepress_${command.replaceAll(" ", "_")}_failed`);
  const errorCode = typeof packet?.error?.code === "string" ? reasonCode(packet.error.code) : null;
  return [...new Set([commandCode, errorCode, reasonCode(classification)].filter(Boolean))].slice(0, 12);
}

function reasonCode(value) {
  const code = safeKey(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return code || "releasepress_failure";
}

function severityFor(classification) {
  return classification === "provider_failure" ? "error" : "warning";
}

function digestOf(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function summarizeCommandFailure(command, packet) {
  if (command === "export") {
    return summarizeExport(packet);
  }
  if (command === "scan") {
    return summarizeScan(packet);
  }
  if (command === "package") {
    return summarizePackage(packet);
  }
  if (command === "checklist") {
    return summarizeChecklist(packet);
  }
  if (command === "stage") {
    return summarizeStage(packet);
  }
  if (command === "verify") {
    return summarizeVerify(packet);
  }
  if (command === "promote local") {
    return summarizePromoteLocal(packet);
  }
  if (command === "local prepare") {
    return summarizeLocalPrepare(packet);
  }
  return summarizeStructuredError(command, packet);
}

function summarizeExport(packet) {
  const code = safeText(packet.error?.code ?? "export_failed");
  const details = objectOrEmpty(packet.error?.details);
  const snippets = [snippet("summary", `error_code=${code}`)];
  if (typeof details.path === "string") {
    snippets.push(snippet("path", `path=${details.path}`));
  }
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress export failed with ${code}.`),
    snippets,
    suggestedNextAction: "Inspect the export error, fix the allowlist or selected path, then rerun releasepress export."
  };
}

function summarizeScan(packet) {
  const findings = Array.isArray(packet.findings) ? packet.findings : [];
  const detectorCounts = countBy(findings, (finding) => finding?.detector ?? "unknown_detector");
  const detectorSummary = formatCounts(detectorCounts) || "no detector ids reported";
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress scan reported ${findings.length} finding(s): ${detectorSummary}.`),
    snippets: [
      snippet("summary", `finding_count=${findings.length}`),
      snippet("detectors", detectorSummary)
    ],
    suggestedNextAction: "Inspect the scan report, remove private material from the export candidate, then rerun scan."
  };
}

function summarizePackage(packet) {
  const errorCode = packet.error?.code ?? null;
  if (errorCode === "package_command_failed") {
    const details = objectOrEmpty(packet.error?.details);
    const commandName = safeCommandName(Array.isArray(details.argv) ? details.argv[0] : "package_command");
    const status = details.status === null || details.status === undefined ? "unknown" : String(details.status);
    return {
      classification: "provider_failure",
      actual: safeText(`releasepress package command ${commandName} failed with status ${status}.`),
      snippets: [
        snippet("summary", `error_code=package_command_failed status=${safeText(status)}`),
        snippet("command", `command=${commandName}`)
      ],
      suggestedNextAction: "Run the package dry-run command locally, fix the package surface failure, then rerun releasepress package."
    };
  }

  const violations = packageViolations(packet);
  const patternCounts = countBy(violations, (violation) => violation?.pattern ?? "unknown_pattern");
  const patternSummary = formatCounts(patternCounts) || "no must-exclude patterns reported";
  const code = safeText(errorCode ?? "package_surface_failed");
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress package failed ${code} with ${violations.length} must-exclude violation(s).`),
    snippets: [
      snippet("summary", `error_code=${code} violation_count=${violations.length}`),
      snippet("patterns", patternSummary)
    ],
    suggestedNextAction: "Inspect the package report, adjust package files or must-exclude policy, then rerun releasepress package."
  };
}

function summarizeChecklist(packet) {
  const blockers = Array.isArray(packet.promote?.blockers) ? packet.promote.blockers : [];
  const blockerCounts = countBy(blockers, (blocker) => `${blocker?.step ?? "unknown_step"}:${blocker?.reason ?? "not_satisfied"}`);
  const blockerSummary = formatCounts(blockerCounts) || "no blocker ids reported";
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress checklist reported ${blockers.length} promote blocker(s): ${blockerSummary}.`),
    snippets: [
      snippet("summary", `blocker_count=${blockers.length}`),
      snippet("blockers", blockerSummary)
    ],
    suggestedNextAction: "Inspect the checklist report, complete the missing release reports, then rerun checklist."
  };
}

function summarizeStage(packet) {
  const code = safeText(packet.error?.code ?? "stage_failed");
  const details = objectOrEmpty(packet.error?.details);
  const snippets = [snippet("summary", `error_code=${code}`)];
  if (typeof details.strategy === "string") {
    snippets.push(snippet("strategy", `strategy=${details.strategy}`));
  }
  if (typeof details.ref === "string") {
    snippets.push(snippet("ref", `ref=${details.ref}`));
  }
  return {
    classification: code === "stage_publish_failed" ? "provider_failure" : "unexpected_blocker",
    actual: safeText(`releasepress stage failed with ${code}.`),
    snippets,
    suggestedNextAction: "Inspect the stage error, fix the private stage target or strategy, then rerun releasepress stage."
  };
}

function summarizeVerify(packet) {
  const blockers = Array.isArray(packet.blockers) ? packet.blockers : [];
  const blockerCounts = countBy(blockers, (blocker) => `${blocker?.check ?? "unknown_check"}:${blocker?.reason ?? "not_satisfied"}`);
  const checkCounts = countBy(
    Array.isArray(packet.checks) ? packet.checks.filter((check) => check?.ok === false) : [],
    (check) => `${check?.id ?? "unknown_check"}:${check?.reason ?? "not_satisfied"}`
  );
  const blockerSummary = formatCounts(blockerCounts) || "no verify blocker ids reported";
  const checkSummary = formatCounts(checkCounts) || "no failed check ids reported";
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress verify reported ${blockers.length} blocker(s): ${blockerSummary}.`),
    snippets: [
      snippet("summary", `blocker_count=${blockers.length}`),
      snippet("blockers", blockerSummary),
      snippet("checks", checkSummary)
    ],
    suggestedNextAction: "Inspect the verify report, resolve failed checks, then rerun verify."
  };
}

function summarizePromoteLocal(packet) {
  const code = safeText(packet.error?.code ?? "local_promote_failed");
  const details = objectOrEmpty(packet.error?.details);
  const snippets = [snippet("summary", `error_code=${code}`)];
  if (Array.isArray(details.blockers)) {
    snippets.push(snippet("blockers", `blocker_count=${details.blockers.length}`));
  }
  return {
    classification: code === "local_promote_command_failed" ? "provider_failure" : "unexpected_blocker",
    actual: safeText(`releasepress promote local failed with ${code}.`),
    snippets,
    suggestedNextAction: "Inspect the local promote gate reports, fix the local install blocker, then rerun promote local."
  };
}

function summarizeLocalPrepare(packet) {
  const code = safeText(packet.error?.code ?? (packet.ok === false ? "local_prepare_checks_failed" : "local_prepare_failed"));
  const checks = Array.isArray(packet.checks) ? packet.checks : [];
  const failed = checks.filter((check) => check?.ok === false);
  return {
    classification: "unexpected_blocker",
    actual: safeText(`releasepress local prepare failed with ${code}.`),
    snippets: [
      snippet("summary", `error_code=${code}`),
      snippet("checks", `failed_check_count=${failed.length}`)
    ],
    suggestedNextAction: "Fix the clean-source or configured local preparation check failure, then rerun local prepare."
  };
}

function summarizeStructuredError(command, packet) {
  const code = safeText(packet.error?.code ?? "unknown_error");
  const classification = code.includes("command") ? "provider_failure" : "unexpected_blocker";
  return {
    classification,
    actual: safeText(`releasepress ${command} failed with ${code}.`),
    snippets: [snippet("summary", `error_code=${code}`)],
    suggestedNextAction: `Inspect the ${command} command error and rerun after the release-safety blocker is fixed.`
  };
}

function packageViolations(packet) {
  if (Array.isArray(packet.violations)) {
    return packet.violations;
  }
  if (Array.isArray(packet.error?.details?.violations)) {
    return packet.error.details.violations;
  }
  return [];
}

function snippet(label, text) {
  return [safeKey(label), safeText(text, 1200)];
}

function countBy(items, selectKey) {
  const counts = new Map();
  for (const item of items) {
    const key = safeText(selectKey(item) ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts) {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function safeCommandName(value) {
  const command = path.basename(String(value || "command").replace(/\\/g, "/"));
  return safeText(command || "command", 128);
}

function safeKey(value) {
  const key = String(value ?? "unknown").trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  return key && !key.startsWith("-") ? key : "unknown";
}

function safeText(value, maxLength = 1000) {
  let text = String(value ?? "unknown").trim();
  if (!text) {
    text = "unknown";
  }
  text = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted_secret]")
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1=[redacted_secret]")
    .replace(/\b(access_token|token|api_key|password|secret)=([^&\s]+)/gi, "$1=[redacted_secret]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted_secret]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted_secret]")
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/gi, "[redacted_secret]")
    .replace(/\bGITEA_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/g, "GITEA_TOKEN=[redacted_secret]")
    .replace(/(?:\/Users\/[^\s"'`),]+|\/home\/[^\s"'`),]+|\/private\/tmp\/[^\s"'`),]+|\/private\/var\/folders\/[^\s"'`),]+|\/var\/folders\/[^\s"'`),]+|\/tmp\/[^\s"'`),]+|\/Volumes\/[^\s"'`),]+|~\/[^\s"'`),]+)/g, "[redacted_path]");

  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}[truncated]`;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
