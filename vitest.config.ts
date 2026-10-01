import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      // `lcov.info` is what scripts/coverage-diff.ts reads; `text` is for the CI log.
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      // Scope matches the published artifact: package.json ships
      // `files: ["src", "README.md"]`. Dev tooling under scripts/ never runs
      // inside a user's pi, so it is not gated.
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/__fixtures__/**", "src/**/*.d.ts"],
      // Emit the report even when a test fails — otherwise a red test hides the
      // coverage verdict, which is the one number the gate still needs to show.
      reportOnFailure: true,
    },
  },
});
