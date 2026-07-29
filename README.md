# Releasepress

Releasepress builds a reviewable public tree from an explicit allowlist, scans
the result for local/private material, checks package surfaces, stages clean
exports to local/private repositories, and gates opt-in public provider
launches behind a human-reviewed target.

It composes existing build, forge, workflow, and package tools. It does not
replace Remogram, Waylane, npm publishing, product build logic, or public
release authority.

## Install

Forest consumers should install Releasepress from npm after public delivery:

```bash
npm install -g releasepress
releasepress version --json
```

For reproducible automation, pin the published version explicitly:

```bash
npm install -g releasepress@0.1.2
```

For one-off smoke checks without a global install:

```bash
npx releasepress@0.1.2 version --json
```

Do not pin Forest consumers to local Gitea remotes, workstation paths, or
review-stage repositories for normal use.

## Commands

```bash
releasepress --version
releasepress version --json
releasepress boundary --json
releasepress contract --json
releasepress plan --json --config releasepress.config.json
releasepress export --json --config releasepress.config.json --out /tmp/releasepress/public-tree
releasepress scan --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress package --json --config releasepress.config.json
releasepress toolchain validate --json --toolchain-compatibility toolchain.compatibility_matrix.v1.json
releasepress preflight --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress stage --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress public-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress attest-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public-review
releasepress checklist --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress local prepare --json --config releasepress.config.json --source . --out /tmp/releasepress/local-evidence
releasepress promote local --json --config releasepress.config.json --source . --path /tmp/releasepress/local-evidence --approve-local
releasepress promote provider <id> --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public <id>
releasepress promote public --json --config releasepress.config.json --path /tmp/releasepress/public-tree --approve-public public
releasepress verify --json --config releasepress.config.json --path /tmp/releasepress/public-tree
```

`releasepress --version` and `releasepress version --json` are repo-independent
CLI contract commands. They do not load release config, inspect lane/forge
state, run git, contact the network, or emit release diagnostics.

Guided release ceremony commands keep the same gates but make the operator
state explicit:

```bash
releasepress help
releasepress release plan --json --config releasepress.config.json
releasepress release prepare --json --config releasepress.config.json --out /tmp/releasepress/public-tree
releasepress release status --json --config releasepress.config.json --path /tmp/releasepress/public-tree
releasepress release publish-review --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target public-review
releasepress release attest --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target public-review --approve-public-review
releasepress release deliver --json --config releasepress.config.json --path /tmp/releasepress/public-tree --target npm-beta --approve-public npm-beta --toolchain-compatibility toolchain.compatibility_matrix.v1.json
```

See [docs/human-reviewed-release.md](docs/human-reviewed-release.md) for the
operator ceremony.

`toolchain validate` checks neutral `toolchain.compatibility_matrix.v1`
compatibility policy evidence. Provider delivery may require the same evidence
with `toolchain_compatibility.required: true` or accept it explicitly through
`--toolchain-compatibility <file>`. This validation is policy evidence only; it
does not inspect installed CLIs, run producer smokes, or grant release
authority. See [docs/toolchain-compatibility.md](docs/toolchain-compatibility.md).

`stage` only accepts local paths, `file://` URLs, or localhost remotes in v1.
Repeatable staging is private/local review infrastructure; it is not public
promotion. `public-review` publishes the exact staged candidate to an explicit
`review_targets[]` repo/ref, and `attest-review` records a human approval for
that candidate. `release status` reports candidate, stage, review,
attestation, local promote, and delivery provider states separately so staging
or local promote cannot be mistaken for GitHub/npm delivery. Public provider
launchers run only when their `delivery.providers[]` entries are enabled, the
public-review gate is green, the human attestation names the exact provider
target, and the matching `--approve-public` value is present. Local promote
requires explicit `surfaces.local.enabled: true` and `--approve-local`. A
source-backed local surface requires exact local-preparation evidence; an
export-backed local surface continues to require the passing public checklist
and verify reports. It writes only to configured local paths.

## Report

Export and verification commands produce a review report:

