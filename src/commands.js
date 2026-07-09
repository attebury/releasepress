export const COMMANDS = [
  {
    name: "boundary",
    summary: "Describe Releasepress authority boundaries.",
    usage: "releasepress boundary --json",
    requiredFlags: [],
    optionalFlags: [],
    approvalFlags: [],
    sideEffects: "none",
    reports: [],
    examples: ["releasepress boundary --json"]
  },
  {
    name: "version",
    summary: "Print the Releasepress version without requiring repo, config, lane, or forge context.",
    usage: "releasepress version --json",
    requiredFlags: [],
    optionalFlags: [],
    approvalFlags: [],
    sideEffects: "none",
    reports: [],
    examples: ["releasepress version", "releasepress version --json"]
  },
  {
    name: "plan",
    summary: "Plan export, stage, review, and delivery surfaces.",
    usage: "releasepress plan --json --config releasepress.config.json",
    requiredFlags: ["--config"],
    optionalFlags: [],
    approvalFlags: [],
    sideEffects: "read",
    reports: [],
    examples: ["releasepress plan --json --config releasepress.config.json"]
  },
  {
    name: "export",
    summary: "Build an allowlist-first public candidate tree.",
    usage: "releasepress export --json --config releasepress.config.json --out /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--out"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [
      ".releasepress-report/source-commit.txt",
      ".releasepress-report/source-state.json",
      ".releasepress-report/public-files.json",
      ".releasepress-report/excluded-files.json"
    ],
    examples: ["releasepress export --json --config releasepress.config.json --out ./public-tree"]
  },
  {
    name: "scan",
    summary: "Scan a candidate tree for forbidden strings and secret-looking material.",
    usage: "releasepress scan --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/scan-results.json"],
    examples: ["releasepress scan --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "package",
    summary: "Inspect configured package artifacts without publishing.",
    usage: "releasepress package --json --config releasepress.config.json",
    requiredFlags: ["--config"],
    optionalFlags: ["--source", "--path"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/package-files.json"],
    examples: ["releasepress package --json --config releasepress.config.json"]
  },
  {
    name: "preflight",
    summary: "Run pre-release checks.",
    usage: "releasepress preflight --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/preflight-results.json"],
    examples: ["releasepress preflight --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "stage",
    summary: "Publish a scanned candidate to the configured local/private staging target.",
    usage: "releasepress stage --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/stage-results.json"],
    examples: ["releasepress stage --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "public-review",
    summary: "Publish the staged candidate to the configured human review target.",
    usage: "releasepress public-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/public-review-results.json"],
    examples: ["releasepress public-review --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "attest-review",
    summary: "Record human review attestation for the exact review target and candidate.",
    usage: "releasepress attest-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public-review",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--target", "--reviewed-commit", "--reviewer", "--reason"],
    approvalFlags: ["--approve-public-review"],
    sideEffects: "write",
    reports: [".releasepress-report/public-review-attestation.json"],
    examples: ["releasepress attest-review --json --config releasepress.config.json --path ./public-tree --approve-public-review"]
  },
  {
    name: "checklist",
    summary: "Inspect release readiness reports.",
    usage: "releasepress checklist --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config"],
    optionalFlags: ["--path", "--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/checklist.json"],
    examples: ["releasepress checklist --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "verify",
    summary: "Verify checklist and receipt consistency.",
    usage: "releasepress verify --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/verify-results.json"],
    examples: ["releasepress verify --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "promote local",
    summary: "Install a verified local command without claiming public delivery.",
    usage: "releasepress promote local --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-local",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source"],
    approvalFlags: ["--approve-local"],
    sideEffects: "write",
    reports: [".releasepress-report/local-promote.json"],
    examples: ["releasepress promote local --json --config releasepress.config.json --path ./public-tree --approve-local"]
  },
  {
    name: "promote provider",
    summary: "Launch one configured delivery provider after human review gates pass.",
    usage: "releasepress promote provider <id> --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public <id>",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source", "--approve-public"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/provider-<id>.json"],
    examples: ["releasepress promote provider <provider-id> --json --config releasepress.config.json --path ./public-tree --approve-public <provider-id>"]
  },
  {
    name: "promote public",
    summary: "Launch all configured delivery providers in configured order.",
    usage: "releasepress promote public --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public public",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source", "--approve-public"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/provider-<id>.json"],
    examples: ["releasepress promote public --json --config releasepress.config.json --path ./public-tree --approve-public public"]
  },
  {
    name: "release plan",
    summary: "Show the guided release ceremony plan.",
    usage: "releasepress release plan --json --config releasepress.config.json",
    requiredFlags: ["--config"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [],
    examples: ["releasepress release plan --json --config releasepress.config.json"]
  },
  {
    name: "release status",
    summary: "Show candidate, stage, review, attestation, and delivery state.",
    usage: "releasepress release status --json --config releasepress.config.json --path /tmp/releasepress/public-tree",
    requiredFlags: ["--config"],
    optionalFlags: ["--path", "--source"],
    approvalFlags: [],
    sideEffects: "read",
    reports: [".releasepress-report/release-status.json"],
    examples: ["releasepress release status --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "release prepare",
    summary: "Export, scan, package, and stage a candidate.",
    usage: "releasepress release prepare --json --config releasepress.config.json --out /tmp/releasepress/public-tree",
    requiredFlags: ["--config", "--out"],
    optionalFlags: ["--source"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [
      ".releasepress-report/source-commit.txt",
      ".releasepress-report/source-state.json",
      ".releasepress-report/public-files.json",
      ".releasepress-report/excluded-files.json",
      ".releasepress-report/scan-results.json",
      ".releasepress-report/stage-results.json"
    ],
    examples: ["releasepress release prepare --json --config releasepress.config.json --out ./public-tree"]
  },
  {
    name: "release publish-review",
    summary: "Publish the staged candidate to the human review target.",
    usage: "releasepress release publish-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target public-review",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source", "--target"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/public-review-results.json"],
    examples: ["releasepress release publish-review --json --config releasepress.config.json --path ./public-tree"]
  },
  {
    name: "release attest",
    summary: "Record human review for the exact review target.",
    usage: "releasepress release attest --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target public-review --approve-public-review",
    requiredFlags: ["--config", "--path"],
    optionalFlags: ["--source", "--target", "--reviewed-commit", "--reviewer", "--reason"],
    approvalFlags: ["--approve-public-review"],
    sideEffects: "write",
    reports: [".releasepress-report/public-review-attestation.json"],
    examples: ["releasepress release attest --json --config releasepress.config.json --path ./public-tree --target public-review --approve-public-review"]
  },
  {
    name: "release deliver",
    summary: "Deliver to one provider after review attestation and verification gates pass.",
    usage: "releasepress release deliver --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target <provider-id> --approve-public <provider-id>",
    requiredFlags: ["--config", "--path", "--target"],
    optionalFlags: ["--source", "--approve-public"],
    approvalFlags: [],
    sideEffects: "write",
    reports: [".releasepress-report/provider-<id>.json"],
    examples: ["releasepress release deliver --json --config releasepress.config.json --path ./public-tree --target <provider-id> --approve-public <provider-id>"]
  }
];

export const LEGACY_COMMANDS = [
  {
    name: "promote github",
    replacement: "promote provider <id>",
    approval: "--approve-public <id>"
  },
  {
    name: "promote npm",
    replacement: "promote provider <id>",
    approval: "--approve-public <id>"
  }
];

export function commandHelpPacket(commandName = null) {
  const command = commandName ? COMMANDS.find((candidate) => candidate.name === commandName) : null;
  return {
    ok: true,
    type: "releasepress_help",
    command: commandName,
    commands: command ? [command] : COMMANDS,
    safety: [
      "stage is not delivery",
      "public review is not delivery",
      "local promote is not public release",
      "provider delivery requires exact human review attestation",
      "do not bypass Releasepress with raw git push or npm publish"
    ]
  };
}
