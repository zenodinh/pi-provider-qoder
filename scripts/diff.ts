/**
 * Unified-diff reader shared by the CI gates.
 *
 * Both gates consume `git diff --unified=0 <base>...HEAD`: the coverage gate
 * needs the added line *numbers* per file, the security scanner needs the added
 * line *text*. One parser, one set of tests, no third-party dependency.
 *
 * Any unified width works (the new-image line counter advances on context
 * lines too), so a locally-produced `git diff` with the default 3 lines of
 * context parses identically to CI's `--unified=0`.
 *
 * Limitation: git quotes non-ASCII paths (`core.quotepath`) with octal escapes.
 * Surrounding quotes are stripped; escapes are not decoded, so run git with
 * `-c core.quotepath=false` when paths may be non-ASCII. This repo's paths are
 * ASCII.
 */
// shape: pure function module — trigger #1 (one input shape → one output shape,
//   no state, no subclassing). The parser is the trust boundary for git's
//   stdout, so each record is matched and narrowed before any field is read.

/** One added line in the post-image. */
export interface AddedLine {
  /** 1-based line number in the new file. */
  no: number;
  /** Line text without the leading `+`. */
  text: string;
}

/** One file entry of a unified diff. */
export interface DiffFile {
  /** Repo-relative post-image path; the pre-image path for a deletion. */
  path: string;
  /** Pre-image path when it differs from `path` (a rename or a copy). */
  fromPath?: string;
  added: AddedLine[];
  deletedCount: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

/** `@@ -old,count +new,count @@` — only the new-image side is needed. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+?)"?$/;

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function stripQuotes(value: string): string {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function emptyFile(path: string): DiffFile {
  return { path, added: [], deletedCount: 0, isNew: false, isDeleted: false, isBinary: false };
}

/**
 * Parse a unified diff into per-file records.
 *
 * Malformed input degrades to "fewer attributed lines", never to a wrong line
 * number: an unparseable hunk header stops attributing lines for that file
 * instead of guessing, because a wrong number would silently exempt a real
 * change from the coverage gate.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let gitPath: string | undefined;
  let nextLineNo: number | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    const git = GIT_HEADER.exec(line);
    if (git) {
      gitPath = stripQuotes(git[2]);
      current = undefined;
      nextLineNo = undefined;
      continue;
    }

    if (line.startsWith("--- ")) {
      const from = stripQuotes(line.slice(4).trim());
      if (current === undefined) {
        current = emptyFile(gitPath ?? stripPrefix(from, "a/"));
        files.push(current);
      }
      current.fromPath = from === "/dev/null" ? undefined : stripPrefix(from, "a/");
      current.isNew = from === "/dev/null";
      continue;
    }

    if (line.startsWith("+++ ")) {
      const to = stripQuotes(line.slice(4).trim());
      if (current === undefined) {
        current = emptyFile(gitPath ?? stripPrefix(to, "b/"));
        files.push(current);
      }
      current.isDeleted = to === "/dev/null";
      if (!current.isDeleted) current.path = stripPrefix(to, "b/");
      continue;
    }

    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      if (current === undefined) {
        current = emptyFile(gitPath ?? "(binary)");
        files.push(current);
      }
      current.isBinary = true;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const start = Number.parseInt(hunk[1], 10);
      const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
      // `+0,0` is a pure deletion: no new-image lines to attribute.
      nextLineNo = Number.isInteger(start) && count > 0 ? start : undefined;
      continue;
    }

    if (current === undefined) continue;

    if (line.startsWith("+")) {
      if (nextLineNo !== undefined) {
        current.added.push({ no: nextLineNo, text: line.slice(1) });
        nextLineNo += 1;
      }
      continue;
    }
    if (line.startsWith("-")) {
      current.deletedCount += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (nextLineNo !== undefined) nextLineNo += 1;
    }
    // `\ No newline at end of file` and any other marker consume no line.
  }

  return files.filter((file) => file.path.length > 0);
}

/** Repo-relative POSIX paths of every file the diff touches. */
export function changedPaths(files: readonly DiffFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    if (file.fromPath !== undefined) paths.add(file.fromPath);
  }
  return [...paths];
}
