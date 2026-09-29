/**
 * Attached images pasted into a trigger comment.
 *
 * GitHub stores pasted images under `user-attachments` (or the legacy
 * `user-images` host) and renders them as URLs in the comment body. This module
 * finds those URLs in the raw comment and downloads them so the agent can open
 * them with its file tools.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fetchWithTimeout } from "./net";

/** Pasted-image hosts: the current `user-attachments` and the legacy `user-images`. */
const ATTACHMENT_PATTERN =
  /https:\/\/(?:github\.com\/user-attachments\/assets\/|user-images\.githubusercontent\.com\/)[^\s<>"'()]+/g;

/** Punctuation a URL can pick up from the surrounding prose or markdown. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Maximum size downloaded for a single attachment; a larger response is skipped. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** True when a response content type is an image; parameters (`; charset=`) are ignored. */
export function isImageContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return contentType.split(";")[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

/**
 * Reads a response body up to `maxBytes`, returning `null` when it is larger.
 * The declared `content-length` is checked first, then the stream is read in
 * chunks and cancelled as soon as the cap is exceeded, so an oversized or
 * endless body is never buffered in full.
 */
export async function readAtMost(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }

  const body = response.body;
  if (body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Extracts the (deduplicated) attachment image URLs from a comment body, in
 * first-seen order. Trailing sentence punctuation is stripped.
 */
export function extractAttachmentUrls(body: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Best-effort file extension for a downloaded image. */
function extensionFor(url: string, contentType: string | null): string {
  try {
    const fromUrl = extname(new URL(url).pathname).replace(/^\./, "").toLowerCase();
    if (/^[a-z0-9]+$/.test(fromUrl)) return fromUrl;
  } catch {
    // not a parseable URL; fall through to the content type
  }

  const fromType = contentType?.split(";")[0]?.trim().split("/")[1]?.toLowerCase();
  if (fromType && /^[a-z0-9]+$/.test(fromType)) return fromType === "jpeg" ? "jpg" : fromType;
  return "png";
}

/**
 * Downloads the given attachment URLs into a fresh directory under
 * `os.tmpdir()/commandcode-attachments/`, returning the local file paths.
 *
 * Individual downloads are best-effort: a failure is logged and skipped so a
 * broken image never fails the run.
 */
export async function downloadAttachments(urls: string[], token: string): Promise<string[]> {
  if (urls.length === 0) return [];

  const root = join(tmpdir(), "commandcode-attachments");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "run-"));

  const paths: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (url === undefined) continue;
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "image/*",
        },
      });
      if (!response.ok) {
        console.warn(`Could not download attachment ${url}: HTTP ${response.status}`);
        continue;
      }
      const contentType = response.headers.get("content-type");
      if (!isImageContentType(contentType)) {
        await response.body?.cancel();
        console.warn(
          `Skipping attachment ${url}: content type ${contentType ?? "(none)"} is not an image`,
        );
        continue;
      }
      const bytes = await readAtMost(response, MAX_ATTACHMENT_BYTES);
      if (bytes === null) {
        console.warn(
          `Skipping attachment ${url}: larger than the ${MAX_ATTACHMENT_BYTES} byte limit`,
        );
        continue;
      }
      const extension = extensionFor(url, contentType);
      const path = join(directory, `image-${index}.${extension}`);
      await writeFile(path, bytes);
      paths.push(path);
    } catch (error) {
      console.warn(`Could not download attachment ${url}:`, error);
    }
  }

  return paths;
}
