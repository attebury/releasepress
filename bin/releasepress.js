#!/usr/bin/env node
import { getBoundary } from "../src/boundary.js";
import { attestPublicReview } from "../src/attest.js";
import { createChecklist } from "../src/checklist.js";
import { loadConfig, ReleasepressError, structuredError } from "../src/config.js";
import { emitTelemetryDiagnostic } from "../src/telemetry/emitter.js";
import { buildTelemetryDiagnosticFields, commandSupportsTelemetry } from "../src/telemetry/fields.js";
import { createExport, stageExport } from "../src/export.js";
import { runPackageSurface } from "../src/package-surface.js";
import { createPlan } from "../src/plan.js";
import { runPreflight } from "../src/preflight.js";
import { promoteLocal } from "../src/promote-local.js";
import { promoteProvider } from "../src/promote-provider.js";
import { promotePublic } from "../src/promote-public.js";
import { publishPublicReview } from "../src/public-review.js";
import {
  attestReviewForRelease,
  deliverRelease,
  prepareRelease,
  publishReviewForRelease,
  releasePlan
} from "../src/release-flow.js";
import { createReleaseStatus } from "../src/release-status.js";
import { scanPath } from "../src/scan.js";
import { verifyRelease } from "../src/verify.js";
import { formatHelp, formatHumanResult, getHelp } from "../src/help.js";
import { formatVersionText, getVersionInfo } from "../src/version-info.js";

function getNonFlags(argv) {
  const nonFlags = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key !== "json" && key !== "help" && key !== "approve-local" && key !== "approve-public-review") {
        index += 1;
      }
      continue;
    }
    nonFlags.push(arg);
  }
  return nonFlags;
}

import { COMMANDS } from "../src/commands.js";

function resolveCommandAndArgs(nonFlags) {
  if (nonFlags.length === 0) {
    return { command: null, positionals: [] };
  }

  if (nonFlags.length >= 2 && nonFlags[0] === "promote") {
    const sub = nonFlags[1];
    if (sub !== "local" && sub !== "provider" && sub !== "public") {
      throw legacyPromoteCommandError(sub);
    }
  }

  if (nonFlags.length >= 2) {
    const name2 = nonFlags.slice(0, 2).join(" ");
    const cmd = COMMANDS.find(c => c.name === name2);
    if (cmd) {
      return { command: cmd, positionals: nonFlags.slice(2) };
    }
  }

  const name1 = nonFlags[0];
  const cmd1 = COMMANDS.find(c => c.name === name1);
  if (cmd1) {
    return { command: cmd1, positionals: nonFlags.slice(1) };
  }

  throw new ReleasepressError("unknown_command", "Unknown command", {
    command: nonFlags.join(" ")
  });
}

function main(argv) {
  if (isVersionRoute(argv)) {
    writeVersionCommand(argv);
    return;
  }

  const flags = parseFlags(argv);
  const json = flags.json === true;
  let configForDiagnostics = null;
  let sourceRootForDiagnostics = flags.source || process.cwd();

  const nonFlags = getNonFlags(argv);

  let telemetryCommand = null;

  try {
    let result;

    // Check if it is a help route
    if (
      nonFlags.length === 0 ||
      nonFlags[0] === "help" ||
      flags.help === true ||
      argv.includes("--help") ||
      argv.includes("-h")
    ) {
      let topic = null;
      if (nonFlags[0] === "help") {
        topic = nonFlags.slice(1).join(" ");
      } else {
        topic = nonFlags.join(" ");
      }
      if (topic === "") {
        topic = null;
      }
      result = getHelp(topic);
      writeHelpResult(result, json);
      return;
    }

    const resolved = resolveCommandAndArgs(nonFlags);
    if (resolved && resolved.command) {
      telemetryCommand = telemetryCommandName(resolved.command.name);
    }

    const cmdName = resolved.command.name;
    if (cmdName === "boundary") {
      result = getBoundary();
    } else if (cmdName === "plan") {
      const config = loadConfig(flags.config);
      result = createPlan({ config });
    } else if (cmdName === "export") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = createExport({ config, outDir: flags.out, sourceRoot: flags.source || process.cwd() });
    } else if (cmdName === "scan") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = scanPath({ config, root: flags.path });
      if (!result.ok) {
        process.exitCode = 1;
      }
    } else if (cmdName === "package") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      result = runPackageSurface({
        config,
        sourceRoot: flags.source || process.cwd(),
        exportRoot: flags.path || null
      });
    } else if (cmdName === "preflight") {
      const config = loadConfig(flags.config);
      result = runPreflight({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd()
      });
      if (!result.ok) {
        process.exitCode = 1;
      }
    } else if (cmdName === "stage") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = stageExport({ config, exportRoot: flags.path });
    } else if (cmdName === "public-review") {
      const config = loadConfig(flags.config);
      result = publishPublicReview({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd()
      });
    } else if (cmdName === "attest-review") {
      const config = loadConfig(flags.config);
      result = attestPublicReview({
        config,
        exportRoot: flags.path,
        approved: flags.approve_public_review === true,
        reviewTarget: flags.target || null,
        reviewedCommit: flags.reviewed_commit || null,
        reviewer: flags.reviewer || "operator",
        reason: flags.reason || null
      });
    } else if (cmdName === "checklist") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = createChecklist({
        config,
        exportRoot: flags.path || null,
        sourceRoot: flags.source || process.cwd()
      });
      if (flags.path && !result.ok) {
        process.exitCode = 1;
      }
    } else if (cmdName === "release plan") {
      const config = loadConfig(flags.config);
      result = releasePlan({ config, sourceRoot: flags.source || process.cwd() });
    } else if (cmdName === "release status") {
      const config = loadConfig(flags.config);
      result = createReleaseStatus({
        config,
        exportRoot: flags.path || null,
        sourceRoot: flags.source || process.cwd()
      });
    } else if (cmdName === "release prepare") {
      const config = loadConfig(flags.config);
      result = prepareRelease({
        config,
        outDir: flags.out,
        sourceRoot: flags.source || process.cwd()
      });
    } else if (cmdName === "release publish-review") {
      const config = loadConfig(flags.config);
      result = publishReviewForRelease({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        target: flags.target || null
      });
    } else if (cmdName === "release attest") {
      const config = loadConfig(flags.config);
      result = attestReviewForRelease({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        target: flags.target || null,
        reviewedCommit: flags.reviewed_commit || null,
        approved: flags.approve_public_review === true,
        reviewer: flags.reviewer || "operator",
        reason: flags.reason || null
      });
    } else if (cmdName === "release deliver") {
      const config = loadConfig(flags.config);
      result = deliverRelease({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        target: flags.target,
        approvedProviderId: flags.approve_public
      });
    } else if (cmdName === "promote public") {
      const config = loadConfig(flags.config);
      result = promotePublic({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        approved: flags.approve_public === "public"
      });
    } else if (cmdName === "promote provider") {
      const config = loadConfig(flags.config);
      const providerId = resolved.positionals[0] || null;
      result = promoteProvider({
        providerId,
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        approvedProviderId: flags.approve_public
      });
    } else if (cmdName === "promote local") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = promoteLocal({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd(),
        approved: flags.approve_local === true
      });
    } else if (cmdName === "verify") {
      configForDiagnostics = loadConfig(flags.config);
      const config = configForDiagnostics;
      sourceRootForDiagnostics = flags.source || process.cwd();
      result = verifyRelease({
        config,
        exportRoot: flags.path,
        sourceRoot: flags.source || process.cwd()
      });
      if (!result.ok) {
        process.exitCode = 1;
      }
    }

    result = attachTelemetryDiagnostics({
      command: telemetryCommand,
      result,
      config: configForDiagnostics,
      sourceRoot: sourceRootForDiagnostics
    });
    writeResult(result, json);
  } catch (error) {
    process.exitCode = 1;
    const result = attachTelemetryDiagnostics({
      command: telemetryCommand,
      result: structuredError(error),
      config: configForDiagnostics,
      sourceRoot: sourceRootForDiagnostics
    });
    writeResult(result, json);
  }
}

