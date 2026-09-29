/**
 * Network helpers: a per-request timeout and a bounded retry policy for
 * transient failures. Zero dependencies: Node's global `fetch` and
 * `AbortSignal.timeout` only.
 *
 * Retrying is deliberately conservative. A 5xx, a 429 or a secondary rate
 * limit is worth another attempt; a 4xx that is the caller's fault (401, 403,
 * 404, 422 ...) is not, because retrying it only burns the job budget without
 * any chance of succeeding.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Default per-request timeout (ms). A stalled connection fails fast instead of hanging. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Maximum attempts (the first try included) for a retryable request. */
export const MAX_ATTEMPTS = 3;
/** Base delay for the exponential backoff between attempts (ms). */
export const RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound for a server-provided Retry-After wait (ms), so one hint cannot eat the budget. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Minimal header accessor, satisfied by the global `Headers` and easy to fake in tests. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface RetryEvent {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** How long the caller waits before the next attempt. */
  delayMs: number;
  /** Response status when the attempt failed with a retryable response. */
  status?: number;
  /** The thrown error when the attempt failed before a response arrived. */
  error?: unknown;
}

export interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxRetryAfterMs?: number;
  /** Overridable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests. Defaults to `node:timers/promises`. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (event: RetryEvent) => void;
}

/** True for statuses that are transient: 429 and the whole 5xx range. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * True when a 403 looks like a rate limit rather than a permission problem.
 * GitHub signals a secondary rate limit with a Retry-After header and the
 * primary rate limit by exhausting the remaining quota.
 */
export function isRateLimited(status: number, headers: HeaderReader): boolean {
  if (status !== 403) return false;
  return headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0";
}

/** The retry decision for a completed response. */
export function shouldRetry(status: number, headers?: HeaderReader): boolean {
  if (isRetryableStatus(status)) return true;
  return headers !== undefined && isRateLimited(status, headers);
}

/** Exponential backoff for a 1-based attempt number. */
export function retryDelayMs(attempt: number, baseDelayMs = RETRY_BASE_DELAY_MS): number {
  return baseDelayMs * 2 ** (Math.max(1, attempt) - 1);
}

/**
 * Parses a `Retry-After` header value (delay in seconds, or an HTTP date) into
 * milliseconds, capped at `maxMs`. Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  maxMs = MAX_RETRY_AFTER_MS,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs);

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    if (delta > 0) return Math.min(delta, maxMs);
  }
  return undefined;
}

/**
 * `fetch` with a per-request timeout. A stalled connection aborts and rejects
 * with the timeout error instead of hanging for the lifetime of the job.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * `fetch` with a timeout and a bounded retry loop. Retryable responses and
 * network errors (including timeouts) are retried up to `attempts` times with
 * exponential backoff; a `Retry-After` hint overrides the computed delay. The
 * last response is returned even when it is still retryable, so the caller
 * reports it like any other failure; when every attempt threw, the last error
 * is rethrown.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? MAX_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, timeoutMs, fetchImpl);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const waitMs = retryDelayMs(attempt, baseDelayMs);
      options.onRetry?.({ attempt, delayMs: waitMs, error });
      await sleep(waitMs);
      continue;
    }

    if (attempt < attempts && shouldRetry(response.status, response.headers)) {
      const waitMs =
        parseRetryAfterMs(response.headers.get("retry-after"), maxRetryAfterMs) ??
        retryDelayMs(attempt, baseDelayMs);
      options.onRetry?.({ attempt, delayMs: waitMs, status: response.status });
      await sleep(waitMs);
      continue;
    }

    return response;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "request failed"));
}
