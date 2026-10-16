import { describe, expect, it } from "vitest";
import { formatFileSize } from "../useBotDesktopFiles";

describe("formatFileSize", () => {
  it("reads like a file manager", () => {
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(840 * 1024)).toBe("840 KB");
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1.3 MB");
  });
});
