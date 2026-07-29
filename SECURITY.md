# Security

Releasepress is a local release hygiene tool. It does not own credentials,
publishing, or public forge authority.

Report security issues privately to the repository owner.

## Release Safety Rules

- Export selection is allowlist-first.
- Exclude rules and deny checks are backstops.
- Export never mutates the source checkout.
- Selected symlinks fail closed.
- Scans report detector IDs and locations, not token values.
- Git-host launchers run only from the scanned export tree; source-root
  git-host promotion is rejected before launcher execution.
- Opt-in public delivery (GitHub/npm) requires enabled providers, a green checklist, visual human attestation, and explicit operator approval.
