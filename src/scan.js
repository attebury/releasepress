import fs from "node:fs";
import path from "node:path";
import { findSensitiveText } from "atteguard/text-safety";
import { matchesPattern, ReleasepressError, toPosixPath } from "./config.js";

// Exact, bounded status/denial sentinel values that assignment detectors
// must not treat as credential material -- these are values, not secrets,
// and appear legitimately next to key names like "authorization" or
// "token_status" (e.g. `authorization: "not_granted"`). Matches the
// SAFE_ASSIGNMENT_VALUES precedent already used for this same purpose in
// atteguard/text-safety, plus "not_granted" for the denial-sentinel case
// this set exists to cover.
const SAFE_ASSIGNMENT_VALUES = new Set([
  "absent",
  "false",
  "none",
  "not_applicable",
  "not_granted",
  "not_present",
  "redacted",
  "true",
  "unavailable",
  "unknown"
]);

const MAX_SCAN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CUSTOM_REGEX_INPUT_BYTES = 100_000;
const MAX_FINDINGS_PER_DETECTOR_PER_FILE = 50;

// A bare (unquoted) identifier-shaped value that itself starts with one of
// these same secret-keyword roots is source code referencing its own
// configuration surface (e.g. `secret_detectors: secretDetectors`,
// `token: tokenList`), not a leaked credential -- a real secret value is
// never itself a readable restatement of its own key name. Scoped narrowly:
// only applies to values that are pure identifiers (letters/digits only, no
// separators or special characters), so quoted string secrets and
// mixed-charset tokens are unaffected.
const IDENTIFIER_LIKE_VALUE = /^[A-Za-z][A-Za-z0-9]*$/;
const SELF_REFERENTIAL_VALUE_PREFIXES = ["token", "secret", "password", "passwd", "apikey", "accesstoken", "authorization"];

