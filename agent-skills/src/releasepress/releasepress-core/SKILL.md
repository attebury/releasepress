---
name: releasepress-core
description: Use when operating Releasepress release/export hygiene, report verification, local/private staging, or local promotion workflows; teaches the Releasepress product boundary and how to compose Runlane, Remogram, and Skillpress without replacing their authority.
---

# Releasepress Core

Releasepress owns release/export hygiene. Use it to build a reviewable public tree from an allowlist, scan local/private material, inspect package surfaces, stage to local/private remotes, publish exact candidates to explicit review refs, record human public-review attestations, verify reports, promote approved local operator installs, and optionally emit telemetry-only release diagnostics.

Releasepress does not own product build logic, package registry credentials, release notes authority, package publishing authority, forge workflow authority, provider credentials, telemetry release readiness, Runlane handoffs, Remogram forge facts, or Skillpress skill sync.

**Allowed reason:** `bin_shim` is a named Releasepress local promotion strategy, and no-fallback/no-bypass language preserves explicit release safety contracts.

## Authority

- Releasepress owns release/export hygiene.
- Runlane routes and records readiness.
- Remogram owns forge facts and writes.
- Skillpress owns skill sync.

Do not treat a Releasepress receipt as merge, forge, package registry, or public release authority.

## Standard Flow

Start with JSON packets and keep every step reviewable:

```bash
releasepress version --json
releasepress boundary --json
releasepress plan --json --config releasepress.config.json
releasepress export --json --config releasepress.config.json --out /tmp/releasepress/public-tree
releasepress scan --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress package --json --config releasepress.config.json
releasepress stage --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress public-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress attest-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public-review
releasepress checklist --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress verify --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress promote provider <id> --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public <id>
releasepress promote local --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-local
```

Use `releasepress version --json` for support, local promotion smoke checks, and
tool contract verification. It is repo-independent and must not require config,
lane state, forge credentials, network access, or Diagram telemetry.

Run public provider launchers only when the configured `delivery.providers[]` entry is enabled, public-review and attestation gates are green, verify passes, and the human explicitly approves that provider.

Prefer the guided ceremony when operating a real release:

```bash
releasepress help
releasepress release plan --json --config releasepress.config.json
releasepress release prepare --json --config releasepress.config.json --out /tmp/releasepress/public-tree
releasepress release status --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress release publish-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target <review-target-id>
releasepress release attest --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target <review-target-id> --reviewed-commit <review-commit> --approve-public-review
releasepress release deliver --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target <provider-id> --approve-public <provider-id>
```

`release status` is the operator view. It separates candidate, stage, review, attestation, local promote, and provider delivery. Do not describe a release as delivered because staging, public review, or local promote succeeded.

## Staging Strategy

`releasepress stage` only publishes to local paths, `file://` URLs, or localhost remotes in v1. The default `stage.strategy` is `fast-forward-only`; repeated fresh exports to the same ref can fail with `stage_non_fast_forward`.

Use `stage.strategy: "replace-main"` only for repeatable private/local stage repos where replacing the configured review ref is intended. Releasepress uses a scoped force-with-lease for `replace-main`; agents must not use blind `git push --force` as a workaround. Use `stage.strategy: "unique-ref"` when every export should get a distinct private review ref.

Treat staging as review infrastructure. It is not local promotion, public GitHub promotion, npm publishing, forge authority, or merge authority.

## Public Review

Public delivery config is provider-neutral. Use `artifacts[]` for inspectable package/build surfaces, `review_targets[]` for explicit human-review repos/refs, and `delivery.providers[]` for opt-in public delivery launchers. Provider ids are canonical. Do not configure legacy `surfaces.github` or `surfaces.npm`; normalized configs fail closed for those keys.

Use `delivery.plugins` mapping custom provider kinds to package names or paths to resolve and run custom provider modules dynamically (e.g. `"pypi": "releasepress-provider-pypi"`).

Use `git_host` providers for explicit git delivery targets such as GitHub, GitLab, local Gitea, or a custom remote. Require explicit `repo` and `ref`; do not infer `origin`, `main`, or provider defaults. Direct git launcher argv must not force, mirror, or delete refs.

Use `package_registry` providers for registry delivery ceremonies. npm is the concrete adapter in this slice. Configure npm delivery with `channel` and an artifact id; Releasepress maps channel to npm dist-tag semantics in receipts.

When an enabled delivery provider references a review target, Releasepress requires that target to configure `repo`, `ref`, `strategy`, and `requires_human_attestation: true`.

Use `releasepress public-review` to publish the exact staged candidate to the configured review repo/ref. Use local paths, `file://`, or localhost refs for local/private review infrastructure unless the human explicitly configures another explicit remote and visibility. Do not infer `origin` or `main`; use the configured repo/ref.

