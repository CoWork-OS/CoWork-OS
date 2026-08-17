import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";

function inspectPackageExports(): { pi: string[]; oauth: string[] } {
  const script = `
    const [pi, oauth] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/oauth"),
    ]);
    console.log(JSON.stringify({
      pi: ["complete", "getModels", "getProviders"].filter((key) => typeof pi[key] === "function"),
      oauth: ["getOAuthApiKey", "loginOpenAICodex", "refreshOpenAICodexToken"].filter(
        (key) => typeof oauth[key] === "function",
      ),
    }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf-8",
    }),
  );
}

describe("pi-ai package migration", () => {
  it("loads the supported model API from the maintained package namespace", () => {
    const module = inspectPackageExports();

    expect(module.pi).toEqual(["complete", "getModels", "getProviders"]);
  });

  it("preserves the OpenAI Codex OAuth API", () => {
    const module = inspectPackageExports();

    expect(module.oauth).toEqual([
      "getOAuthApiKey",
      "loginOpenAICodex",
      "refreshOpenAICodexToken",
    ]);
  });
});
