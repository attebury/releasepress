import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReleasepressError } from "./config.js";

const PACKAGE_JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function getVersionInfo({ packageJsonPath = PACKAGE_JSON_PATH } = {}) {
  const metadata = readPackageMetadata(packageJsonPath);
  return {
    ok: true,
    type: "releasepress.version.v1",
    schema_version: 1,
    tool: "releasepress",
    package_name: metadata.name,
    version: metadata.version,
    source: "package.json",
    node_version: process.version
  };
}

export function formatVersionText(info) {
  return `${info.tool} ${info.version}`;
}

function readPackageMetadata(packageJsonPath) {
  let text;
  try {
    text = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw metadataError("package_json_missing");
    }
    throw metadataError("package_json_unreadable");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw metadataError("package_json_invalid");
  }

  if (!parsed || typeof parsed !== "object") {
    throw metadataError("package_json_invalid");
  }
  if (parsed.name !== "releasepress") {
    throw metadataError("package_name_invalid");
  }
  if (typeof parsed.version !== "string" || !SEMVER_PATTERN.test(parsed.version)) {
    throw metadataError("package_version_invalid");
  }

  return {
    name: parsed.name,
    version: parsed.version
  };
}

function metadataError(reason) {
  return new ReleasepressError("version_metadata_unavailable", "Version metadata is unavailable", {
    source: "package.json",
    reason
  });
}