```text
.releasepress-report/
  source-commit.txt
  source-state.json
  public-files.json
  excluded-files.json
  disallowed-patterns.json
  scan-results.json
  package-files.json
  preflight-results.json
  stage-results.json
  public-review-results.json
  public-review-attestation.json
  checklist.json
  local-prepare.json
  local-promote.json
  provider-<id>.json
  release-status.json
  verify-results.json
```

The report uses relative paths and redacted detector metadata so it can be
reviewed without copying token values into logs. Built-in scanning covers
common secret assignments, JWTs, AWS access credentials, private-key headers,
and credential-bearing URLs; configured detectors may add repo-specific
patterns.

## Disallowed Surface Defaults

Export is still allowlist-first: a file must match `include` before
Releasepress considers copying it. Disallowed defaults are safety backstops for
private/tooling material that commonly appears in tool repos:

```json
{
  "defaults": {
    "disallowed_profiles": [
      "private-tooling",
      "tool-manifests",
      "agent-private-skills",
      "node-artifacts"
    ],
    "disallowed_patterns": ["internal-release/**"]
  }
}
```

Built-in profiles expand into explicit patterns and are written to
`.releasepress-report/disallowed-patterns.json`. `plan --json` also reports the
configured profiles and expanded patterns before export. Unknown profile names
fail config validation.

`private-tooling` covers roots such as `.runlane/`, `.remogram.json`,
`.cursor/`, `.codex/`, `.agents/`, `.claude/`, `.releasepress-report/`,
`topo/`, and `topogram.*`. It also blocks root and nested credential files such
as `.env`, `.env.*`, `.npmrc`, `.netrc`, `id_rsa*`, `.aws/credentials`, and
`*.pem`. `tool-manifests` covers common generated `*.manifest.json` and legacy
workflow activation or forge-facts files.
`agent-private-skills` covers dogfood, atteway, lane, SDLC, and observer skill
roots under `agent-skills/src/`. `node-artifacts` covers `node_modules/` and
`coverage/`.

Broad includes can still be paired with disallowed defaults so a human can see
which private files were excluded. Directly allowlisting a configured
disallowed private surface, such as `.runlane/**`, `.remogram.json`, or
`node_modules/**`, fails closed instead of silently exporting or rewriting it.

## Artifacts, Review Targets, And Delivery Providers

Public delivery config is provider-neutral. The canonical shape is:

```json
{
  "artifacts": [
    {
      "id": "npm-package",
      "kind": "npm_pack",
      "root": "source",
      "path": ".",
      "inspect_argv": ["npm", "pack", "--dry-run", "--json"],
      "must_exclude": ["scripts/", "examples/", "test/", ".github/"]
    }
  ],
  "review_targets": [
    {
      "id": "local-public-review",
      "kind": "git_ref",
      "repo": "file:///tmp/releasepress-public-review.git",
      "visibility": "local",
      "strategy": "replace-ref",
      "ref": "release/stable",
      "requires_human_attestation": true
    }
  ],
  "delivery": {
    "providers": []
  }
}
```

`artifacts[]` define inspectable package or build surfaces. `npm_pack` runs
`inspect_argv` with `shell: false`, parses npm dry-run JSON, and applies
`must_exclude` checks before any registry launcher can run.

`review_targets[]` define explicit human-review destinations. Git review targets
never infer `origin` or `main`; every repo and ref must be configured.

`delivery.providers[]` define opt-in delivery ceremonies. Provider ids are
canonical and must be unique. Enabled providers must reference the review target
they depend on, package-registry providers must reference an artifact, and
launchers must use argv arrays. The old `surfaces.github` and `surfaces.npm`
keys fail with a structured migration error; `surfaces.local` remains the local
promote surface.

`git_host` providers cover GitHub, GitLab, local Gitea, and explicit custom git
remotes. They require explicit `repo` and `ref` values; Releasepress does not
infer `origin`, `main`, or provider-specific defaults. Direct git launchers that
attempt force, mirror, or delete pushes are rejected at config validation.
Git-host launchers always run from the scanned export tree; source-root
git-host launchers are rejected even when the provider is disabled.

