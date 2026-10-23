import crypto from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { clearGatewayCosyVersionMemCache } from "../cosy-version.ts";

const versionCachePath = (): string =>
  join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent", "qoder-cosy-version.json");

/** Decode the signed COSY payload that rides inside the Authorization header. */
function signedCosyVersion(headers: Record<string, string>): string {
  const payloadB64 = headers.Authorization.slice("Bearer COSY.".length).split(".")[0];
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as { cosyVersion: string };
  return payload.cosyVersion;
}

beforeEach(() => {
  // Each case states its own cached CLI version, so no case inherits another's.
  rmSync(versionCachePath(), { force: true });
  clearGatewayCosyVersionMemCache();
});

afterEach(() => {
  rmSync(versionCachePath(), { force: true });
  clearGatewayCosyVersionMemCache();
});

describe("COSY client identity", () => {
  it("sends Cosy-Version and cosyVersion as current qodercli 1.1.77", () => {
    const headers = buildAuthHeaders(null, "https://api3.qoder.sh/algo/api/v2/model/list", {
      userID: "user-1",
      authToken: "token-1",
      name: "Test",
      email: "test@example.com",
      machineID: "machine-1",
    });
    expect(headers["Cosy-Version"]).toBe("1.1.77");

    const auth = headers.Authorization;
    expect(auth.startsWith("Bearer COSY.")).toBe(true);
    const payloadB64 = auth.slice("Bearer COSY.".length).split(".")[0];
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as { cosyVersion: string };
    expect(payload.cosyVersion).toBe("1.1.77");
  });

  it("signs with the resolved gateway version in both the header and the payload", () => {
    // spec: a cached newer CLI release ("1.2.0") -> buildAuthHeaders sends it in
    //   Cosy-Version AND in the signed payload's cosyVersion, never one alone.
    writeFileSync(versionCachePath(), JSON.stringify({ version: "1.2.0", checkedAt: Date.now() }), "utf8");
    clearGatewayCosyVersionMemCache();

    const headers = buildAuthHeaders(null, "https://api3.qoder.sh/algo/api/v2/model/list", {
      userID: "user-1",
      authToken: "token-1",
      name: "Test",
      email: "test@example.com",
      machineID: "machine-1",
    });
    expect(headers["Cosy-Version"]).toBe("1.2.0");
    expect(signedCosyVersion(headers)).toBe("1.2.0");
  });

  it("matches the legacy full-string Cosy signature for a known body Buffer", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") // aes key source
      .mockReturnValueOnce("11111111-2222-3333-4444-555555555555") // requestId
      .mockReturnValueOnce("99999999-8888-7777-6666-555555555555"); // X-Request-Id

    const body = Buffer.from('{"hello":"world","n":1}', "utf8");
    const url = "https://api3.qoder.sh/algo/api/v1/chat";
    const headers = buildAuthHeaders(body, url, {
      userID: "user-1",
      authToken: "token-1",
      name: "Test",
      email: "test@example.com",
      machineID: "machine-1",
    });

    const auth = headers.Authorization;
    const match = auth.match(/^Bearer COSY\.([^.]+)\.([0-9a-f]+)$/);
    expect(match).toBeTruthy();
    const payloadB64 = match?.[1] ?? "";
    const sig = match?.[2] ?? "";
    const cosyKey = headers["Cosy-Key"];
    const timestamp = headers["Cosy-Date"];
    const sigPath = headers["Cosy-Sigpath"];

    const legacyInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${body.toString("utf8")}\n${sigPath}`;
    const legacySig = crypto.createHash("md5").update(legacyInput).digest("hex");
    expect(sig).toBe(legacySig);

    const legacyBodyHash = crypto.createHash("md5").update(body).digest("hex");
    expect(headers["Cosy-Bodyhash"]).toBe(legacyBodyHash);
    expect(headers["Cosy-Bodylength"]).toBe(String(body.length));

    vi.restoreAllMocks();
  });

  it("returns a stable, persisted machine id across calls", () => {
    const first = getMachineId();
    expect(first.length).toBeGreaterThan(0);

    // Memoized after first resolution: reuse, never regenerate.
    expect(getMachineId()).toBe(first);
    expect(getMachineId()).toBe(first);

    // The resolved id matches what was persisted under ~/.pi/agent.
    const persisted = readFileSync(
      join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent", "qoder-machine-id"),
      "utf8",
    ).trim();
    expect(persisted).toBe(first);
  });
});
