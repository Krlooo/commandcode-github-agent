import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadAttachments,
  extractAttachmentUrls,
  isImageContentType,
  MAX_ATTACHMENT_BYTES,
  readAtMost,
} from "../src/attachments";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractAttachmentUrls", () => {
  it("extracts a single user-attachments URL", () => {
    const body =
      "![screenshot](https://github.com/user-attachments/assets/0f9a1b2c-3d4e-5f60-7890-abcdef123456)";
    expect(extractAttachmentUrls(body)).toEqual([
      "https://github.com/user-attachments/assets/0f9a1b2c-3d4e-5f60-7890-abcdef123456",
    ]);
  });

  it("extracts several URLs in order", () => {
    const body = [
      "before",
      "![one](https://github.com/user-attachments/assets/aaaa)",
      "![two](https://github.com/user-attachments/assets/bbbb)",
      "after",
    ].join("\n");
    expect(extractAttachmentUrls(body)).toEqual([
      "https://github.com/user-attachments/assets/aaaa",
      "https://github.com/user-attachments/assets/bbbb",
    ]);
  });

  it("accepts the legacy user-images host", () => {
    const body = "see https://user-images.githubusercontent.com/12345/6789-screenshot.png here";
    expect(extractAttachmentUrls(body)).toEqual([
      "https://user-images.githubusercontent.com/12345/6789-screenshot.png",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const url = "https://github.com/user-attachments/assets/cccc";
    expect(extractAttachmentUrls(`${url} and again ${url}`)).toEqual([url]);
  });

  it("strips trailing punctuation", () => {
    const body =
      "pic: https://github.com/user-attachments/assets/dddd, and another https://github.com/user-attachments/assets/eeee.";
    expect(extractAttachmentUrls(body)).toEqual([
      "https://github.com/user-attachments/assets/dddd",
      "https://github.com/user-attachments/assets/eeee",
    ]);
  });

  it("strips punctuation at the end of a bare URL", () => {
    expect(extractAttachmentUrls("look https://github.com/user-attachments/assets/eeee.")).toEqual([
      "https://github.com/user-attachments/assets/eeee",
    ]);
  });

  it("returns an empty array when there are no attachments", () => {
    expect(extractAttachmentUrls("just a normal comment with no images")).toEqual([]);
  });

  it("returns an empty array for an empty body", () => {
    expect(extractAttachmentUrls("")).toEqual([]);
  });
});

describe("isImageContentType", () => {
  it("accepts image content types, ignoring parameters and case", () => {
    expect(isImageContentType("image/png")).toBe(true);
    expect(isImageContentType("image/jpeg; charset=binary")).toBe(true);
    expect(isImageContentType("IMAGE/GIF")).toBe(true);
  });

  it("rejects non-image and missing content types", () => {
    expect(isImageContentType("text/html")).toBe(false);
    expect(isImageContentType("application/octet-stream")).toBe(false);
    expect(isImageContentType(null)).toBe(false);
  });
});

describe("readAtMost", () => {
  it("returns the body when it fits", async () => {
    const buffer = await readAtMost(new Response("hello"), 16);
    expect(buffer?.toString("utf8")).toBe("hello");
  });

  it("returns null when the declared content-length exceeds the cap", async () => {
    const response = new Response("hello", { headers: { "content-length": "100" } });
    expect(await readAtMost(response, 4)).toBeNull();
  });

  it("returns null when the streamed body exceeds the cap", async () => {
    expect(await readAtMost(new Response("hello world"), 4)).toBeNull();
  });
});

describe("downloadAttachments", () => {
  const url = "https://github.com/user-attachments/assets/abc";

  it("downloads an image within the size cap", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("png-bytes", { headers: { "content-type": "image/png" } }),
    );

    const paths = await downloadAttachments([url], "token");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/image-0\.png$/);
    expect(readFileSync(paths[0] ?? "", "utf8")).toBe("png-bytes");
  });

  it("skips a response that is not an image and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    );

    expect(await downloadAttachments([url], "token")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not an image"));
  });

  it("skips an image over the size cap and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("x", {
          headers: {
            "content-type": "image/png",
            "content-length": String(MAX_ATTACHMENT_BYTES + 1),
          },
        }),
    );

    expect(await downloadAttachments([url], "token")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("byte limit"));
  });

  it("skips a failed download and logs it the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    expect(await downloadAttachments([url], "token")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
  });
});
