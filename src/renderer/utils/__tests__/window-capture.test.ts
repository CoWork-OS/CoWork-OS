import { describe, expect, it } from "vitest";
import { windowCaptureAttachments, windowCaptureFileStem } from "../window-capture";

const result = {
  ok: true as const,
  appName: "Safari",
  windowTitle: "Q3 / ledger: “draft”",
  url: "https://example.com",
  imageBase64: Buffer.from("png-bytes").toString("base64"),
  imageWidth: 10,
  imageHeight: 10,
  note: "## Window capture\n\n- App: Safari — ünïcode\n",
  capturedAt: 77,
};

describe("windowCaptureFileStem", () => {
  it("names the file after the app and window, without path characters", () => {
    expect(windowCaptureFileStem(result)).toBe("Safari - Q3 ledger “draft”");
    expect(windowCaptureFileStem({ appName: "", windowTitle: "///" })).toBe("Window");
  });
});

describe("windowCaptureAttachments", () => {
  it("attaches the picture and the note, with sizes that match the bytes", () => {
    const [image, note] = windowCaptureAttachments(result);
    expect(image).toMatchObject({
      name: "Safari - Q3 ledger “draft”.png",
      mimeType: "image/png",
      size: Buffer.from("png-bytes").length,
      dataBase64: result.imageBase64,
    });
    expect(note.mimeType).toBe("text/markdown");
    expect(Buffer.from(note.dataBase64!, "base64").toString("utf8")).toBe(result.note);
    expect(note.size).toBe(Buffer.byteLength(result.note, "utf8"));
    expect(image.id).not.toBe(note.id);
  });
});
