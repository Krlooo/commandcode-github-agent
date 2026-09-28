import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../src/scrub";

describe("scrubSecrets", () => {
  it("scrubs a token embedded in an x-access-token URL", () => {
    const message =
      "fatal: could not read Password for https://x-access-token:ghs_secret_token@github.com/o/r.git";
    const scrubbed = scrubSecrets(message, []);
    expect(scrubbed).toContain("x-access-token:***@github.com/o/r.git");
    expect(scrubbed).not.toContain("ghs_secret_token");
  });

  it("scrubs an exact secret occurrence", () => {
    const scrubbed = scrubSecrets("push failed for ghs_secret_token while talking to the remote", [
      "ghs_secret_token",
    ]);
    expect(scrubbed).toBe("push failed for *** while talking to the remote");
  });

  it("leaves normal text untouched", () => {
    const text = "git push origin HEAD:refs/heads/commandcode/issue-1-1700000000";
    expect(scrubSecrets(text, [])).toBe(text);
  });

  it("scrubs multiple secrets", () => {
    const scrubbed = scrubSecrets("a=one b=two c=three", ["one", "three"]);
    expect(scrubbed).toBe("a=*** b=two c=***");
  });

  it("ignores empty secrets", () => {
    expect(scrubSecrets("keep me", [""])).toBe("keep me");
  });
});
