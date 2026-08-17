import { describe, expect, it } from "vitest";
import { shouldUseNativeWindowFrame } from "../native-window-frame";

describe("shouldUseNativeWindowFrame", () => {
  it("detects WSL from WSL_DISTRO_NAME", () => {
    expect(
      shouldUseNativeWindowFrame({
        platform: "linux",
        wslDistroName: "Ubuntu",
        osRelease: "6.6.87.2-generic",
      }),
    ).toBe(true);
  });

  it("detects WSL from the kernel release when the environment variable is absent", () => {
    expect(
      shouldUseNativeWindowFrame({
        platform: "linux",
        osRelease: "5.15.167.4-microsoft-standard-WSL2",
      }),
    ).toBe(true);
  });

  it("keeps the custom frame on ordinary Linux", () => {
    expect(
      shouldUseNativeWindowFrame({
        platform: "linux",
        osRelease: "6.8.0-51-generic",
      }),
    ).toBe(false);
  });

  it("does not enable the WSL frame mode on other platforms", () => {
    expect(
      shouldUseNativeWindowFrame({
        platform: "win32",
        wslDistroName: "Ubuntu",
        osRelease: "microsoft-standard-WSL2",
      }),
    ).toBe(false);
  });
});
