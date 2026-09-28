import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent";

/**
 * Live smoke test: runs the real `cmdc` binary headless against the local CLI
 * auth. Opt-in via SMOKE=1 (it consumes real model tokens), skipped otherwise.
 *
 *   npm test -- test/agent.integration.test.ts
 *   with SMOKE=1 set
 */
const enabled = process.env["SMOKE"] === "1";

describe.runIf(enabled)("runAgent (live smoke)", () => {
  it(
    "runs the real CLI headless and returns a parsed success result",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "cmdc-smoke-"));
      const outcome = await runAgent({
        prompt: "Respond with the single line SMOKE_OK and nothing else.",
        workspace,
        maxTurns: 2,
        env: {},
      });

      console.log("exitCode:", outcome.exitCode);
      console.log("subtype:", outcome.result.subtype);
      console.log("finalText:", JSON.stringify(outcome.result.finalText));
      console.log("sessionId:", outcome.result.sessionId);

      expect(outcome.result.subtype).toBe("success");
      expect(outcome.result.finalText).toContain("SMOKE_OK");
      expect(outcome.exitCode).toBe(0);
    },
    300000,
  );
});
