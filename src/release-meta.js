import fs from "node:fs";
import path from "node:path";
import { isInsidePath, ReleasepressError } from "./config.js";
import { readBoundedJson } from "./report-io.js";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolveReleaseMetadata({ sourceRoot = process.cwd(), exportRoot = null, config }) {
  const version = resolveVersion({ sourceRoot, exportRoot, config });
  const tag = resolveTag({ version: version.version, config });
  const releaseNotes = extractReleaseNotes({
    sourceRoot,
    exportRoot,
    config,
    version: version.version
  });

  return {
    ok: true,
    type: "releasepress_release_metadata",
    version,
    tag,
    release_notes: releaseNotes
  };
}

export function resolveVersion({ sourceRoot = process.cwd(), exportRoot = null, config }) {
  assertConfig(config);
  const root = resolveConfiguredRoot({
    sourceRoot,
    exportRoot,
    source: config.version.source,
    purpose: "version"
  });
  const file = resolveInsideRoot(root, config.version.file, "version.file");
  assertRegularMetadataFile({
    absolute: file,
    relPath: config.version.file,
    field: "version.file",
    missingCode: "version_file_missing",
    missingMessage: "Version file does not exist",
    source: config.version.source
  });

  let parsed;
  try {
    parsed = readBoundedJson(file, "version_json_invalid", {
      oversizedCode: "version_file_oversized",
      oversizedMessage: "Version file exceeds the size limit",
      invalidMessage: "Version file is not valid JSON"
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("version_file_missing", "Version file does not exist", {
        file: config.version.file,
        source: config.version.source
      });
    }
    if (error instanceof ReleasepressError && error.code === "version_json_invalid") {
      throw new ReleasepressError("version_json_invalid", "Version file is not valid JSON", {
        file: config.version.file,
        reason: error.details?.reason
      });
    }
    throw error;
  }

  const value = readField(parsed, config.version.field);
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleasepressError("version_missing", "Configured version field is missing or not a string", {
      file: config.version.file,
      field: config.version.field
    });
  }

  const warnings = [];
  if (!SEMVER_PATTERN.test(value)) {
    warnings.push({
      code: "version_not_semver",
      message: "Version is not a plain semver string"
    });
  }

  return {
    version: value,
    source: config.version.source,
    file: config.version.file,
    field: config.version.field,
    semver_ok: warnings.length === 0,
    warnings
  };
}

export function resolveTag({ version, config }) {
  assertConfig(config);
  if (typeof version !== "string" || version.length === 0) {
    throw new ReleasepressError("version_missing", "Version is required to resolve a tag");
  }

  const tag = config.tag.format
    .replaceAll("{prefix}", config.tag.prefix)
    .replaceAll("{version}", version);

  return {
    tag,
    version,
    prefix: config.tag.prefix,
    format: config.tag.format
  };
}

export function extractReleaseNotes({ sourceRoot = process.cwd(), exportRoot = null, config, version }) {
  assertConfig(config);
  if (typeof version !== "string" || version.length === 0) {
    throw new ReleasepressError("version_missing", "Version is required to extract release notes");
  }

  const root = resolveConfiguredRoot({
    sourceRoot,
    exportRoot,
    source: config.release_notes.source,
    purpose: "release_notes"
  });
  const file = resolveInsideRoot(root, config.release_notes.file, "release_notes.file");
  assertRegularMetadataFile({
    absolute: file,
    relPath: config.release_notes.file,
    field: "release_notes.file",
    missingCode: "release_notes_file_missing",
    missingMessage: "Release notes file does not exist",
    source: config.release_notes.source
  });

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError("release_notes_file_missing", "Release notes file does not exist", {
        file: config.release_notes.file,
        source: config.release_notes.source
      });
    }
    throw error;
  }

  const sectionPattern = compileSectionPattern(config.release_notes.section_pattern, version);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => sectionPattern.test(line));

  if (start === -1) {
    if (config.release_notes.fallback === "file") {
      return releaseNotesResult({
        notes: text,
        file: config.release_notes.file,
        mode: "file_fallback",
        version,
        section_found: false
      });
    }
    throw new ReleasepressError("release_notes_section_missing", "Release notes section was not found", {
      file: config.release_notes.file,
      version
    });
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\[/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const notes = lines.slice(start, end).join("\n").trimEnd();
  return releaseNotesResult({
    notes,
    file: config.release_notes.file,
    mode: "section",
    version,
    section_found: true
  });
}

function releaseNotesResult({ notes, file, mode, version, section_found }) {
  return {
    notes,
    file,
    mode,
    version,
    section_found
  };
}

function resolveConfiguredRoot({ sourceRoot, exportRoot, source, purpose }) {
  if (source === "source") {
    return path.resolve(sourceRoot);
  }
  if (source === "export") {
    if (!exportRoot) {
      throw new ReleasepressError("missing_export_root", `${purpose} source is export but no export root was provided`);
    }
    return path.resolve(exportRoot);
  }

  throw new ReleasepressError("invalid_config", `${purpose} source is invalid`, { source });
}

function resolveInsideRoot(root, relPath, field) {
  const resolved = path.resolve(root, relPath);
  if (!isInsidePath(root, resolved)) {
    throw new ReleasepressError("path_escape", `${field} escaped the selected root`, { path: relPath });
  }
  return resolved;
}

function assertRegularMetadataFile({ absolute, relPath, field, missingCode, missingMessage, source }) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleasepressError(missingCode, missingMessage, {
        file: relPath,
        source
      });
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("metadata_file_symlink", "Metadata file must not be a symlink", {
      field,
      file: relPath
    });
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("metadata_file_not_regular", "Metadata file must be a regular file", {
      field,
      file: relPath
    });
  }
}

function compileSectionPattern(sectionPattern, version) {
  try {
    return new RegExp(sectionPattern.replaceAll("{version}", escapeRegExp(version)));
  } catch (error) {
    throw new ReleasepressError("invalid_config", "release_notes.section_pattern must be a valid regular expression", {
      reason: error.message
    });
  }
}

function readField(value, field) {
  return field.split(".").reduce((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return current[part];
  }, value);
}

function assertConfig(config) {
  if (!config || !config.version || !config.release_notes || !config.tag) {
    throw new ReleasepressError("invalid_config", "Validated config is required for release metadata");
  }
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
