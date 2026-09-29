import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MENTIONS, parseMentions } from "../src/mentions";

describe("parseMentions", () => {
  it("splits on commas and trims each mention", () => {
    expect(parseMentions("/cmd, @commandcode-agent")).toEqual(["/cmd", "@commandcode-agent"]);
  });

  it("drops empty entries", () => {
    expect(parseMentions(" /cmd ,, ")).toEqual(["/cmd"]);
  });

  it("falls back to the default when the value is empty or blank", () => {
    expect(parseMentions("")).toEqual([DEFAULT_MENTIONS]);
    expect(parseMentions("   ")).toEqual([DEFAULT_MENTIONS]);
    expect(parseMentions(",,")).toEqual([DEFAULT_MENTIONS]);
  });
});

describe("mentions default", () => {
  it("matches the default declared for the mentions input in action.yml", () => {
    const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
    const block = action.match(/^ {2}mentions:\s*\n((?: {4}.*\n)+)/m)?.[1] ?? "";
    const declared = block.match(/^ {4}default:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    expect(declared).toBe(DEFAULT_MENTIONS);
  });
});