`package_registry` providers cover package delivery ceremonies. In this slice
only npm has a concrete adapter; it uses normalized `channel` config and maps
that to npm dist-tag semantics in reports.

## Stage Strategy

Staging publishes the already-exported and scanned public tree to a private
stage repo for human review. The default is conservative:

```json
{
  "stage": {
    "id": "stage",
    "strategy": "fast-forward-only",
    "ref": "main",
    "ref_prefix": "releasepress"
  }
}
```

`fast-forward-only` pushes `HEAD` to `refs/heads/<ref>` without force and fails
with `stage_non_fast_forward` when a fresh export would replace history.
`replace-main` updates exactly the configured private ref with
`--force-with-lease=refs/heads/<ref>:<observed-sha>`, never blind `--force`.
`unique-ref` pushes each export to `refs/heads/<ref_prefix>/<stage_commit>`.

`stage.ref` and `stage.ref_prefix` are branch-style names under `refs/heads/`;
absolute refs, path escapes, lock suffixes, spaces, shell metacharacters, and
public-push-looking refspecs fail config validation.

## Public Review

Public review is the required human-inspection step before opt-in public
delivery providers:

```json
{
  "review_targets": [
    {
      "id": "local-public-review",
      "kind": "git_ref",
      "repo": "file:///tmp/remogram-public.git",
      "visibility": "local",
      "strategy": "replace-ref",
      "ref": "release/stable",
      "requires_human_attestation": true
    }
  ]
}
```

`repo` must be explicit and must not contain embedded credentials. Local review
targets may be local paths, `file://` URLs, or localhost remotes. Other explicit
remotes are allowed when declared with `visibility: "private-remote"` or
`"public-remote"`; Releasepress records the declaration but does not prove
provider visibility in this slice. Refs are branch-style names under
`refs/heads/` and do not default to `main` when a repo needs another branch.

`fast-forward-only` never replaces an existing review ref. `replace-ref` updates
exactly the configured review ref with a scoped force-with-lease. There is no
blind `--force`, implicit `origin`, or implicit public GitHub push.

After a human visually inspects the review target, record the attestation:

```bash
releasepress attest-review --json --config releasepress.config.json \
  --path /tmp/releasepress/public-tree \
  --target local-public-review \
  --reviewed-commit <review-commit> \
  --approve-public-review \
  --reviewer operator \
  --reason "inspected local Gitea review repo"
```

The attestation records the selected review target, review commit, source
commit, stage commit, candidate fingerprint, and the enabled delivery provider
ids it unlocks. If any of those fields drift, checklist and verify fail closed.

## Release Metadata

Release metadata is resolved from validated config for later delivery providers:

```json
{
  "version": { "source": "source", "file": "package.json", "field": "version" },
  "release_notes": {
    "source": "source",
    "file": "CHANGELOG.md",
    "section_pattern": "^## \\[{version}\\]",
    "fallback": "file"
  },
  "tag": { "prefix": "v", "format": "{prefix}{version}" }
}
```

Metadata file paths must stay inside the selected source or export root.

## Preflight

Preflight runs configured argv steps with `shell: false` after export and scan,
before any future promote surface. When `cwd` is `export`, Releasepress first
materializes an exact, no-follow copy of the candidate in a private temporary
workspace. Install, test, coverage, and other runtime artifacts remain inside
that workspace; only the bounded preflight report is written to the staged
candidate. Releasepress removes the workspace on every terminal path and
fails closed if it cannot prove cleanup:

```json
{
  "preflight": {
    "enabled": true,
    "cwd": "export",
    "timeout_ms": 600000,
    "steps": [
      { "id": "install", "argv": ["npm", "ci"], "required": true },
      { "id": "test", "argv": ["npm", "test"], "required": true },
      { "id": "coverage", "argv": ["npm", "run", "test:coverage"], "required": false },
      { "id": "secrets", "argv": ["npm", "run", "security:secrets", "--", "--full-history"], "required": true }
    ]
  }
}
```

Known step ids are `install`, `test`, `coverage`, and `secrets`. Required
failures make the preflight packet fail; optional failures are recorded without
failing the overall packet. Npm steps are skipped with a clear reason when the
selected tree has no `package.json`. Releasepress does not add network install
hooks; configured commands remain operator-owned supply-chain inputs.

