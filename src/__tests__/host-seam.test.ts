/**
 * fs-qoder-host-seam (CU-01) — the seam is the only module that acquires the two
 * pi-compat symbols, and its failures are named.
 *
 * Scanner instrument (env-capability substitution, sanctioned 2026-10-03): the
 * spec's TS adaptation names `ts.createSourceFile` plus a `SyntaxKind.Identifier`
 * walk, but this repo's devDependency is `typescript@7.0.2` — the native (Go)
 * compiler, whose root export is `lib/version.cjs` (`{version}` only) and whose
 * `typescript/unstable/ast` scanner returns stub tokens (no `EndOfFileToken`,
 * empty text). No classic compiler API is available. T-02/T-03 therefore use a
 * dependency-free single-pass lexer over the same source text: it strips line
 * and block comments, single/double-quoted strings, template literals and regex
 * literals by construction, so the `index.ts:78` log string cannot false-positive
 * the way a word-boundary grep would.
 *
 * Scanner scope (second substitution, sanctioned 2026-10-03): the spec's literal
 * "the only pi-ai subpath specifier anywhere in src is /compat" is falsified by
 * pre-existing, deliberate test imports — `error-vocabulary.test.ts:13` imports
 * `@earendil-works/pi-ai/utils/retry`, and `providers.test.ts:22,96,100,105,150`
 * carry compat mocks. Those modules are never loaded by the host (pi loads only
 * `src/index.ts` and its import graph), so T-03 is scoped to the host-loadable
 * production surface.
 *
 * T-02 is symbol-scoped rather than name-scoped: a name token counts as an
 * acquisition unless it is a member name (`x.registerApiProvider`), an object or
 * type member key (`registerApiProvider: spy` — what `providers.test.ts`
 * legitimately contains), or is bound by an import from the seam itself (what
 * `v2.ts` legitimately does). A re-import from the compat facade, a destructured
 * dynamic import, or a bare re-export is still caught. Reaching the compat
 * module at all outside the seam is T-03's half of the pair.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const srcRoot = fileURLToPath(new URL("../", import.meta.url));
const seamFile = join(srcRoot, "host-seam.ts");
const seamTestFile = fileURLToPath(import.meta.url);
const compatSpecifier = "@earendil-works/pi-ai/compat";

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

type TokenKind = "identifier" | "number" | "string" | "template" | "regex" | "punct";

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

/** Keywords after which a `/` opens a regex rather than dividing. */
const regexPrecedingKeywords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const identifierStart = /[_$A-Za-z]/;
const identifierPart = /[_$A-Za-z0-9]/;

/** The two compat-only symbols this spec moves behind the seam. */
const scannedSymbols = ["openAICompletionsApi", "registerApiProvider"];