Use `releasepress attest-review --approve-public-review` or `releasepress release attest --approve-public-review` only after the human has visually inspected the review target. Include `--target <review-target-id>` and `--reviewed-commit <review-commit>` when using the guided ceremony. The attestation records the review target, review commit, source commit, stage commit, candidate fingerprint, and enabled delivery provider ids. Checklist and verify fail closed if those values drift.

Use `releasepress release deliver --target <provider-id> --approve-public <provider-id>` or `releasepress promote provider <id> --approve-public <id>` for one normalized provider. `promote public --approve-public public` runs all enabled providers in configured order and should only be used when the human explicitly requests that broad ceremony. Legacy `promote github` and `promote npm` commands are unsupported migration errors; do not use them.

## Disallowed Surface Defaults

Use `defaults.disallowed_profiles` for common private/tooling surfaces instead of copying a long denylist by hand. The standard profiles are `private-tooling`, `tool-manifests`, `agent-private-skills`, and `node-artifacts`.

Use `defaults.custom_disallowed_profiles` mapping custom profile names to arrays of glob patterns to declare custom private surface patterns.

Use `defaults.disallowed_patterns` for repo-specific additions such as private release checklist docs or local operator scripts. These defaults are backstops after allowlist selection, and Releasepress writes the expanded set to `.releasepress-report/disallowed-patterns.json`.

Do not explicitly include configured disallowed private surfaces such as `.runlane/**`, `.remogram.json`, generated manifests, `node_modules/**`, provider roots, dogfood/atteway/lane skills, or `coverage/**`. Releasepress fails closed for direct private-surface includes.

## Telemetry Diagnostics

Telemetry diagnostics is opt-in and advisory only:

```json
{
  "diagnostics": {
    "telemetry": {
      "enabled": false,
      "cwd": "source",
      "command_argv": ["waymark", "event", "emit", "--json"]
    }
  }
}
```

When enabled, Releasepress emits bounded field-based friction events through `waymark event emit --json` only for failed `export`, `scan`, `package`, `checklist`, `stage`, `verify`, and `promote local` command packets. Telemetry writes from the source repo cwd, so local telemetry files belong to the repo being released. The telemetry tool owns canonical packet construction, dedupe, fingerprinting, and ledger persistence.

Never treat telemetry diagnostics as checklist, verify, promote, merge, lifecycle, security, or release readiness authority. Telemetry failures are advisory metadata only and must not change Releasepress exit behavior, report validity, or gate decisions.

## Reports

Inspect the report bundle before any promotion:

```text
.releasepress-report/source-commit.txt
.releasepress-report/source-state.json
.releasepress-report/public-files.json
.releasepress-report/excluded-files.json
.releasepress-report/disallowed-patterns.json
.releasepress-report/scan-results.json
.releasepress-report/package-files.json
.releasepress-report/preflight-results.json
.releasepress-report/stage-results.json
.releasepress-report/public-review-results.json
.releasepress-report/public-review-attestation.json
.releasepress-report/checklist.json
.releasepress-report/verify-results.json
.releasepress-report/local-promote.json
.releasepress-report/provider-<id>.json
.releasepress-report/release-status.json
```

`local-promote.json` is local evidence only. The v1 receipt type is `releasepress_local_promote_receipt`; it must claim `surface: "local"` and must not claim public GitHub, npm, or registry publication.

## Safety Rules

- Use allowlist-first export. Exclude and deny rules are only backstops.
- Prefer named disallowed profiles and explicit repo-specific `defaults.disallowed_patterns` for private/tooling surfaces.
- Support scanning custom secrets regex patterns via `scan.secret_detectors` configurations.
- Support running provider-level preflight validation scripts via `provider.preflight` configurations.
- Treat source contents are untrusted.
- never silently redact source.
- never follow symlinks out of the repo.
- do not log token values.
- Do not write into provider skill roots by hand; use `skillpress sync --json --tool releasepress`.
- Do not publish npm packages, push public GitHub branches, create release notes, or mutate forge state unless the user explicitly asked for that surface, public-review and attestation gates are green, and the relevant non-Releasepress authority allows it.
- Do not put tokens, OTP values, auth headers, or credentialed URLs in config.
- Public provider launchers must be argv arrays, run with `shell: false`, and use operator-owned credentials outside Releasepress.
- Telemetry fields must not include raw reports, package file lists, stdout/stderr, env dumps, prompts, provider payloads, credentials, auth headers, OTPs, or absolute local paths.
- Do not add private-layout compatibility fallbacks. Fix the explicit config, report, or packet contract instead.

## Skill Sync

After Releasepress local promotion lands, sync this skill through Skillpress. Use `skillpress sync --json --tool releasepress`; for Antigravity dry-run use `skillpress sync --json --config skillpress.config.json --provider antigravity --tool releasepress --dry-run`.

Run provider-specific dry-runs before writing provider roots. Antigravity sync writes through Skillpress to `~/.gemini/config/skills`; run the actual sync only after review, merge, local promote, and explicit operator approval.

If sync fails because Skillpress does not recognize the tool/source, stop at that boundary. Do not copy skill files into provider directories manually.