An export-mode preflight report is bound to the candidate fingerprint and file
count, source commit, and the staged commit when a stage receipt exists.
Checklist, review, and verification recompute those bindings and reject stale,
tampered, non-isolated, or incompletely cleaned reports. `cwd: "source"` keeps
its existing explicit source-root behavior.

## Telemetry Diagnostics

Releasepress can optionally emit bounded diagnostic events to a configured telemetry sink when `export`, `scan`, `package`, `preflight`, `checklist`, `stage`, `verify`, `local prepare`, or `promote local` fails:

```json
{
  "diagnostics": {
    "telemetry": {
      "enabled": false,
      "cwd": "source",
      "command_argv": ["waymark", "sink", "record", "--file", "{file}", "--json"]
    }
  }
}
```

Telemetry defaults to disabled. When enabled, Releasepress writes a sanitized `diagnostic.event.v1` file, substitutes its path into the single `{file}` placeholder, and runs the configured sink command with `shell: false`. The sink owns storage, dedupe, query, and reporting. Telemetry failures are advisory only: they never change Releasepress readiness, exit behavior, reports, checklist, verify, or promote gates.

Diagnostic events summarize detector IDs, blocker IDs, violation counts, command names, and report filenames. They do not include raw reports, package file lists, stdout/stderr, env dumps, provider payloads, prompts, credentials, or absolute local paths. Releasepress does not emit Waymark-owned event candidates or sink-specific field flags.

## Checklist

`checklist` composes the existing report files into one promote-readiness packet.
Without `--path`, it returns the planned flow without executing commands. With
`--path`, it writes `.releasepress-report/checklist.json` and fails closed unless
export, scan, package, configured preflight, and local/private stage reports are
present and passing.

## Verify

`verify` reads the report bundle and writes `.releasepress-report/verify-results.json`.
It fails closed when checklist gates are not ready. When GitHub or npm delivery
providers are enabled, the checklist requires public review and human
attestation. Provider receipts are optional before launch; when present, verify
checks that they still match config, provider ids, review targets, and artifact
ids. When local promote is enabled, `verify` accepts a matching
`local-promote.json` receipt if present and otherwise treats local promote as
not yet run. It does not perform public network reads in v1; provider commands
remain separately approved.

## Local Promote

Local promote installs a verified artifact for operator use without claiming
public publication. The first supported strategies are `bin_shim` and
`npm_prefix`; both require `--approve-local`. `bin_shim` writes a
Releasepress-owned Node shim in the configured `bin_dir`. `npm_prefix` runs an
argv-array local install with `--ignore-scripts` and `--offline`.

The required evidence path is selected only by `surfaces.local.source`:

- `source` requires `releasepress local prepare` evidence for the exact clean
  source SHA and normalized local policy.
- `export` requires the existing passing public checklist and verify reports.

There is no fallback between these paths. Local preparation does not weaken or
satisfy public export, scan, package, stage, review, attestation, or provider
delivery gates.

Every `npm` subprocess Releasepress spawns for packaging and local promotion
(`npm pack` during package inspection and preflight, `npm install` for
`npm_prefix` local promote) runs with a bounded, per-invocation
`NPM_CONFIG_CACHE` (see `src/npm-env.js`) pointed outside the source and
exported candidate trees, under the OS temp directory. This keeps Releasepress
verification independent of the operator's default npm cache — an
inaccessible or corrupted default cache (for example, one containing
root-owned entries) does not block packaging or local promotion. Releasepress
never repairs, deletes, or takes ownership of the operator's default cache; a
caller-supplied `NPM_CONFIG_CACHE` is always respected instead.

```json
{
  "surfaces": {
    "local": {
      "enabled": true,
      "strategy": "bin_shim",
      "bin_dir": "/tmp/releasepress-local/bin",
      "command_name": "releasepress",
      "source": "source",
      "target": "bin/releasepress.js",
      "prepare": {
        "enabled": true,
        "timeout_ms": 600000,
        "steps": [
          {
            "id": "test",
            "argv": ["npm", "run", "check"],
            "required": true
          }
        ]
      },
      "smoke_check": {
        "argv": ["version", "--json"],
        "timeout_ms": 30000
      }
    }
  }
}
```

