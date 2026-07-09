import fs from "node:fs";
import path from "node:path";
import { assertSafeDirectoryPath, isInsidePath, ReleasepressError } from "./config.js";

const CONFIG_FILE = "skillpress.config.json";
const SKILL_PATH = "agent-skills/src/releasepress/releasepress-core/SKILL.md";
const REQUIRED_SKILLPRESS_PROVIDERS = ["codex", "antigravity"];
const REQUIRED_SKILLPRESS_POLICY_PACKS = ["linter", "dogfood"];
const FORBIDDEN_SKILLPRESS_POLICY_PACKS = new Map([
  ["generic", "linter"]
]);
const REQUIRED_PHRASES = [
  "allowlist-first export",
  "source contents are untrusted",
  "never silently redact source",
  "never follow symlinks out of the repo",
  "do not log token values",
  "Runlane routes and records readiness",
  "Remogram owns forge facts and writes",
  "Skillpress owns skill sync",
  "Releasepress owns release/export hygiene",
  "skillpress sync --json --tool releasepress"
];
const REQUIRED_COMMANDS = [
  "releasepress version --json",
  "releasepress boundary --json",
  "releasepress plan --json --config",
  "releasepress export --json --config",
  "releasepress scan --json --config",
  "releasepress package --json --config",
  "releasepress stage --json --config",
  "releasepress checklist --json --config",
  "releasepress verify --json --config",
  "releasepress promote local --json"
];
const REQUIRED_REPORTS = [
  ".releasepress-report/source-commit.txt",
  ".releasepress-report/public-files.json",
  ".releasepress-report/excluded-files.json",
  ".releasepress-report/scan-results.json",
  ".releasepress-report/package-files.json",
  ".releasepress-report/checklist.json",
  ".releasepress-report/verify-results.json",
  ".releasepress-report/local-promote.json"
];
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bGITEA_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/,
  /\bNPM_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/,
  /\bnpm_[A-Za-z0-9]{20,}\b/
];

export function validateAgentSkillSources({ root = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(root);
  const config = readSkillpressConfig(resolvedRoot);
  const sourceRoot = config.source_roots.find((entry) => entry.path === "agent-skills/src" && entry.layout === "tool-scoped");
  if (!sourceRoot) {
    throw new ReleasepressError("skillpress_source_missing", "skillpress.config.json must expose agent-skills/src as a tool-scoped source root");
  }
  const skillFile = path.join(resolvedRoot, SKILL_PATH);
  assertPathInsideRoot(resolvedRoot, skillFile, SKILL_PATH);
  let text;
  try {
    text = fs.readFileSync(skillFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("agent_skill_missing", "Releasepress core skill source is missing", {
        path: SKILL_PATH
      });
    }
    throw error;
  }

  validateSkillText(text);
  return {
    ok: true,
    type: "releasepress_agent_skill_sources",
    config: CONFIG_FILE,
    source_root: sourceRoot.path,
    layout: sourceRoot.layout,
    skill: SKILL_PATH,
    providers: config.providers,
    policy_packs: config.policy_packs
  };
}

function readSkillpressConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("skillpress_config_missing", "skillpress.config.json is required for Skillpress sync");
    }
    if (error instanceof SyntaxError) {
      throw new ReleasepressError("skillpress_config_invalid", "skillpress.config.json is not valid JSON", {
        reason: error.message
      });
    }
    throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReleasepressError("skillpress_config_invalid", "skillpress.config.json must be an object");
  }
  const sourceRoots = normalizeSourceRoots(raw.source_roots ?? []);
  const contractRoot = normalizeOptionalPath(raw.contract_root ?? "agent-skills/contracts", "contract_root");
  const providers = normalizeStringArray(raw.providers ?? [], "providers");
  const policyPacks = normalizeStringArray(raw.policy_packs ?? [], "policy_packs");
  validateRequiredValues("providers", providers, REQUIRED_SKILLPRESS_PROVIDERS);
  validateRequiredValues("policy_packs", policyPacks, REQUIRED_SKILLPRESS_POLICY_PACKS);
  validateForbiddenPolicyPacks(policyPacks);

  for (const entry of sourceRoots) {
    assertPathInsideRoot(root, path.resolve(root, entry.path), entry.path);
  }
  assertPathInsideRoot(root, path.resolve(root, contractRoot), contractRoot);

  return {
    source_roots: sourceRoots,
    contract_root: contractRoot,
    policy_packs: policyPacks,
    providers
  };
}

function validateRequiredValues(field, values, requiredValues) {
  for (const required of requiredValues) {
    if (!values.includes(required)) {
      throw new ReleasepressError("skillpress_config_invalid", `skillpress.config.json ${field} must include ${required}`, {
        field,
        required
      });
    }
  }
}

function validateForbiddenPolicyPacks(policyPacks) {
  for (const [policyPack, replacement] of FORBIDDEN_SKILLPRESS_POLICY_PACKS) {
    if (policyPacks.includes(policyPack)) {
      throw new ReleasepressError("skillpress_config_invalid", `skillpress.config.json policy_packs must not include deprecated ${policyPack}`, {
        field: "policy_packs",
        policy_pack: policyPack,
        replacement
      });
    }
  }
}

function normalizeSourceRoots(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReleasepressError("skillpress_config_invalid", "skillpress.config.json source_roots must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ReleasepressError("skillpress_config_invalid", `source_roots[${index}] must be an object`);
    }
    const sourcePath = normalizeOptionalPath(entry.path, `source_roots[${index}].path`);
    if (entry.layout !== "tool-scoped") {
      throw new ReleasepressError("skillpress_config_invalid", `source_roots[${index}].layout must be tool-scoped`);
    }
    return {
      path: sourcePath,
      layout: entry.layout
    };
  });
}

function normalizeOptionalPath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleasepressError("skillpress_config_invalid", `${field} must be a non-empty relative path`);
  }
  assertSafeDirectoryPath(value, field);
  return value.replace(/^\.\//, "");
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ReleasepressError("skillpress_config_invalid", `${field} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new ReleasepressError("skillpress_config_invalid", `${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function validateSkillText(text) {
  if (!/^---\nname: releasepress-core\ndescription: .+\n---\n/s.test(text)) {
    throw new ReleasepressError("agent_skill_invalid", "releasepress-core skill must have valid frontmatter");
  }
  const missing = [...REQUIRED_PHRASES, ...REQUIRED_COMMANDS, ...REQUIRED_REPORTS].filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) {
    throw new ReleasepressError("agent_skill_invalid", "releasepress-core skill is missing required guidance", {
      missing
    });
  }
  if (/denylist-only|scrub and hope|direct provider skill directory/i.test(text)) {
    throw new ReleasepressError("agent_skill_invalid", "releasepress-core skill contains forbidden guidance");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new ReleasepressError("agent_skill_secret_material", "releasepress-core skill contains token-looking material");
  }
}

function assertPathInsideRoot(root, file, label) {
  if (!isInsidePath(root, file)) {
    throw new ReleasepressError("skillpress_path_escape", "Skillpress source path escaped the repo root", {
      path: label
    });
  }
}
