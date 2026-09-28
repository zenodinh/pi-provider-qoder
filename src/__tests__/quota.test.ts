import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQoderQuotaCache, handleQuotaCommand } from "../commands/quota.js";

// recorded-from: live GET https://openapi.qoder.sh/api/v2/quota/usage, 2026-09-28
// (team account; userId dropped; the org package reports `cap`, never `total`).
const TEAM_PAYLOAD = {
  userType: "teams",
  usageType: "credits",
  totalUsagePercentage: 1,
  isQuotaExceeded: false,
  expiresAt: 1792378270595,
  upgradeUrl: "https://qoder.com/pricing?client=qoder",
  userQuota: { total: 3000, used: 3000, remaining: 0, percentage: 1, unit: "credits" },
  orgResourcePackage: { used: 7177, remaining: 15823, percentage: 0.32, unit: "credits", cap: 23000, available: true },
};

// invented: the refresh fixture is the same recorded payload with the org
// package advanced by 823 credits, so the repaint must track a forced fetch.
const REFRESHED_TEAM_PAYLOAD = {
  ...TEAM_PAYLOAD,
  orgResourcePackage: { used: 8000, remaining: 15000, percentage: 0.35, unit: "credits", cap: 23000, available: true },
};

// invented: no non-org account was available to record; fields mirror the
// desktop client's addOnQuota normalizer (total/used/remaining/percentage/unit).
const NON_ORG_PAYLOAD = {
  userType: "personal",
  isQuotaExceeded: false,
  expiresAt: 1792378270595,
  userQuota: { total: 500, used: 100, remaining: 400, percentage: 0.2, unit: "credits" },
  addOnQuota: { total: 1200, used: 300, remaining: 900, percentage: 0.25, unit: "credits" },
};

// invented: an org package that reports `total` instead of `cap`; the mapper
// must keep accepting it (desktop normalizer: `cap ?? total`).
const LEGACY_ORG_PAYLOAD = {
  userType: "teams",
  isQuotaExceeded: false,
  expiresAt: 1792378270595,
  userQuota: { total: 100, used: 10, remaining: 90, percentage: 0.1, unit: "credits" },
  orgResourcePackage: { total: 1000, used: 250, remaining: 750, percentage: 0.25, unit: "credits" },
};

// invented: org package present but suspended (`available: false`, no cap).
const UNAVAILABLE_ORG_PAYLOAD = {
  userType: "teams",
  isQuotaExceeded: false,
  expiresAt: 1792378270595,
  userQuota: { total: 100, used: 10, remaining: 90, percentage: 0.1, unit: "credits" },
  orgResourcePackage: { used: 0, remaining: 0, percentage: 0, unit: "credits", cap: 0, available: false },
};

// invented: the recorded exceeded state is expressed by the flag alone; the
// same account exhausted its plan (used == total == 3,000).
const EXCEEDED_PAYLOAD = { ...TEAM_PAYLOAD, isQuotaExceeded: true };

type PanelFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: undefined) => void,
) => {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
};

interface PanelCapture {
  panel: { render(width: number): string[]; handleInput(data: string): void; invalidate(): void };
  overlay: boolean | undefined;
  done: ReturnType<typeof vi.fn>;
}

interface BuiltCtx {
  ctx: ExtensionCommandContext;
  notify: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
}

const THEME_STUB = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function payloadResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function buildCtx(options: {
  token?: string;
  mode?: "tui" | "rpc";
  onPanel?: (capture: PanelCapture) => void;
}): BuiltCtx {
  const notify = vi.fn();
  const custom = vi.fn((factory: unknown, overlayOptions: { overlay?: boolean } | undefined) => {
    const done = vi.fn();
    const panel = (factory as PanelFactory)({ requestRender: () => {} }, THEME_STUB, {}, done);
    options.onPanel?.({ panel, overlay: overlayOptions?.overlay, done });
    return Promise.resolve(undefined);
  });
  const ctx = {
    mode: options.mode ?? "rpc",
    modelRegistry: {
      getApiKeyForProvider: async (providerID: string) => (providerID === "qoder" ? options.token : undefined),
    },
    ui: { notify, custom },
  } as never;
  return { ctx, notify, custom };
}

function requireCapture(capture: PanelCapture | undefined): PanelCapture {
  if (!capture) throw new Error("quota panel was not opened");
  return capture;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderQuotaCache();
  vi.unstubAllGlobals();
});

