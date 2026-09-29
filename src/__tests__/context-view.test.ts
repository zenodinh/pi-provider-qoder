import { describe, expect, it, vi } from "vitest";
import { showContextPanel } from "../commands/context-view.js";

// Hermetic config dir so the panel never reads or writes the developer's live
// ~/.pi/agent models.json/settings.json.
vi.mock("../home.js", async (importOriginal) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const actual = await importOriginal<typeof import("../home.js")>();
  let dir: string | undefined;
  return { ...actual, getPiAgentDir: () => (dir ??= mkdtempSync(join(tmpdir(), "qoder-ctx-"))) };
});

interface CapturedComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/** Fake TUI host: captures the component the panel factory returns. */
async function openPanel(): Promise<{ component: CapturedComponent; renders: { count: number } }> {
  const renders = { count: 0 };
  const fakeTui = { requestRender: () => void renders.count++ };
  const fakeTheme = { fg: (_kind: string, s: string) => s, bold: (s: string) => s };
  let component: CapturedComponent | undefined;
  const fakeCtx = {
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => CapturedComponent) => {
        component = factory(fakeTui, fakeTheme, {}, () => {});
        return component;
      },
    },
  };
  await showContextPanel(fakeCtx as never);
  if (!component) throw new Error("factory did not return a component");
  return { component, renders };
}

const DOWN = "\x1b[B";
const ENTER = "\r";

describe("showContextPanel", () => {
  it("returns a full-area Component with render/handleInput/invalidate", async () => {
    const { component } = await openPanel();
    expect(typeof component.render).toBe("function");
    expect(typeof component.handleInput).toBe("function");
    expect(typeof component.invalidate).toBe("function");

    const lines = component.render(80);
    const rule = "─".repeat(80);
    expect(lines[0]).toBe(rule);
    expect(lines[lines.length - 1]).toBe(rule);
  });

  it("navigates the model list and into a section via down/enter", async () => {
    const { component, renders } = await openPanel();
    const before = component.render(80).join("\n");

    component.handleInput(DOWN);
    component.handleInput(ENTER);
    const after = component.render(80).join("\n");

    // Entering a section changes what the panel renders.
    expect(after).not.toBe(before);
    // Repaints were requested through the fake TUI.
    expect(renders.count).toBeGreaterThan(0);
  });
});
