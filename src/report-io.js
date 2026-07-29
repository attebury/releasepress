import fs from "node:fs";
import path from "node:path";
import { ReleasepressError } from "./config.js";

export const MAX_REPORT_BYTES = 64 * 1024;
export const REPORT_DIR = ".releasepress-report";

/**
 * Read a JSON file with size and symlink guards. Throws on unsafe or oversized input.
 */
export function readBoundedJson(file, invalidCode = "report_json_invalid", options = {}) {
  const oversizedCode = options.oversizedCode ?? "report_oversized";
  const oversizedMessage = options.oversizedMessage ?? "Report exceeds the size limit";
  const invalidMessage = options.invalidMessage ?? "Report is not valid JSON";
  const symlinkMessage = options.symlinkMessage ?? "Report must not be a symlink";
  const notFileMessage = options.notFileMessage ?? "Report must be a regular file";
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;

  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path: file });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", symlinkMessage, { path: file });
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("invalid_path", notFileMessage, { path: file });
  }
  if (stat.size > maxBytes) {
    throw new ReleasepressError(oversizedCode, oversizedMessage, {
      path: file,
      size: stat.size,
      max_size: maxBytes
    });
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof ReleasepressError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ReleasepressError(invalidCode, invalidMessage, {
        path: file,
        reason: error.message
      });
    }
    throw error;
  }
}

/**
 * Soft-fail report reader for .releasepress-report JSON files.
 * Returns { ok, value } or { ok: false, status, reason, report }.
 */
export function readJsonReport(root, report) {
  const file = path.join(root, REPORT_DIR, report);
  try {
    return {
      ok: true,
      value: readBoundedJson(file, "report_json_invalid", {
        oversizedCode: "report_oversized",
        oversizedMessage: "Releasepress report exceeds the size limit",
        invalidMessage: "Releasepress report is not valid JSON",
        symlinkMessage: "Releasepress report must not be a symlink",
        notFileMessage: "Releasepress report must be a regular file"
      })
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, status: "missing", reason: "report_missing", report };
    }
    if (error instanceof ReleasepressError) {
      if (error.code === "report_oversized") {
        return { ok: false, status: "invalid", reason: "report_oversized", report };
      }
      if (error.code === "report_json_invalid" || error.code === "symlink_selected" || error.code === "invalid_path") {
        return {
          ok: false,
          status: "invalid",
          reason: error.code === "report_json_invalid" ? "report_json_invalid" : error.code,
          report
        };
      }
    }
    throw error;
  }
}
