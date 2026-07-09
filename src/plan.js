import path from "node:path";
import { enumerateSourceEntries, selectPublicFiles } from "./export.js";

export function createPlan({ sourceRoot = process.cwd(), config }) {
  const root = path.resolve(sourceRoot);
  const entries = enumerateSourceEntries(root);
  const selection = selectPublicFiles(entries, config);

  return {
    ok: true,
    type: "releasepress_plan",
    source_root: root,
    public_repo: config.public_repo,
    stage_repo: config.stage_repo,
    stage: config.stage,
    public_review: config.public_review,
    release_targets: {
      candidate: {
        state: "planned",
        source_root: root
      },
      stage: {
        id: config.stage.id,
        kind: "git_ref",
        repo: config.stage_repo,
        visibility: config.stage_repo ? "local" : null,
        strategy: config.stage.strategy,
        ref: config.stage.strategy === "unique-ref" ? `${config.stage.ref_prefix}/<stage_commit>` : config.stage.ref,
        resolved_ref: config.stage.strategy === "unique-ref"
          ? `refs/heads/${config.stage.ref_prefix}/<stage_commit>`
          : `refs/heads/${config.stage.ref}`
      },
      review: config.public_review.repo ? {
        id: config.public_review.id ?? null,
        kind: config.public_review.kind ?? "git_ref",
        repo: config.public_review.repo,
        visibility: config.public_review.visibility,
        strategy: config.public_review.strategy,
        ref: config.public_review.ref,
        resolved_ref: `refs/heads/${config.public_review.ref}`,
        requires_human_attestation: config.public_review.requires_human_attestation
      } : null,
      delivery: config.delivery.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        provider: provider.provider,
        enabled: provider.enabled,
        review_target: provider.review_target,
        artifact: provider.artifact,
        repo: provider.repo ?? null,
        ref: provider.ref ?? null,
        channel: provider.channel ?? null
      }))
    },
    artifacts: config.artifacts,
    review_targets: config.review_targets,
    delivery: {
      providers: config.delivery.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        provider: provider.provider,
        enabled: provider.enabled,
        review_target: provider.review_target,
        artifact: provider.artifact,
        repo: provider.repo ?? null,
        ref: provider.ref ?? null,
        channel: provider.channel ?? null,
        launch_root: provider.launch_root,
        launch_path: provider.launch_path,
        launcher_argv: provider.launcher.command_argv,
        verify: provider.verify
      }))
    },
    defaults: config.defaults,
    disallowed_patterns: config.defaults.expanded_disallowed_patterns,
    include: config.include,
    exclude: config.exclude,
    package_must_exclude: config.package.must_exclude,
    surfaces: {
      local: {
        enabled: config.surfaces.local.enabled,
        strategy: config.surfaces.local.strategy,
        source: config.surfaces.local.source,
        command_name: config.surfaces.local.command_name
      }
    },
    public_files: selection.publicFiles,
    excluded_files: selection.excludedFiles,
    counts: {
      discovered_files: entries.filter((entry) => entry.type === "file").length,
      public_files: selection.publicFiles.length,
      excluded_files: selection.excludedFiles.length
    }
  };
}
