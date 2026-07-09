export function getBoundary() {
  return {
    ok: true,
    product: "releasepress",
    owns: [
      "explicit allowlist-based public tree planning",
      "public export staging into a reviewable local tree",
      "public review target publishing for exact exported candidates",
      "human review attestation reports before public provider launch",
      "local/private material scanning before promotion",
      "package surface inspection for files that would publish",
      "gated provider launch receipts for opt-in public promotion",
      "advisory telemetry-only diagnostic emission for release friction",
      "review reports for public release hygiene"
    ],
    does_not_own: [
      "product build logic",
      "npm credentials or registry authority",
      "GitHub credentials or forge authority",
      "GitHub release note authorship",
      "telemetry release readiness or gate authority",
      "Runlane handoffs",
      "Remogram forge facts"
    ],
    invariants: [
      "export selection is allowlist-first",
      "exclude and deny rules are backstops",
      "source repositories are never mutated during export",
      "source file contents are treated as untrusted",
      "scans fail closed on exact forbidden strings and secret-looking material",
      "symlinks selected for export fail closed",
      "public provider promotion is opt-in, explicitly approved, and gated by public review attestation",
      "provider commands are configured argv launchers, not shell strings",
      "diagnostic telemetry is opt-in, advisory only, and never changes release readiness",
      "Releasepress does not store or log provider credentials"
    ]
  };
}
