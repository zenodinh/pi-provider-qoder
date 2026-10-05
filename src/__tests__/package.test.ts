import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  pi: { extensions: string[] };
  scripts: Record<string, string>;
};

describe("published Pi extension entry", () => {
  it("points pi.extensions at the TypeScript source, and files ships it", () => {
    // Pi loads TypeScript entries through jiti — no build step needed (docs:
    // "Pi uses jiti, so local TypeScript extensions do not need a separate
    // compilation step"). The 0.3.0 incident (#18, #21) was a files/entry
    // mismatch, not a TS limitation: the manifest pointed at src/index.ts
    // while `files` shipped only dist/, so the tarball carried no entry file
    // and Pi silently listed the package without loading it (reproduced: a
    // missing entry registers zero models and prints no error). Verified on
    // pi 0.87.1 for git sources too: clone + `npm install --omit=dev` loads
    // every model straight from src/index.ts.
    expect(pkg.files).toContain("src");
    expect(pkg.files).not.toContain("dist");
    // The test suite and recorded fixtures are development-only: npm's `!`
    // entries keep them out of the published tarball's file list.
    expect(pkg.files).toContain("!src/__tests__");
    expect(pkg.files).toContain("!src/__fixtures__");
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
  });

  it("has no prepare script (pi installs git sources with npm install --omit=dev)", () => {
    // npm still runs `prepare` during that install, but devDependencies are
    // omitted, so a prepare that shells out to a build tool (esbuild) fails
    // the whole install (npm exit 127) and pi deletes the clone.
    expect(pkg.scripts.prepare).toBeUndefined();
  });

  it("keeps every pi.extensions path inside the published files set", () => {
    for (const entry of pkg.pi.extensions) {
      const normalized = normalize(entry).replaceAll("\\", "/");
      const published = pkg.files.some((file) => {
        const prefix = file.replace(/\/$/, "");
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      });
      expect(published, entry).toBe(true);
    }
  });
});
