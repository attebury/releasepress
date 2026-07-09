import fs from "node:fs";
import path from "node:path";
import { matchesPattern, ReleasepressError, toPosixPath } from "./config.js";

const SECRET_DETECTORS = [
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
    id: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    id: "generic_secret_assignment",
    pattern: /\b(?:token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_.\-+/=]{24,}/gi
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
    const text = fs.readFileSync(entry.absolute, "utf8");
    scanForbiddenStrings(text, entry.path, config.forbidden_strings, findings);
    scanSecretRegexes(text, entry.path, config.scan?.secret_detectors, findings);
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
  const mergedDetectors = [...SECRET_DETECTORS];
  configDetectors.forEach((d) => {
    let regex;
    try {
      regex = new RegExp(d.pattern, "g");
    } catch (err) {
      throw new ReleasepressError("invalid_config", `Invalid custom secret regex pattern '${d.pattern}' for detector '${d.id}': ${err.message}`);
    }
    mergedDetectors.push({ id: d.id, pattern: regex });
  });

  for (const detector of mergedDetectors) {
    detector.pattern.lastIndex = 0;
    const match = detector.pattern.exec(text);
    if (match) {
      findings.push({
        file,
        line: lineForOffset(text, match.index),
        detector: detector.id
      });
    }
  }
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

