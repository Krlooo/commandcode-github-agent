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
          Accept: "application/octet-stream",
        },
      });
      if (!response.ok) {
        console.warn(`Could not download attachment ${url}: HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const extension = extensionFor(url, response.headers.get("content-type"));
      const path = join(directory, `image-${index}.${extension}`);
      await writeFile(path, bytes);
      paths.push(path);
    } catch (error) {
      console.warn(`Could not download attachment ${url}:`, error);
    }
  }

  return paths;
}
