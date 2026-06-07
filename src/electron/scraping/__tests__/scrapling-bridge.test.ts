import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bridgePath = path.resolve(__dirname, "../scrapling-bridge.py");

function runBridgeHelperSnippet(snippet: string): string {
  return execFileSync(
    "python3",
    [
      "-c",
      `
import importlib.util
import pathlib

bridge_path = pathlib.Path(${JSON.stringify(bridgePath)})
spec = importlib.util.spec_from_file_location("scrapling_bridge", bridge_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

${snippet}
`,
    ],
    { encoding: "utf8" },
  ).trim();
}

describe("scrapling bridge redirect policy", () => {
  it("allows same-host final URLs", () => {
    const output = runBridgeHelperSnippet(`
class Response:
    url = "https://example.com/final"

print(module.enforce_same_host_final_url("https://example.com/start", Response()))
`);

    expect(output).toBe("https://example.com/final");
  });

  it("rejects final URLs that cross hosts", () => {
    const output = runBridgeHelperSnippet(`
class Response:
    url = "https://evil.example/final"

try:
    module.enforce_same_host_final_url("https://example.com/start", Response())
except ValueError as error:
    print(str(error))
`);

    expect(output).toBe("Scraping redirect crossed to a different host");
  });
});