Run the source-backed ceremony with a dedicated evidence root:

```bash
releasepress local prepare --json \
  --config releasepress.config.json \
  --source . \
  --out /tmp/releasepress/local-evidence
releasepress promote local --json \
  --config releasepress.config.json \
  --source . \
  --path /tmp/releasepress/local-evidence \
  --approve-local
```

`local prepare` requires at least one configured required check and writes a
bounded `releasepress_local_prepare` report bound to
the exact clean Git SHA, local-policy digest, command target, resolved version,
and configured check results. It uses argv arrays with `shell: false` and
bounded timeouts. Missing, stale, malformed, oversized, symlinked, escaped,
dirty, or policy-drifted evidence fails closed.

Successful local promotion writes
`.releasepress-report/local-promote.json` with
`type: "releasepress_local_promote_receipt"`. The receipt is local evidence for
tools such as Waylane or Wayfinder; it is not public release, package publish,
or forge authority.

### Smoke Check

A `surfaces.local.smoke_check` is required for source-backed promotion. It runs
after the command is installed and before the receipt is written. It remains
optional for export-backed promotion:

```json
{
  "surfaces": {
    "local": {
      "smoke_check": { "argv": ["--version"], "timeout_ms": 30000 }
    }
  }
}
```

Releasepress spawns `<installed_path> <argv...>` (cwd outside both the source
and export trees) and fails closed with `local_promote_smoke_check_failed` on
a non-zero exit or timeout, before the receipt is written. This is what
catches an `npm_prefix` install whose installed command can't actually
resolve its runtime or workspace dependencies — without it, a broken install
could still produce a passing receipt.

### Bootstrap

`releasepress bootstrap local --config releasepress.config.json --source . --bin-dir <dir>`
adds or updates `surfaces.local` on an already-valid config from the
project's own `package.json` `bin` entry (a `bin_shim` targeting that entry,
with a default `smoke_check` of `--version`), and ensures
`.releasepress-report/` is listed in `.gitignore`. It never touches
`delivery.providers[]` or `review_targets[]` — bootstrap only ever configures
the local surface, not public delivery. Bootstrap leaves local preparation
checks disabled because it cannot infer a repository's canonical verification
command; configure `surfaces.local.prepare` explicitly before source-backed
promotion. Bootstrap requires the base config
(`stage_repo`, `include`, review policy) to already exist and validate; pass
`--command-name` to disambiguate a `package.json` with more than one `bin`
entry, and `--force` to overwrite an already-configured but different local
surface.

## Git-Host Providers

Git-host provider promotion composes the checklist, public-review attestation,
verify, and version/tag gates, then runs the configured `git_host`
`delivery.providers[]` launcher with `shell: false` and inherited stdio. The
direct command is `releasepress promote provider <id> --approve-public <id>`.
Legacy `promote github` fails with a structured migration error; use the
configured provider id instead.

Git-host launchers always use `launch_root: "export"` (the default) and run
from the scanned export tree. `launch_root: "source"` is rejected for
`git_host` providers. Releasepress still sets `RELEASEPRESS_EXPORT_ROOT` and
`RELEASEPRESS_SOURCE_ROOT` in the launcher environment.

Releasepress backs up and restores `.releasepress-report/` around launcher
execution so operator receipts survive export-tree git amend steps.

Optional post-promote receipt verification uses `git ls-remote` to confirm the
configured ref points at the exact staged candidate commit. It detects
post-launch mismatch; it is not pre-publication authorization and cannot undo a
publication:

