import { describe, expect, it } from "vitest";
import { extractAttachmentUrls } from "../src/attachments";

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
