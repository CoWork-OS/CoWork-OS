import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Exercise the shipped Python dispatch against the two real guest image layouts.
const probe = String.raw`
import base64, json, pathlib, runpy, subprocess, sys, tempfile
from unittest.mock import patch
worker = runpy.run_path("resources/bot-desktop/cowork-environment.py")
available = sys.argv[1]
calls = []
def capture(argv, **kwargs):
    calls.append([argv[:-1], kwargs])
    if available == "broken":
        raise subprocess.CalledProcessError(1, argv)
    pathlib.Path(argv[-1]).write_bytes(b"synthetic PNG bytes")
with tempfile.TemporaryDirectory() as root:
    with patch("shutil.which", side_effect=lambda name: "/tools/" + name if name == available or (available == "broken" and name == "scrot") else None), patch("subprocess.run", side_effect=capture):
        try:
            result = worker["dispatch"]({"environment": "capture-test", "root": root, "tool": "desktop_screenshot", "input": {}})
        except Exception as error:
            result = {"success": False, "error": str(error)}
print(json.dumps({"result": result, "calls": calls}))
`;

function run(available: string) {
  return JSON.parse(execFileSync("python3", ["-c", probe, available], { encoding: "utf8" }));
}

describe("guest desktop capture", () => {
  it.each([
    ["scrot", ["scrot", "--overwrite"]],
    ["import", ["import", "-window", "root"]],
  ])("captures the desktop with %s and returns the actual image bytes", (tool, argv) => {
    const { result, calls } = run(tool as string);
    expect(result).toEqual({
      success: true,
      imageBase64: Buffer.from("synthetic PNG bytes").toString("base64"),
      mediaType: "image/png",
    });
    expect(calls).toEqual([[argv, { check: true, timeout: 10 }]]);
  });

  it("reports the missing guest prerequisite without attempting a capture", () => {
    const { result, calls } = run("none");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/scrot or ImageMagick import/);
    expect(calls).toEqual([]);
  });

  it("does not report success or return an image after capture fails", () => {
    const { result } = run("broken");
    expect(result.success).toBe(false);
    expect(result.imageBase64).toBeUndefined();
  });
});
