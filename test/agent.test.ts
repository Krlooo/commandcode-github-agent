import { describe, expect, it } from "vitest";
import { parseAgentStdout } from "../src/agent";

function frame(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseAgentStdout", () => {
  it("returns the final result frame from an NDJSON stream", () => {
    const stdout = [
      frame({ type: "event", event: { type: "tool_running", toolName: "read_file" } }),
      frame({ type: "event", event: { type: "tool_running", toolName: "edit_file" } }),
      frame({
        type: "result",
        subtype: "success",
        sessionId: "9f4e1c0a",
        stopReason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
        durationMs: 8421,
        finalText: "Done. Changed 2 files.",
      }),
    ].join("\n");
    const result = parseAgentStdout(stdout);
    expect(result).not.toBeNull();
    expect(result?.subtype).toBe("success");
    expect(result?.finalText).toBe("Done. Changed 2 files.");
    expect(result?.sessionId).toBe("9f4e1c0a");
    expect(result?.stopReason).toBe("end_turn");
  });

  it("parses an error result, where sessionId and stopReason are optional", () => {
    const stdout = frame({
      type: "result",
      subtype: "error",
      usage: {},
      durationMs: 120,
      finalText: "",
      error: "auth failed",
    });
    const result = parseAgentStdout(stdout);
    expect(result?.subtype).toBe("error");
    expect(result?.error).toBe("auth failed");
    expect(result?.sessionId).toBeUndefined();
  });

  it("parses a max_turns result", () => {
    const stdout = frame({
      type: "result",
      subtype: "max_turns",
      usage: {},
      durationMs: 1000,
      finalText: "partial",
      sessionId: "abc",
      stopReason: "max_turns",
    });
    expect(parseAgentStdout(stdout)?.subtype).toBe("max_turns");
  });

  it("ignores non-JSON noise and empty lines", () => {
    const stdout = [
      "npm warn something",
      "",
      frame({ type: "event", event: { type: "text", text: "hi" } }),
      "  ",
      frame({
        type: "result",
        subtype: "success",
        usage: {},
        durationMs: 1,
        finalText: "ok",
      }),
    ].join("\n");
    expect(parseAgentStdout(stdout)?.finalText).toBe("ok");
  });

  it("returns null when the stream has no result frame", () => {
    const stdout = frame({ type: "event", event: { type: "text", text: "hi" } });
    expect(parseAgentStdout(stdout)).toBeNull();
  });

  it("returns null for empty stdout", () => {
    expect(parseAgentStdout("")).toBeNull();
  });

  it("keeps the last result frame when more than one is present", () => {
    const stdout = [
      frame({ type: "result", subtype: "success", usage: {}, durationMs: 1, finalText: "first" }),
      frame({ type: "result", subtype: "success", usage: {}, durationMs: 2, finalText: "second" }),
    ].join("\n");
    expect(parseAgentStdout(stdout)?.finalText).toBe("second");
  });
});
