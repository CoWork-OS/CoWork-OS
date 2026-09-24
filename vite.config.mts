import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  publicDir: path.resolve(import.meta.dirname, "src/renderer/public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@shared": path.resolve(import.meta.dirname, "./src/shared"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.COWORK_DEV_SERVER_PORT || 5173),
    strictPort: true,
  },
});
