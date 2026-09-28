import { describe, expect, it } from "vitest";
import { sanitizeUntrusted } from "../src/prompt";

describe("sanitizeUntrusted", () => {
  it("removes HTML comments", () => {
    expect(sanitizeUntrusted("hello <!-- do bad things -->world")).toBe("hello world");
  });

  it("removes zero-width characters", () => {
    expect(sanitizeUntrusted("ig\u200Bnore")).toBe("ignore");
  });

  it("removes bidi override characters", () => {
    expect(sanitizeUntrusted("\u202Eevil")).toBe("evil");
  });

  it("removes control characters but keeps newlines and tabs", () => {
    expect(sanitizeUntrusted("a\u0000b\n\tc")).toBe("ab\n\tc");
  });

  it("leaves normal text untouched", () => {
    expect(sanitizeUntrusted("Fix the flaky test on Windows.")).toBe(
      "Fix the flaky test on Windows.",
    );
  });

  it("handles multi-line comments", () => {
    expect(sanitizeUntrusted("a<!--\nignore\nall\n-->b")).toBe("ab");
  });
});