```json
{
  "delivery": {
    "providers": [
      {
        "id": "github-public",
        "kind": "git_host",
        "provider": "github",
        "enabled": true,
        "review_target": "local-public-review",
        "repo": "attebury/example",
        "ref": "release/stable",
        "launch_root": "export",
        "launch_path": ".",
        "allow_force_push": false,
        "require_npm_promote": true,
        "launcher": {
          "command_argv": [
            "git",
            "push",
            "git@github.com:attebury/example.git",
            "HEAD:refs/heads/release/stable"
          ]
        },
        "release": { "latest_policy": "stable_latest" },
        "verify": {
          "kind": "git_ref",
          "remote": "git@github.com:attebury/example.git",
          "ref": "refs/heads/{ref}"
        }
      }
    ]
  }
}
```

Releasepress does not capture interactive launcher output, store credentials,
author release notes, or own forge authority. Generic providers write
`provider-<id>.json` as launcher receipt evidence.

## Package Registry Providers

Package-registry provider promotion composes the checklist, public-review
attestation, verify, and version gates, then runs the configured
`package_registry` `delivery.providers[]` launcher with `shell: false` and
piped stdio (so publish failures retain stderr for reconcile). Package-registry
providers must use `launch_root: "export"` so the launcher runs from the scanned
export tree. `launch_root: "source"` is rejected for `package_registry`
providers. Legacy `promote npm` fails with a structured migration error; use
the configured provider id instead.

Launcher argv is always an argv array with `shell: false`. Using `bash` as
`argv[0]` for an operator-owned script is intentional and is not shell
injection:

```json
"command_argv": ["bash", "./scripts/publish-npm-beta.sh"]
```

That form runs `bash` with one script-path argument. The script must exist and
be readable under the launch cwd. Do not use shell strings such as
`bash -lc "..."`; `assertSafeArgv` rejects shell-shaped argv. Prefer an
executable script path as `argv[0]` when the script has a shebang.

If `npm publish` fails because the version is already on the registry
(duplicate-version / EPUBLISHCONFLICT), Releasepress reconciles against the
provider's configured `verify` argv expectations. When the registry package
version and dist-tag exactly match the candidate, the provider report is written
as `delivery.status: "already_delivered"` and verify can pass. Other npm
failures (auth, missing package, mismatched tag or integrity) stay fail-closed.

```json
{
  "delivery": {
    "providers": [
      {
        "id": "npm-beta",
        "kind": "package_registry",
        "provider": "npm",
        "enabled": true,
        "review_target": "local-public-review",
        "artifact": "npm-package",
        "channel": "beta",
        "workspace": true,
        "launch_root": "export",
        "launch_path": ".",
        "launcher": {
          "command_argv": ["bash", "./scripts/publish-npm-beta.sh"]
        }
      }
    ]
  }
}
```

Releasepress never stores npm tokens or OTP values in config. Tokens, login
state, and 2FA prompts belong to the operator-owned launcher environment.

When a package-registry provider has `verify.kind: "argv"`, Releasepress runs
the verify argv after a successful publish and compares JSON stdout against
`verify.expect`
templates such as `{version}` and `{channel}`.

## Public Promote

`promote public` runs enabled `delivery.providers[]` entries in configured
order. It requires `--approve-public public` and composes the same per-provider
gates and post-promote verify steps as the individual promote commands.

```bash
releasepress promote public --json --config releasepress.config.json \
  --path /tmp/releasepress/public-tree \
  --approve-public public
```

To run one provider directly:

```bash
releasepress promote provider npm-beta --json --config releasepress.config.json \
  --path /tmp/releasepress/public-tree \
  --approve-public npm-beta
```
## Agent Skills

Releasepress-owned agent skills live under `agent-skills/src/releasepress/`. These skills serve as general markdown guidelines for AI coding assistants and do not require any external tools to be used or promoted. 

For convenience in local development environments, you can optionally use [Skillpress](https://github.com/attebury/skillpress) to distribute and sync these skills into your AI assistant's customization folders:

```bash
skillpress sync --json --tool releasepress
skillpress sync --json --config skillpress.config.json --provider antigravity --tool releasepress --dry-run
```

Use provider-specific dry-runs before writing provider roots. When using Skillpress, the Antigravity sync writes to `~/.gemini/config/skills`; run the actual sync only after review, merge, local promote, and explicit operator approval.

If you are not using Skillpress, you can copy or reference the `agent-skills/` directory manually as needed.