function isVersionRoute(argv) {
  return argv[0] === "--version" || argv[0] === "version";
}

function writeVersionCommand(argv) {
  let json = argv.includes("--json");
  try {
    const route = parseVersionRoute(argv);
    json = route.json;
    const result = getVersionInfo();
    writeVersionResult(result, json);
  } catch (error) {
    process.exitCode = 1;
    writeResult(structuredError(error), json);
  }
}

function parseVersionRoute(argv) {
  if (argv[0] === "--version") {
    if (argv.length !== 1) {
      throw new ReleasepressError("unknown_version_flag", "--version does not accept arguments", {
        allowed: ["releasepress --version"]
      });
    }
    return { json: false };
  }

  const args = argv.slice(1);
  if (args.length === 0) {
    return { json: false };
  }
  if (args.length === 1 && args[0] === "--json") {
    return { json: true };
  }

  throw new ReleasepressError("unknown_version_flag", "version only accepts --json", {
    received: args,
    allowed: ["releasepress version", "releasepress version --json"]
  });
}

function writeVersionResult(result, json) {
  if (json) {
    writeResult(result, true);
    return;
  }
  process.stdout.write(`${formatVersionText(result)}\n`);
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    if (key === "json" || key === "help" || key === "approve-local" || key === "approve-public-review") {
      flags[key.replace(/-/g, "_")] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ReleasepressError("missing_flag_value", `--${key} requires a value`);
    }
    flags[key.replace(/-/g, "_")] = value;
    index += 1;
  }
  return flags;
}

function writeHelpResult(result, json) {
  if (json) {
    writeResult(result, true);
    return;
  }
  process.stdout.write(formatHelp(result));
}
function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatHumanResult(result));
}

function attachTelemetryDiagnostics({ command, result, config, sourceRoot }) {
  if (!commandSupportsTelemetry(command) || !config) {
    return result;
  }

  const candidate = buildTelemetryDiagnosticFields({ command, packet: result, sourceRoot });
  if (!candidate) {
    return result;
  }

  const telemetryResult = emitTelemetryDiagnostic({ config, candidate, sourceRoot });
  if (!telemetryResult.enabled && !telemetryResult.attempted) {
    return result;
  }

  return {
    ...result,
    diagnostics: {
      ...(result.diagnostics ?? {}),
      telemetry: telemetryResult
    }
  };
}

function telemetryCommandName(commandName) {
  if (commandName === "promote local") {
    return "promote local";
  }
  if (commandName.startsWith("release ")) {
    return "release";
  }
  if (commandName.startsWith("promote ")) {
    return "promote";
  }
  return commandName;
}

function legacyPromoteCommandError(provider) {
  return new ReleasepressError(
    "legacy_public_promote_command_unsupported",
    `promote ${provider} has been replaced by promote provider <id>`,
    {
      legacy_command: `promote ${provider}`,
      replacement: "promote provider <id>",
      approval: "--approve-public <id>"
    }
  );
}

main(process.argv.slice(2));
