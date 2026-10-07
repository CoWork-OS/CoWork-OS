/** Run with `node scripts/qa/smoke-build-view-state.mjs` (installed Playwright Chromium required). */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { BuildPanel } from "./src/renderer/components/calm/BuildPanel";
      import { WebArtifactViewer } from "./src/renderer/components/WebArtifactViewer";
      window.admitBuild = false;
      window.viewerReads = 0;
      window.electronAPI = {
        listWorkspaces: async () => [],
        selectFiles: async () => [{ path: "/tmp/source.csv", name: "source.csv", size: 3 }],
        readFileForViewer: async () => {
          window.viewerReads += 1;
          return { success: true, data: {
            fileType: "html", fileName: "index.html", path: "/tmp/index.html",
            htmlContent: "<main>ready</main>",
            webPreviewUrl: "https://preview.invalid/" + window.viewerReads,
          }};
        },
      };
      function Harness() {
        const [showBuild, setShowBuild] = useState(true);
        const [showViewer, setShowViewer] = useState(false);
        return <>
          <button onClick={() => setShowBuild(x => !x)}>Toggle Build</button>
          <button onClick={() => setShowViewer(x => !x)}>Toggle Viewer</button>
          {showViewer && <WebArtifactViewer filePath="/tmp/index.html" workspacePath="/tmp"
            mode="sidebar" refreshKey="completed" onClose={() => {}}
            onFullscreen={() => {}} onExitFullscreen={() => {}} />}
          {showBuild && <BuildPanel workspace={{ id: "w", name: "w", path: "/tmp" }}
            onStart={async () => {
              await Promise.resolve();
              if (!window.admitBuild) return false;
              setShowBuild(false);
              return true;
            }} onSelectWorkspace={() => {}} onPickFolder={() => {}}
            model={{ models: [], selectedProvider: "openai", selectedModel: "m",
              onModelChange: () => {} }} />}
        </>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "unrelated-controls",
      setup(builder) {
        builder.onResolve(
          { filter: /MainContent(?:\/ModelDropdown)?$|\.\/CalmTopBar$|useVoiceInput$/ },
          (args) => ({ path: args.path, namespace: "unrelated-controls" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "unrelated-controls" }, () => ({
          loader: "js",
          contents: `export function ModelDropdown(){return null}
          export function CalmFolderMenu(){return null}
          export function useVoiceInput(){return {state:"idle",toggleRecording:()=>{}}}`,
        }));
      },
    },
  ],
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://preview.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<main>ready</main>",
    }),
  );
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const prompt = page.getByRole("textbox", { name: "Describe what to build" });
  await prompt.fill("Build my tracker");
  await page.getByRole("button", { name: "Add files" }).click();
  await page.getByRole("button", { name: "Toggle Build" }).click();
  await page.getByRole("button", { name: "Toggle Build" }).click();
  assert.equal(await prompt.inputValue(), "Build my tracker");
  assert.equal(await page.getByText("source.csv", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Start building" }).click();
  await page.waitForFunction(() => !document.querySelector(".calm-send-button").disabled);
  assert.equal(await prompt.inputValue(), "Build my tracker");
  await page.evaluate(() => {
    window.admitBuild = true;
  });
  await page.getByRole("button", { name: "Start building" }).click();
  await prompt.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Toggle Build" }).click();
  assert.equal(await prompt.inputValue(), "");
  assert.equal(await page.getByText("source.csv", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Toggle Viewer" }).click();
  await page.waitForFunction(() => window.viewerReads === 1);
  await page.locator("iframe").waitFor();
  await page.getByRole("button", { name: "Toggle Viewer" }).click();
  await page.locator("iframe").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Toggle Viewer" }).click();
  await page.waitForFunction(() => window.viewerReads === 2);
  await page.waitForFunction(() => document.querySelector("iframe")?.src.endsWith("/2"));
  assert.deepEqual(errors, []);
  console.log(
    "Build draft preservation, rejection, successful clearing, and preview URL renewal passed.",
  );
} finally {
  await browser.close();
}
