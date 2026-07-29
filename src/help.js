import { COMMANDS } from "./commands.js";
import { ReleasepressError } from "./config.js";

export function getHelp(commandName = null) {
  if (commandName) {
    // Check legacy commands
    if (commandName.startsWith("promote ") && !["promote local", "promote provider", "promote public"].includes(commandName)) {
      const provider = commandName.split(" ")[1];
      throw new ReleasepressError(
        "legacy_public_promote_command_unsupported",
        `promote ${provider} has been replaced by promote provider <id>`,
        {
          legacy_command: `promote ${provider}`,
          replacement: "promote provider <id>",
          approval: "--approve-public <id>"
        }
      );
    }

    const command = COMMANDS.find((candidate) => candidate.name === commandName);
    if (!command) {
      throw new ReleasepressError("unknown_help_topic", `Unknown command or help topic: ${commandName}`, {
        topic: commandName
      });
    }

    return {
      ok: true,
      type: "releasepress_help",
      command: commandName,
      commands: [command],
      safety: [
        "stage is not delivery",
        "public review is not delivery",
        "local promote is not public release",
        "provider delivery requires exact human review attestation",
        "do not bypass Releasepress with raw git push or npm publish"
      ]
    };
  }

  return {
    ok: true,
    type: "releasepress_help",
    command: null,
    commands: COMMANDS,
    safety: [
      "stage is not delivery",
      "public review is not delivery",
      "local promote is not public release",
      "provider delivery requires exact human review attestation",
      "do not bypass Releasepress with raw git push or npm publish"
    ]
  };
}

export function formatHelp(packet) {
  if (packet.command && packet.commands.length === 1) {
    const cmd = packet.commands[0];
    const lines = [
      `releasepress ${cmd.name}`,
      "",
      "Purpose:",
      `  ${cmd.summary}`,
      "",
      "Usage:",
      `  ${cmd.usage}`
    ];

    if (cmd.requiredFlags.length > 0) {
      lines.push("", "Required Flags:");
      for (const flag of cmd.requiredFlags) {
        lines.push(`  ${flag}`);
      }
    }

    if (cmd.optionalFlags.length > 0) {
      lines.push("", "Optional Flags:");
      for (const flag of cmd.optionalFlags) {
        lines.push(`  ${flag}`);
      }
    }

    if (cmd.approvalFlags.length > 0) {
      lines.push("", "Approvals:");
      for (const flag of cmd.approvalFlags) {
        lines.push(`  ${flag}`);
      }
    }

    if (cmd.reports.length > 0) {
      lines.push("", "Report Files:");
      for (const r of cmd.reports) {
        lines.push(`  ${r}`);
      }
    }

    if (cmd.examples.length > 0) {
      lines.push("", "Examples:");
      for (const ex of cmd.examples) {
        lines.push(`  ${ex}`);
      }
    }

    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    "releasepress",
    "",
    "Releasepress builds and verifies reviewable public candidates before any local or provider delivery.",
    "",
    "Commands:"
  ];
  for (const command of packet.commands) {
    lines.push(`  ${command.usage}`);
    lines.push(`    ${command.summary}`);
  }
  lines.push("");
  lines.push("Safety:");
  for (const item of packet.safety) {
    lines.push(`  - ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatHumanResult(packet) {
  const status = packet.type === "releasepress_release_status" ? packet : null;
  if (!status) {
    return `${JSON.stringify(packet, null, 2)}\n`;
  }
  const lines = [
    "releasepress release status",
    "",
    `candidate: ${status.candidate?.state ?? "unknown"} ${status.candidate?.tree_fingerprint ?? ""}`.trim(),
    formatTargetLine("stage", status.stage),
    formatTargetLine("review", status.review),
    `attestation: ${status.attestation?.state ?? "unknown"}${status.attestation?.reason ? ` (${status.attestation.reason})` : ""}`,
    `local promote: ${status.local_promote?.state ?? "unknown"}${status.local_promote?.reason ? ` (${status.local_promote.reason})` : ""}`,
    "delivery:"
  ];
  for (const provider of status.delivery?.providers ?? []) {
    const target = provider.ref ?? provider.channel ?? provider.repo ?? "";
    lines.push(`  ${provider.target_id}: ${provider.state}${target ? ` -> ${target}` : ""}${provider.reason ? ` (${provider.reason})` : ""}`);
  }
  if (status.next_actions?.length) {
    lines.push("");
    lines.push("next:");
    for (const action of status.next_actions) {
      lines.push(`  ${action}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatTargetLine(label, value) {
  const state = value?.state ?? "unknown";
  const target = [value?.repo, value?.ref, value?.commit].filter(Boolean).join(" ");
  const reason = value?.reason ? ` (${value.reason})` : "";
  return `${label}: ${state}${target ? ` -> ${target}` : ""}${reason}`;
}
