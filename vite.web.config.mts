import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

// Keep this build artifact version explicit; the host refuses assets whose
// version differs from its runtime WEB_API_VERSION.
const WEB_ARTIFACT_API_VERSION = 1;

const packageManifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/** Browser assets are independent of the Electron renderer build. */
export default defineConfig({
  plugins: [
    react(),
    {
      name: "cowork-web-artifact-manifest",
      generateBundle(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "web-manifest.json",
          source: JSON.stringify({
            apiVersion: WEB_ARTIFACT_API_VERSION,
            appVersion: packageManifest.version,
            assets: Object.keys(bundle).sort(),
          }),
        });
      },
    },
  ],
  root: path.resolve(import.meta.dirname, "src/renderer-web"),
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "src/renderer/public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.COWORK_WEB_DEV_SERVER_PORT || 5174),
    strictPort: true,
  },
});
