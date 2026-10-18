import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import {
  rendererBundleReport,
  mermaidParserPlugin,
  rendererCodeSplitting,
  rendererVendorAliases,
} from "./scripts/build/renderer-bundle-config.mjs";

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
  server: {
    host: "127.0.0.1",
    port: Number(process.env.COWORK_DEV_SERVER_PORT || 5173),
    strictPort: true,
  },
});
