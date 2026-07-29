import { createHash } from "node:crypto";
import { COMMANDS } from "./commands.js";
import { getVersionInfo } from "./version-info.js";

const NOT_AUTHORITY_FOR = [
  "execution_success",
  "release_readiness",
  "public_release",
  "merge",
  "forge_truth",
  "work_judgment",
  "telemetry",
  "attestation",
  "security",
  "human_approval"
];

export function buildCapabilityManifest({ commands = COMMANDS, versionInfo = getVersionInfo() } = {}) {
  const payload = {
    ok: true,
    type: "releasepress.capability_manifest.v1",
    schema_version: 1,
    tool_id: "releasepress",
    tool_version: versionInfo.version,
    manifest_version: 1,
    manifest_source: {
      kind: "tool_registry",
      ref: "src/commands.js"
    },
    commands: commands.map(commandToCapability),
    examples_are_authority: false,
    not_authority_for: NOT_AUTHORITY_FOR
  };

  return {
    ...payload,
    command_count: payload.commands.length,
    manifest_digest: digestObject(payload)
  };
}

export function validateCapabilityManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest_not_object"];
  }
  if (manifest.type !== "releasepress.capability_manifest.v1") errors.push("manifest_type_invalid");
  if (manifest.schema_version !== 1) errors.push("manifest_schema_version_invalid");
  if (manifest.tool_id !== "releasepress") errors.push("tool_id_invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.manifest_digest ?? "")) errors.push("manifest_digest_invalid");
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) errors.push("commands_missing");
  if (manifest.examples_are_authority !== false) errors.push("examples_authority_overclaim");
  if (!Array.isArray(manifest.not_authority_for) || !NOT_AUTHORITY_FOR.every((item) => manifest.not_authority_for.includes(item))) {
    errors.push("manifest_not_authority_for_incomplete");
  }

  for (const command of manifest.commands ?? []) {
    const label = command?.name ?? "unknown";
    for (const field of [
      "command_id",
      "capability_id",
      "name",
      "summary",
      "usage",
      "argv_template",
      "argument_schema",
      "required_flags",
      "optional_flags",
      "approval_flags",
      "approval_required",
      "mutates",
      "authority_class",
      "side_effects",
      "reports",
      "preconditions",
      "not_authority_for"
    ]) {
      if (!Object.hasOwn(command ?? {}, field)) {
        errors.push(`command_missing_${field}:${label}`);
      }
    }
    if (!Array.isArray(command?.argv_template) || command.argv_template[0] !== "releasepress") {
      errors.push(`command_argv_template_invalid:${label}`);
    }
    if (!command?.argument_schema || typeof command.argument_schema !== "object") {
      errors.push(`command_argument_schema_invalid:${label}`);
    }
    if (!Array.isArray(command?.approval_flags)) {
      errors.push(`command_approval_flags_invalid:${label}`);
    }
    if (!["read", "write", "release"].includes(command?.authority_class)) {
      errors.push(`command_authority_class_invalid:${label}`);
    }
    if (command?.authority_class === "release" && command.approval_required !== true) {
      errors.push(`release_command_missing_approval:${label}`);
    }
    if (!Array.isArray(command?.not_authority_for) || !NOT_AUTHORITY_FOR.every((item) => command.not_authority_for.includes(item))) {
      errors.push(`command_not_authority_for_incomplete:${label}`);
    }
  }
  return [...new Set(errors)];
}

function commandToCapability(command) {
  const commandId = command.name.replace(/\s+/g, ".").replace(/-/g, "_");
  const mutates = command.sideEffects === "write";
  return {
    command_id: commandId,
    capability_id: `releasepress.${commandId}`,
    name: command.name,
    summary: command.summary,
    usage: sanitizeCommandText(command.usage),
    argv_template: buildArgvTemplate(command),
    argument_schema: buildArgumentSchema(command),
    required_flags: [...command.requiredFlags],
    optional_flags: [...command.optionalFlags],
    approval_flags: [...command.approvalFlags],
    approval_required: command.approvalFlags.length > 0,
    mutates,
    authority_class: classifyAuthority(command, mutates),
    side_effects: command.sideEffects,
    reports: [...command.reports],
    output_packet_type: outputPacketType(command),
    preconditions: buildPreconditions(command),
    examples: command.examples.map((example) => ({
      value: sanitizeCommandText(example),
      authority: "documentation_only"
    })),
    not_authority_for: NOT_AUTHORITY_FOR
  };
}

function buildArgvTemplate(command) {
  const parts = command.usage.split(/\s+/).filter(Boolean);
  if (parts[0] !== "releasepress") {
    return ["releasepress", command.name, ...command.requiredFlags].filter(Boolean);
  }
  return parts.map((part) => {
    return sanitizeCommandText(part);
  });
}

function sanitizeCommandText(value) {
  return value.replace(/\/tmp\/releasepress\/public-tree/g, "workspace://public-tree");
}

function buildArgumentSchema(command) {
  const flags = {};
  for (const flag of [...command.requiredFlags, ...command.optionalFlags, ...command.approvalFlags]) {
    flags[flagToName(flag)] = {
      flag,
      required: command.requiredFlags.includes(flag),
      approval: command.approvalFlags.includes(flag),
      type: booleanFlag(flag) ? "boolean" : "string"
    };
  }

  return {
    type: "object",
    additional_properties: false,
    required: command.requiredFlags.map(flagToName),
    properties: flags,
    positionals: extractPositionals(command)
  };
}

function extractPositionals(command) {
  const commandParts = command.name.split(/\s+/);
  const usageParts = command.usage.split(/\s+/).slice(1);
  const afterCommand = usageParts.slice(commandParts.length);
  const positionals = [];
  for (const part of afterCommand) {
    if (part.startsWith("--")) {
      break;
    }
    if (/^<[^>]+>$/.test(part)) {
      positionals.push({
        name: part.slice(1, -1).replace(/-/g, "_"),
        required: true
      });
    }
  }
  return positionals;
}

function buildPreconditions(command) {
  const preconditions = [
    {
      id: "capability_manifest_current",
      kind: "manifest",
      status: "required"
    }
  ];
  if (command.requiredFlags.includes("--config")) {
    preconditions.push({
      id: "releasepress_config_valid",
      kind: "config",
      status: "required"
    });
  }
  if (command.requiredFlags.includes("--path") || command.requiredFlags.includes("--out")) {
    preconditions.push({
      id: "workspace_target_available",
      kind: "workspace",
      status: "required"
    });
  }
  if (command.approvalFlags.length > 0) {
    preconditions.push({
      id: "operator_approval_present",
      kind: "approval",
      status: "required"
    });
  }
  return preconditions;
}

function classifyAuthority(command, mutates) {
  if (!mutates) {
    return command.sideEffects === "none" ? "read" : "read";
  }
  if (command.name.startsWith("promote") || command.name.startsWith("release deliver")) {
    return "release";
  }
  return "write";
}

function outputPacketType(command) {
  return `releasepress.${command.name.replace(/\s+/g, "_")}.v1`;
}

function flagToName(flag) {
  return flag.replace(/^--/, "").replace(/-/g, "_");
}

function booleanFlag(flag) {
  return flag === "--json" || flag.startsWith("--approve-");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digestObject(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