// Releasepress-owned assignment and forge-token detectors. Static JWT / AWS /
// private-key / credential-URL shapes come from Atteguard text-safety so the
// patterns cannot drift (#93, #97).
const ASSIGNMENT_DETECTORS = [
  {
    id: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g
  },
  {
    id: "github_fine_grained_token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
  },
  {
    id: "gitea_token_assignment",
    pattern: /\bGITEA_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{20,}/g
  },
  {
    id: "aws_secret_access_key_assignment",
    pattern: /(?<![A-Za-z0-9])["']?AWS_SECRET_ACCESS_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/gm
  },
  {
    id: "generic_secret_assignment",
    pattern: /(?<![A-Za-z0-9])["']?(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:token|secret|password|passwd|api[_-]?key|access[_-]?token|authorization)(?:[_-][A-Za-z0-9]+)*["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gim,
    valueGroup: 1
  },
  {
    id: "camel_case_secret_assignment",
    pattern: /(?<![A-Za-z0-9])["']?(?!(?:apiKey|accessToken|authorization)["']?\s*[:=])(?:[a-z][A-Za-z0-9]*?(?:Token|Secret|Password|Passwd|ApiKey|APIKey|AccessToken|Authorization)|secretKey)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gm,
    valueGroup: 1
  }
];

// Aligned with atteguard/text-safety STATIC_TEXT_RULES (JWT middle segment is any base64url).
const ATTEGUARD_ALIGNED_STATIC_DETECTORS = [
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  },
  {
    id: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    id: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi
  },
  {
    id: "credential_url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/gi
  }
];

export function scanPath({ root, config }) {
  if (!root) {
    throw new ReleasepressError("missing_path", "--path is required");
  }

  const scanRoot = path.resolve(root);
  const entries = enumerateScanFiles(scanRoot);
  const findings = [];

  const scanExclude = config.scan?.exclude ?? [];
  let filesScanned = 0;

  for (const entry of entries) {
    if (scanExclude.some((pattern) => matchesPattern(entry.path, pattern))) {
      continue;
    }

    filesScanned += 1;
    const text = readScannableText(entry);
    scanForbiddenStrings(text, entry.path, config.forbidden_strings, findings);
    scanSecretRegexes(text, entry.path, config.scan?.secret_detectors, findings);
    scanAtteguardSecrets(text, entry.path, findings);
  }

  const result = {
    ok: findings.length === 0,
    type: "releasepress_scan",
    root: scanRoot,
    files_scanned: filesScanned,
    files_excluded: entries.length - filesScanned,
    findings
  };

  const reportDir = path.join(scanRoot, ".releasepress-report");
  if (fs.existsSync(scanRoot)) {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "scan-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

function enumerateScanFiles(root) {
  const entries = [];

  function walk(dir) {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      const rel = toPosixPath(path.relative(root, absolute));

      if (rel === ".git" || rel.startsWith(".git/")) {
        continue;
      }

      if (rel === ".releasepress-report" || rel.startsWith(".releasepress-report/")) {
        continue;
      }

      if (rel === "node_modules" || rel.startsWith("node_modules/")) {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        throw new ReleasepressError("symlink_selected", "Scan path contains a symlink", { path: rel });
      }

      if (dirent.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (dirent.isFile()) {
        entries.push({ path: rel, absolute });
      }
    }
  }

  walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

function scanForbiddenStrings(text, file, forbiddenStrings, findings) {
  forbiddenStrings.forEach((value, index) => {
    if (!value) {
      return;
    }

    const offset = text.indexOf(value);
    if (offset === -1) {
      return;
    }

    findings.push({
      file,
      line: lineForOffset(text, offset),
      detector: "forbidden_string",
      forbidden_index: index
    });
  });
}

function scanSecretRegexes(text, file, configDetectors = [], findings) {
  const mergedDetectors = [...ASSIGNMENT_DETECTORS, ...ATTEGUARD_ALIGNED_STATIC_DETECTORS];
  const customInput = text.length > MAX_CUSTOM_REGEX_INPUT_BYTES
    ? text.slice(0, MAX_CUSTOM_REGEX_INPUT_BYTES)
    : text;

  configDetectors.forEach((d) => {
    let regex;
    try {
      regex = new RegExp(d.pattern, "g");
    } catch (err) {
      throw new ReleasepressError(
        "invalid_config",
        `Invalid custom secret regex pattern '${d.pattern}' for detector '${d.id}': ${err.message}`
      );
    }
    mergedDetectors.push({ id: d.id, pattern: regex, custom: true });
  });

  for (const detector of mergedDetectors) {
    const haystack = detector.custom ? customInput : text;
    detector.pattern.lastIndex = 0;
    let match = detector.pattern.exec(haystack);
    let count = 0;
    while (match) {
      if (!isSafeAssignmentValue(detector, match)) {
        findings.push({
          file,
          line: lineForOffset(haystack, match.index),
          detector: detector.id
        });
        count += 1;
        if (count >= MAX_FINDINGS_PER_DETECTOR_PER_FILE) {
          break;
        }
      }
      match = detector.pattern.exec(haystack);
    }
  }
}

function scanAtteguardSecrets(text, file, findings) {
  // Atteguard owns static secret policy for overlapping shapes. Local detectors
  // already emit line-accurate findings for the same JWT/AWS/key/URL patterns;
  // this backstop fails closed if Atteguard sees a secret the local pass missed.
  for (const finding of findSensitiveText(text)) {
    const detector = mapAtteguardDetector(finding);
    if (!detector) {
      continue;
    }
    if (findings.some((entry) => entry.file === file && entry.detector === detector)) {
      continue;
    }
    findings.push({
      file,
      line: 1,
      detector
    });
  }
}

function mapAtteguardDetector(finding) {
  if (finding.code === "credential_url") {
    return "credential_url";
  }
  if (finding.code === "private_key") {
    return "private_key";
  }
  if (finding.label === "AWS access-key identifier") {
    return "aws_access_key";
  }
  if (finding.label === "token-like value") {
    // Covers JWT and forge-token shapes that share this Atteguard label.
    return "jwt";
  }
  return null;
}

function isSafeAssignmentValue(detector, match) {
  if (!detector.valueGroup) {
    return false;
  }
  const value = match[detector.valueGroup];
  if (typeof value !== "string") {
    return false;
  }
  const lower = value.toLowerCase();
  if (SAFE_ASSIGNMENT_VALUES.has(lower)) {
    return true;
  }
  return IDENTIFIER_LIKE_VALUE.test(value) && SELF_REFERENTIAL_VALUE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function readScannableText(entry) {
  const stat = fs.lstatSync(entry.absolute);
  if (stat.isSymbolicLink()) {
    throw new ReleasepressError("symlink_selected", "Scan path contains a symlink", { path: entry.path });
  }
  if (!stat.isFile()) {
    throw new ReleasepressError("scan_entry_invalid", "Scan entry is not a regular file", { path: entry.path });
  }
  if (stat.size > MAX_SCAN_FILE_BYTES) {
    throw new ReleasepressError("scan_file_too_large", "Scan file exceeds size limit", {
      path: entry.path,
      size: stat.size,
      max_size: MAX_SCAN_FILE_BYTES
    });
  }
  return fs.readFileSync(entry.absolute, "utf8");
}
