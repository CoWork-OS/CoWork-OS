import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "path";
import {
  rendererBundleReport,
  mermaidParserPlugin,
  rendererCodeSplitting,
  rendererOptimizeDeps,
  rendererVendorAliases,
} from "./scripts/build/renderer-bundle-config.mjs";

const require = createRequire(import.meta.url);
const fontPackageRoot = path.dirname(require.resolve("@fontsource/montserrat/package.json"));
const pdfPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

export default defineConfig({
  plugins: [react(), mermaidParserPlugin(), rendererBundleReport("renderer")],
  root: path.resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "src/renderer/public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rolldownOptions: { output: { codeSplitting: rendererCodeSplitting } },
  },
  resolve: {
    alias: [
      ...rendererVendorAliases,
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      { find: "@shared", replacement: path.resolve(import.meta.dirname, "./src/shared") },
    ],
  },
  optimizeDeps: rendererOptimizeDeps,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.COWORK_DEV_SERVER_PORT || 5173),
    strictPort: true,
    fs: {
      // Worktrees can share node_modules. Font and PDF worker URLs resolve to
      // real package paths that may sit outside this checkout's workspace.
      allow: [searchForWorkspaceRoot(import.meta.dirname), fontPackageRoot, pdfPackageRoot],
    },
  },
});
