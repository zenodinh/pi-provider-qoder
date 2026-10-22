// shape: none — dispatch object / closure object literal / class all miss: one
//   pure `string → string` leaf with a two-state scan, no discriminator table,
//   no per-instance state.

/**
 * Escape-only repair for finished tool-call arguments.
 *
 * A model that copies the file it is editing into an `edit` argument writes that
 * file's bytes into a JSON string literal, so a *complete* call can carry a raw
 * newline or tab, or a backslash that starts no JSON escape (`\d`, a short
 * `\u12`, a trailing `\`). `JSON.parse` rejects the whole call, and the turn used
 * to die with "Invalid or truncated Qoder tool call arguments" even though every
 * argument was present.
 *
 * Only bytes inside string literals are re-escaped, so the decoded value stays
 * byte-for-byte what the model meant. Structure is never added, removed,
 * truncated or guessed: a call cut off by the output limit stays broken, which
 * is what the caller's strict rejection relies on.
 */

/** The characters that are legal immediately after a backslash in JSON. */
const VALID_ESCAPE_CHARACTERS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** `\uXXXX` needs exactly four hex digits, or the `u` started no escape at all. */
const UNICODE_ESCAPE_DIGITS = /^[0-9a-fA-F]{4}$/;

/** JSON's short form for a control character, or its `\u00xx` fallback. */
function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

/**
 * Re-escape the illegal bytes inside JSON string literals: a raw control
 * character becomes its escape form, and a backslash that starts no valid escape
 * is doubled so it decodes as a literal backslash.
 *
 * Returns text equal to `value` when nothing needed repairing, so a caller can
 * skip a second parse by comparing the result with its input.
 */
export function repairJsonEscapes(value: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!inString) {
      if (char === '"') inString = true;
      repaired += char;
      continue;
    }

    if (char === '"') {
      inString = false;
      repaired += char;
      continue;
    }

    if (char !== "\\") {
      repaired += char.charCodeAt(0) <= 0x1f ? escapeControlCharacter(char) : char;
      continue;
    }

    const escapeChar = value[index + 1];
    if (escapeChar === "u" && UNICODE_ESCAPE_DIGITS.test(value.slice(index + 2, index + 6))) {
      repaired += value.slice(index, index + 6);
      index += 5;
      continue;
    }

    if (escapeChar !== undefined && VALID_ESCAPE_CHARACTERS.has(escapeChar)) {
      repaired += `\\${escapeChar}`;
      index += 1;
      continue;
    }

    // `\d`, `\q`, a short `\u12`, or a backslash with nothing left to escape:
    // the model meant a literal backslash, so the backslash needs escaping to
    // keep that meaning.
    repaired += "\\\\";
  }

  return repaired;
}
