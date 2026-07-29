import fs from "node:fs";
import path from "node:path";
import { isInsidePath, ReleasepressError } from "./config.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Copy a regular file with O_NOFOLLOW and before/after identity checks.
 * Prevents symlink TOCTOU between selection and copy.
 */
export function copyStableFile({
  sourceRoot,
  destinationRoot,
  rel,
  remainingBytes = Number.MAX_SAFE_INTEGER,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  codes = {}
}) {
  const unsafeCode = codes.unsafe ?? "copy_source_unsafe";
  const escapeCode = codes.escape ?? "copy_path_escape";
  const tooLargeCode = codes.tooLarge ?? "copy_file_too_large";
  const changedCode = codes.changed ?? "copy_source_changed";
  const writeCode = codes.write ?? "copy_write_failed";
  const noFollowCode = codes.noFollow ?? "copy_nofollow_unavailable";

  const source = path.resolve(sourceRoot, rel);
  const destination = path.resolve(destinationRoot, rel);
  if (!isInsidePath(sourceRoot, source) || !isInsidePath(destinationRoot, destination)) {
    throw new ReleasepressError(escapeCode, "Copy destination escaped output root", {
      path: rel
    });
  }

  const before = fs.lstatSync(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ReleasepressError(unsafeCode, "Selected copy path is not a regular file", {
      path: rel
    });
  }
  if (before.size > BigInt(maxFileBytes) || before.size > BigInt(remainingBytes)) {
    throw new ReleasepressError(tooLargeCode, "Copy source exceeds size limit", {
      path: rel,
      max_file_bytes: maxFileBytes
    });
  }

  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new ReleasepressError(noFollowCode, "No-follow file reads are unavailable");
  }

  let descriptor;
  let content;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertStableIdentity(before, opened, rel, changedCode);
    content = readExactFile(descriptor, Number(opened.size), rel, changedCode);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    assertStableSnapshot(opened, afterRead, rel, changedCode);
  } catch (error) {
    if (error instanceof ReleasepressError) {
      throw error;
    }
    throw new ReleasepressError(unsafeCode, "Source could not be copied safely", {
      path: rel
    });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }

  let afterPath;
  try {
    afterPath = fs.lstatSync(source, { bigint: true });
  } catch {
    throw new ReleasepressError(changedCode, "Source changed during copy", { path: rel });
  }
  assertStableSnapshot(before, afterPath, rel, changedCode);

  let destinationFd;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    destinationFd = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      Number(before.mode & 0o777n)
    );
    let offset = 0;
    while (offset < content.length) {
      const count = fs.writeSync(destinationFd, content, offset, content.length - offset);
      if (count === 0) {
        throw new Error("short write");
      }
      offset += count;
    }
  } catch (error) {
    if (error instanceof ReleasepressError) {
      throw error;
    }
    throw new ReleasepressError(writeCode, "Source could not be written to destination", {
      path: rel
    });
  } finally {
    if (destinationFd !== undefined) {
      fs.closeSync(destinationFd);
    }
  }
  return content.length;
}

function readExactFile(descriptor, size, rel, changedCode) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, content, offset, size - offset, offset);
    if (count === 0) {
      throw new ReleasepressError(changedCode, "Source changed during copy", { path: rel });
    }
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    throw new ReleasepressError(changedCode, "Source changed during copy", { path: rel });
  }
  return content;
}

function assertStableIdentity(expected, actual, rel, changedCode) {
  if (
    !actual.isFile()
    || expected.dev !== actual.dev
    || expected.ino !== actual.ino
  ) {
    throw new ReleasepressError(changedCode, "Source changed during copy", { path: rel });
  }
}

function assertStableSnapshot(expected, actual, rel, changedCode) {
  assertStableIdentity(expected, actual, rel, changedCode);
  if (
    expected.size !== actual.size
    || expected.mode !== actual.mode
    || expected.mtimeNs !== actual.mtimeNs
    || expected.ctimeNs !== actual.ctimeNs
  ) {
    throw new ReleasepressError(changedCode, "Source changed during copy", { path: rel });
  }
}