/**
 * Tokenize TypeScript source for symbol scanning. Comments, string literals,
 * template-literal text and regex literals never yield `identifier` tokens;
 * `${...}` expression bodies inside templates are scanned as code.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

  const previousToken = (): Token | undefined => tokens[tokens.length - 1];

  function emit(kind: TokenKind, text: string, atLine: number): void {
    tokens.push({ kind, text, line: atLine });
  }

  function regexAllowed(): boolean {
    const previous = previousToken();
    if (!previous) return true;
    if (previous.kind === "number" || previous.kind === "string" || previous.kind === "template") return false;
    if (previous.kind === "regex") return false;
    if (previous.kind === "identifier") return regexPrecedingKeywords.has(previous.text);
    return !")]}".includes(previous.text);
  }

  /** Scan code until end of input, or until the `}` matching an open `${` at depth 0. */
  function scanCode(stopAtClosingBrace: boolean): void {
    let braceDepth = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];

      if (char === "\n") {
        line += 1;
        index += 1;
        continue;
      }

      if (char === " " || char === "\t" || char === "\r") {
        index += 1;
        continue;
      }

      if (char === "/" && next === "/") {
        while (index < source.length && source[index] !== "\n") index += 1;
        continue;
      }

      if (char === "/" && next === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          if (source[index] === "\n") line += 1;
          index += 1;
        }
        index += 2;
        continue;
      }

      if (char === '"' || char === "'") {
        const opening = char;
        const atLine = line;
        let text = "";
        index += 1;
        while (index < source.length && source[index] !== opening) {
          if (source[index] === "\\") {
            text += source[index];
            index += 1;
            if (index < source.length) {
              if (source[index] === "\n") line += 1;
              text += source[index];
              index += 1;
            }
            continue;
          }
          if (source[index] === "\n") break; // unterminated: do not swallow the rest of the file
          text += source[index];
          index += 1;
        }
        if (source[index] === opening) index += 1;
        emit("string", text, atLine);
        continue;
      }

      if (char === "`") {
        const atLine = line;
        let text = "";
        index += 1;
        while (index < source.length) {
          const inner = source[index];
          if (inner === "\\") {
            index += 2;
            continue;
          }
          if (inner === "\n") {
            line += 1;
            index += 1;
            continue;
          }
          if (inner === "`") {
            index += 1;
            break;
          }
          if (inner === "$" && source[index + 1] === "{") {
            // The expression body is code: `${openAICompletionsApi()}` is a real use.
            text += "${";
            index += 2;
            scanCode(true);
            if (source[index] === "}") index += 1;
            continue;
          }
          text += inner;
          index += 1;
        }
        emit("template", text, atLine);
        continue;
      }

      if (char === "/" && regexAllowed()) {
        const atLine = line;
        let text = "";
        let inClass = false;
        index += 1;
        while (index < source.length) {
          const inner = source[index];
          if (inner === "\\") {
            text += inner;
            index += 1;
            if (index < source.length) {
              text += source[index];
              index += 1;
            }
            continue;
          }
          if (inner === "\n") break;
          if (inner === "[") inClass = true;
          else if (inner === "]") inClass = false;
          else if (inner === "/" && !inClass) break;
          text += inner;
          index += 1;
        }
        if (source[index] === "/") index += 1;
        while (index < source.length && identifierPart.test(source[index])) index += 1;
        emit("regex", text, atLine);
        continue;
      }

      if (char === "}") {
        if (stopAtClosingBrace && braceDepth === 0) return;
        braceDepth -= 1;
        emit("punct", char, line);
        index += 1;
        continue;
      }

      if (char === "{") braceDepth += 1;

      if (identifierStart.test(char)) {
        const atLine = line;
        let text = "";
        while (index < source.length && identifierPart.test(source[index])) {
          text += source[index];
          index += 1;
        }
        emit("identifier", text, atLine);
        continue;
      }

      if (/[0-9]/.test(char)) {
        const atLine = line;
        let text = "";
        while (index < source.length && /[0-9A-Za-z_$.]/.test(source[index])) {
          text += source[index];
          index += 1;
        }
        emit("number", text, atLine);
        continue;
      }

      emit("punct", char, line);
      index += 1;
    }
  }

  scanCode(false);
  return tokens;
}

/**
 * The symbol-scoped rule: a name token is an acquisition or a use unless it is a
 * member name (`x.registerApiProvider`) or an object/type member key
 * (`registerApiProvider: spy`).
 */
function isAcquisition(previous: Token | undefined, next: Token | undefined): boolean {
  if (previous?.text === ".") return false;
  if (next?.text === ":" && previous !== undefined && ["{", ",", "(", ";"].includes(previous.text)) return false;
  return true;
}

/** Identifier tokens named in `names` that are acquisitions (not member names or member keys). */
function acquisitionsIn(tokens: Token[], names: string[] = scannedSymbols): string[] {
  return tokens
    .filter(
      (token, at) =>
        token.kind === "identifier" && names.includes(token.text) && isAcquisition(tokens[at - 1], tokens[at + 1]),
    )
    .map((token) => token.text);
}

function typescriptFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function tokensOf(path: string): Token[] {
  return tokenize(readFileSync(path, "utf8"));
}

/** Every identifier token in `tokens` that carries one of `names`, whatever its position. */
function namesFound(tokens: Token[], names: string[]): string[] {
  return tokens.filter((token) => token.kind === "identifier" && names.includes(token.text)).map((token) => token.text);
}

/**
 * Names an import declaration binds from `specifierSuffix` — `import { a, b as c }
 * from "…/host-seam.js"` binds `a` and `c`.
 */
function importedBindings(tokens: Token[], specifierSuffix: string): Set<string> {
  const names = new Set<string>();
  tokens.forEach((token, at) => {
    if (token.kind !== "string" || !token.text.endsWith(specifierSuffix)) return;
    if (tokens[at - 1]?.text !== "from") return;
    for (let walk = at - 2; walk >= 0 && tokens[walk].text !== "import"; walk -= 1) {
      const candidate = tokens[walk];
      if (candidate.kind !== "identifier" || candidate.text === "as" || candidate.text === "type") continue;
      names.add(candidate.text);
    }
  });
  return names;
}

