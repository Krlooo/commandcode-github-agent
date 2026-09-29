import { describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfterMs,
  retryDelayMs,
  shouldRetry,
} from "../src/net";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("isRetryableStatus", () => {
  it("retries 429 and every 5xx", () => {
    for (const status of [429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("does not retry 4xx that are the caller's fault", () => {
    for (const status of [400, 401, 403, 404, 405, 409, 422, 451]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("does not retry success or redirect responses", () => {
    for (const status of [200, 201, 204, 301, 304]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("shouldRetry", () => {
  it("retries a 403 secondary rate limit signalled by Retry-After", () => {
    expect(shouldRetry(403, headers({ "retry-after": "2" }))).toBe(true);
  });

  it("retries a 403 primary rate limit when the quota is exhausted", () => {
    expect(shouldRetry(403, headers({ "x-ratelimit-remaining": "0" }))).toBe(true);
  });

  it("does not retry a plain 403 permission failure", () => {
    expect(shouldRetry(403, headers({ "x-ratelimit-remaining": "57" }))).toBe(false);
  });

  it("retries retryable statuses even without headers", () => {
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(429)).toBe(true);
  });

  it("does not retry 404 or 422 even when rate-limit headers are present", () => {
    expect(shouldRetry(404, headers({ "retry-after": "1" }))).toBe(false);
    expect(shouldRetry(422, headers({ "x-ratelimit-remaining": "0" }))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("doubles the delay on each attempt", () => {
    expect(retryDelayMs(1, 1000)).toBe(1000);
    expect(retryDelayMs(2, 1000)).toBe(2000);
    expect(retryDelayMs(3, 1000)).toBe(4000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses a delay in seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
  });

  it("caps a large delay at the configured maximum", () => {
    expect(parseRetryAfterMs("3600", 60_000)).toBe(60_000);
  });

  it("parses an HTTP date into a positive delay", () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it("returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("fetchWithRetry", () => {
  const noSleep = async (): Promise<void> => {};

  function sequenceFetch(statuses: number[]): { fetchImpl: typeof fetch; calls: () => number } {
    let index = 0;
    const impl = async (): Promise<Response> => {
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
      index += 1;
      return new Response(null, { status });
    };
    return { fetchImpl: impl as unknown as typeof fetch, calls: () => index };
  }

  it("retries a retryable status and returns the first success", async () => {
    const { fetchImpl, calls } = sequenceFetch([503, 200]);
    const onRetry = vi.fn();
    const response = await fetchWithRetry(
      "https://example.test/x",
      {},
      { fetchImpl, sleep: noSleep, onRetry },
    );
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("stops after the bounded number of attempts and returns the failing response", async () => {
    const { fetchImpl, calls } = sequenceFetch([500, 500, 500, 200]);
    const response = await fetchWithRetry(
      "https://example.test/x",
      {},
      { fetchImpl, sleep: noSleep, attempts: 3 },
    );
    expect(response.status).toBe(500);
    expect(calls()).toBe(3);
  });

  it("does not retry a status that is the caller's fault", async () => {
    const { fetchImpl, calls } = sequenceFetch([404, 200]);
    const response = await fetchWithRetry("https://example.test/x", {}, { fetchImpl, sleep: noSleep });
    expect(response.status).toBe(404);
    expect(calls()).toBe(1);
  });

  it("retries a thrown network error and rethrows when every attempt fails", async () => {
    let calls = 0;
    const impl = async (): Promise<Response> => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    await expect(
      fetchWithRetry(
        "https://example.test/x",
        {},
        { fetchImpl: impl as unknown as typeof fetch, sleep: noSleep, attempts: 2 },
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(2);
  });

  it("gives each attempt an abort signal so a stalled request fails fast", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return new Response(null, { status: 200 });
    };
    await fetchWithRetry(
      "https://example.test/x",
      {},
      { fetchImpl: impl as unknown as typeof fetch, sleep: noSleep },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