describe("qoder-quota command (F4)", () => {
  it("opens a TUI panel with desktop-parity plan and shared add-on rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(TEAM_PAYLOAD)),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const panel = requireCapture(capture);
    expect(panel.overlay).toBe(true);
    const text = panel.panel.render(84).join("\n");
    expect(text).toContain("Plan Credits");
    expect(text).toContain("3,000 / 3,000");
    expect(text).toContain("(used 100%)");
    expect(text).toContain("Remaining 0");
    expect(text).toContain("Shared Add-on Credits");
    expect(text).toContain("7,177 / 23,000");
    expect(text).toContain("(used 32%)");
    expect(text).toContain("Remaining 15,823");
    expect(text).toContain("Renews on Oct 19, 2026");
    expect(text).toContain("qoder.com/account/usage?client=qoder");
  });

  it("renders the add-on quota row for non-org accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(NON_ORG_PAYLOAD)),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const text = requireCapture(capture).panel.render(84).join("\n");
    expect(text).toContain("Add-on Credits");
    expect(text).toContain("300 / 1,200");
    expect(text).toContain("(used 25%)");
    expect(text).toContain("Remaining 900");
    expect(text).not.toContain("Shared Add-on Credits");
  });

  it("keeps accepting the legacy total-shaped org package", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(LEGACY_ORG_PAYLOAD)),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const text = requireCapture(capture).panel.render(84).join("\n");
    expect(text).toContain("Shared Add-on Credits");
    expect(text).toContain("250 / 1,000");
    expect(text).toContain("Remaining 750");
  });

  it("fits the rows when the host renders the panel narrower", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(TEAM_PAYLOAD)),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const text = requireCapture(capture).panel.render(80).join("\n");
    expect(text).toContain("Remaining 15,823");
    expect(text).toContain("(used 100%)");
    expect(text).not.toContain("(used 32%)");
    expect(text).not.toContain("...");
  });

  it("marks a suspended org package instead of inventing numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(UNAVAILABLE_ORG_PAYLOAD)),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const text = requireCapture(capture).panel.render(84).join("\n");
    expect(text).toContain("Shared Add-on Credits");
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("0 / 0");
  });

  it("closes on escape and on q", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(TEAM_PAYLOAD)),
    );
    let first: PanelCapture | undefined;
    const firstCtx = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        first = c;
      },
    });
    await handleQuotaCommand("", firstCtx.ctx);
    requireCapture(first).panel.handleInput("\x1b");
    expect(requireCapture(first).done).toHaveBeenCalledWith(undefined);

    let second: PanelCapture | undefined;
    const secondCtx = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        second = c;
      },
    });
    await handleQuotaCommand("", secondCtx.ctx);
    requireCapture(second).panel.handleInput("q");
    expect(requireCapture(second).done).toHaveBeenCalledWith(undefined);
  });

  it("r refreshes with a forced fetch and repaints the new numbers", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return payloadResponse(call === 1 ? TEAM_PAYLOAD : REFRESHED_TEAM_PAYLOAD);
    });
    vi.stubGlobal("fetch", fetchMock);
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const panel = requireCapture(capture).panel;
    expect(panel.render(84).join("\n")).toContain("7,177 / 23,000");
    panel.handleInput("r");
    await vi.waitFor(
      () => {
        expect(panel.render(84).join("\n")).toContain("8,000 / 23,000");
      },
      { timeout: 5000 },
    );
    expect(panel.render(84).join("\n")).toContain("Remaining 15,000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows the failure reason inside the panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    let capture: PanelCapture | undefined;
    const { ctx } = buildCtx({
      token: "fake-token",
      mode: "tui",
      onPanel: (c) => {
        capture = c;
      },
    });
    await handleQuotaCommand("", ctx);
    const text = requireCapture(capture).panel.render(84).join("\n");
    expect(text).toContain("quota unavailable: Qoder HTTP 500");
  });

  it("prints the same report as text outside the TUI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(TEAM_PAYLOAD)),
    );
    const { ctx, notify, custom } = buildCtx({ token: "fake-token" });
    await handleQuotaCommand("", ctx);
    expect(custom).not.toHaveBeenCalled();
    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("[Qoder (Browser OAuth / PAT)] · teams");
    expect(text).toContain("Plan Credits: 3,000 / 3,000 credits (used 100%) — Remaining 0 — Renews on Oct 19, 2026");
    expect(text).toContain("Shared Add-on Credits: 7,177 / 23,000 credits (used 32%) — Remaining 15,823");
    expect(text).toContain("View details: https://qoder.com/account/usage?client=qoder");
    expect(notify.mock.calls[0]?.[1]).toBe("info");
  });

  it("reports quota unavailable with the reason and invents no numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const { ctx, notify } = buildCtx({ token: "fake-token" });
    await handleQuotaCommand("", ctx);
    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("quota unavailable");
    expect(text).not.toContain("7,177");
  });

  it("warns when no credentials are configured", async () => {
    const { ctx, notify } = buildCtx({});
    await handleQuotaCommand("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no Qoder credentials"), "warning");
  });

  it("serves the second invocation from the 60 s cache", async () => {
    const fetchMock = vi.fn(async () => payloadResponse(TEAM_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, notify } = buildCtx({ token: "fake-token" });
    await handleQuotaCommand("", ctx);
    await handleQuotaCommand("", ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[1]?.[0])).toContain("(cached");
  });

  it("shares one in-flight fetch across concurrent invocations", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Barrier: release both invocations only once both have asked for the API
    // key, so each has passed its first await before either reaches the fetch.
    let keyCalls = 0;
    let releaseKeys: (() => void) | undefined;
    const keysReady = new Promise<void>((resolve) => {
      releaseKeys = resolve;
    });
    const slowCtx = () => {
      const notify = vi.fn();
      const ctx = {
        mode: "rpc",
        modelRegistry: {
          getApiKeyForProvider: async (providerID: string) => {
            if (providerID !== "qoder") return undefined;
            keyCalls += 1;
            if (keyCalls >= 2) releaseKeys?.();
            await keysReady;
            return "fake-token";
          },
        },
        ui: { notify, custom: vi.fn() },
      } as never;
      return { ctx, notify };
    };
    const first = slowCtx();
    const second = slowCtx();
    const pending = [handleQuotaCommand("", first.ctx), handleQuotaCommand("", second.ctx)];
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    resolveFetch?.(payloadResponse(TEAM_PAYLOAD));
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(first.notify.mock.calls[0]?.[0])).toContain("Plan Credits");
    expect(String(second.notify.mock.calls[0]?.[0])).toContain("Plan Credits");
  });

  it("warns on an exceeded account and offers the upgrade link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => payloadResponse(EXCEEDED_PAYLOAD)),
    );
    const { ctx, notify } = buildCtx({ token: "fake-token" });
    await handleQuotaCommand("", ctx);
    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("Quota exceeded");
    expect(text).toContain("Upgrade plan: https://qoder.com/pricing?client=qoder");
    expect(notify.mock.calls[0]?.[1]).toBe("warning");
  });
});
