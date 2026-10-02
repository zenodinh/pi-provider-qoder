import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { debugLog } from "../debug.js";
import { readDebugRecords } from "./debug-sink.js";

// spec (owner directive 2026-10-02, supersedes the former console.error
// contract): debugLog appends {type:"debug",message,error?} JSONL records to
// the file sink (extension.jsonl when no session is attributed) and NEVER
// writes to console; it is a no-op unless QODER_DEBUG is set.

let dir: string;

function useTempSink(): void {
  dir = mkdtempSync(join(tmpdir(), "qoder-debuglog-"));
  process.env.QODER_DEBUG_DIR = dir;
}

afterEach(() => {
  delete process.env.QODER_DEBUG;
  delete process.env.QODER_DEBUG_DIR;
  vi.restoreAllMocks();
});

describe("debugLog", () => {
  it("is silent unless QODER_DEBUG is set", () => {
    useTempSink();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("quiet");
    expect(spy).not.toHaveBeenCalled();
    expect(readDebugRecords(dir)).toEqual([]);
  });

  it("records the message and error in the file sink, console silent", () => {
    useTempSink();
    process.env.QODER_DEBUG = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("something failed", new Error("boom"));
    const records = readDebugRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe("debug");
    expect(records[0]?.message).toBe("something failed");
    const error = records[0]?.error as { name: string; message: string };
    expect(error.name).toBe("Error");
    expect(error.message).toBe("boom");
    expect(spy).not.toHaveBeenCalled();
  });

  it("records without an error argument", () => {
    useTempSink();
    process.env.QODER_DEBUG = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("note");
    const records = readDebugRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("note");
    expect(records[0]?.error).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