/** Every import specifier in `source`, static (`from "x"`) or dynamic (`import("x")`). */
function importSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const specifiers: string[] = [];
  tokens.forEach((token, at) => {
    if (token.kind !== "string") return;
    const previous = tokens[at - 1];
    const beforePrevious = tokens[at - 2];
    const isStaticFrom = previous?.text === "from";
    const isDynamic = previous?.text === "(" && beforePrevious?.text === "import";
    if (isStaticFrom || isDynamic) specifiers.push(token.text);
  });
  return specifiers;
}

afterEach(() => {
  vi.doUnmock(compatSpecifier);
  vi.doUnmock("../debug.js");
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// T-01 / T-04 — acquisition behavior
// ---------------------------------------------------------------------------

describe("host seam acquisition", () => {
  it("T-01 acquires both symbols from a present facade", async () => {
    const streamSimple = vi.fn();
    const registerApiProvider = vi.fn();
    vi.doMock(compatSpecifier, () => ({
      openAICompletionsApi: () => ({ streamSimple }),
      registerApiProvider,
    }));

    const seam = await import("../host-seam.js");
    const config = { api: "qoder-api", stream: streamSimple, streamSimple };

    expect(seam.openAICompletionsApi().streamSimple).toBe(streamSimple);
    await expect(seam.registerQoderApiProvider(config, "provider:qoder")).resolves.toBe(true);
    expect(registerApiProvider).toHaveBeenCalledWith(config, "provider:qoder");
  });

  it("T-01 names the missing symbol instead of returning undefined", async () => {
    // The keys are present but undefined: a host whose facade lost the export
    // resolves the name to undefined, which is the silent break this seam makes
    // loud. (Vitest's mock proxy throws on a missing key instead, so an absent
    // key would test the harness rather than the host.)
    vi.doMock(compatSpecifier, () => ({ openAICompletionsApi: undefined, registerApiProvider: undefined }));

    const seam = await import("../host-seam.js");
    expect(() => seam.openAICompletionsApi()).toThrow(seam.QODER_HOST_SEAM_MISSING);

    const failure = (() => {
      try {
        seam.openAICompletionsApi();
      } catch (error) {
        return error as Error;
      }
      return undefined;
    })();
    expect(failure?.message).toContain("openAICompletionsApi");
    // The OB-2 upgrade checklist rides on the failure, not in a comment.
    expect(failure?.message).toContain("OB-2 re-check after the upgrade");
    expect(failure?.message).toContain("src/host-seam.ts");

    // The optional registration stays quiet on the same host: no throw, no value.
    await expect(seam.registerQoderApiProvider({ api: "qoder-api" }, "provider:qoder")).resolves.toBe(false);
  });

  it("T-01 refuses a facade whose accessor no longer returns an Api", async () => {
    vi.doMock(compatSpecifier, () => ({ openAICompletionsApi: () => undefined }));

    const seam = await import("../host-seam.js");
    // "never returns undefined": the call site must not have to null-check.
    expect(() => seam.openAICompletionsApi()).toThrow(/Qoder host seam/);
    expect(() => seam.openAICompletionsApi()).toThrow(/openAICompletionsApi\(\)\.streamSimple/);
  });

  it("T-04 keeps the absent-compat diagnostics when a present export throws", async () => {
    const debugLog = vi.fn();
    vi.doMock("../debug.js", () => ({ debugLog }));
    vi.doMock(compatSpecifier, () => ({
      registerApiProvider: () => {
        throw new Error("compat registry boom");
      },
    }));

    const seam = await import("../host-seam.js");
    await expect(seam.registerQoderApiProvider({ api: "qoder-api" }, "provider:qoder")).resolves.toBe(false);
    // The exact string the pre-seam index.ts:78 carried.
    expect(debugLog).toHaveBeenCalledWith("pi-ai/compat registerApiProvider unavailable", expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// T-02 / T-03 — the seam is the only site
// ---------------------------------------------------------------------------

describe("host seam scanner", () => {
  it("T-02 resolves both compat symbols in host-seam.ts alone", () => {
    const files = typescriptFiles(srcRoot);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(seamFile);

    const found: string[] = [];
    let seamBoundFiles = 0;
    for (const file of files) {
      if (file === seamFile || file === seamTestFile) continue;
      const tokens = tokensOf(file);
      // Carrying the name is allowed only when it resolves to the seam's binding.
      const fromSeam = importedBindings(tokens, "host-seam.js");
      if (scannedSymbols.some((symbol) => fromSeam.has(symbol))) seamBoundFiles += 1;
      tokens.forEach((token, at) => {
        if (token.kind !== "identifier" || !scannedSymbols.includes(token.text)) return;
        if (!isAcquisition(tokens[at - 1], tokens[at + 1])) return;
        if (fromSeam.has(token.text)) return;
        found.push(`${relative(srcRoot, file)}:${token.line} ${token.text}`);
      });
    }

    expect(found).toEqual([]);
    // Without these controls an empty scan would "pass" the row above vacuously.
    expect(seamBoundFiles).toBeGreaterThan(0);
    expect([...new Set(namesFound(tokensOf(seamFile), scannedSymbols))].sort()).toEqual([...scannedSymbols].sort());
    expect(importSpecifiers(readFileSync(seamFile, "utf8"))).toContain(compatSpecifier);
  });

  it("T-03 imports only /compat from pi-ai in the host-loadable modules", () => {
    const testsRoot = join(srcRoot, "__tests__");
    const files = typescriptFiles(srcRoot).filter((file) => !file.startsWith(testsRoot));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(seamFile);

    const subpaths: string[] = [];
    const compatSites: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier !== "@earendil-works/pi-ai" && !specifier.startsWith("@earendil-works/pi-ai/")) continue;
        const location = relative(srcRoot, file);
        if (specifier === compatSpecifier) compatSites.push(location);
        else if (specifier !== "@earendil-works/pi-ai") subpaths.push(`${location} -> ${specifier}`);
      }
    }

    // The /api/* trap: typechecks locally, unreachable under the host's alias whitelist.
    expect(subpaths).toEqual([]);
    // The seam carries both the static import and the dynamic one; the invariant is which file.
    expect([...new Set(compatSites)]).toEqual(["host-seam.ts"]);
  });

  it("excludes comments, strings and template literals by construction (self-check)", () => {
    const literals: [string, string[]][] = [
      ["// openAICompletionsApi\n", []],
      ["/* openAICompletionsApi */\n", []],
      ["const a = 'openAICompletionsApi';\n", []],
      ['const b = "openAICompletionsApi";\n', []],
      ["const c = `openAICompletionsApi`;\n", []],
      // Only a `${…}` expression body inside a template is code.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture must contain the sequence itself.
      ["const d = `x ${openAICompletionsApi}`;\n", ["openAICompletionsApi"]],
      ["const e = /openAICompletionsApi/;\n", []],
    ];
    for (const [snippet, expected] of literals) {
      expect(namesFound(tokenize(snippet), scannedSymbols), snippet).toEqual(expected);
    }

    // A member name or member key carries the name without acquiring it …
    for (const snippet of ["const f = { registerApiProvider: 1 };\n", "const g = host.registerApiProvider;\n"]) {
      const tokens = tokenize(snippet);
      expect(namesFound(tokens, scannedSymbols), snippet).not.toEqual([]);
      expect(acquisitionsIn(tokens), snippet).toEqual([]);
    }

    // … while a bare reference or an import specifier is an acquisition.
    for (const snippet of [
      "registerApiProvider(config, 'provider:qoder');\n",
      "import { openAICompletionsApi } from '../host-seam.js';\n",
    ]) {
      expect(acquisitionsIn(tokenize(snippet)), snippet).toEqual([
        snippet.startsWith("import") ? "openAICompletionsApi" : "registerApiProvider",
      ]);
    }
  });

  it("reads every import specifier shape it must police (self-check)", () => {
    const probe = [
      'import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";',
      'const compat = await import("@earendil-works/pi-ai/compat");',
      'const bad = await import("@earendil-works/pi-ai/api/openai-completions");',
      'vi.doMock("@earendil-works/pi-ai/compat", () => ({}));',
    ].join("\n");
    // Only import declarations carry a specifier; a mock call's argument does not.
    expect(importSpecifiers(probe)).toEqual([
      "@earendil-works/pi-ai/compat",
      "@earendil-works/pi-ai/compat",
      "@earendil-works/pi-ai/api/openai-completions",
    ]);
    expect([...importedBindings(tokenize(probe), "host-seam.js")]).toEqual([]);
    expect(
      [
        ...importedBindings(
          tokenize("import { a, openAICompletionsApi as b } from '../host-seam.js';"),
          "host-seam.js",
        ),
      ].sort(),
      // Both the local binding and the imported name count: either one carries the symbol name.
    ).toEqual(["a", "b", "openAICompletionsApi"]);
  });
});
