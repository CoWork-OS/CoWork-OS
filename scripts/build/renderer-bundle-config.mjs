import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
export { mermaidParserPlugin } from "./mermaid-parser-plugin.mjs";

const root = path.resolve(import.meta.dirname, "../..");

// React is shared by every surface and changes independently of application code.
// Keep one runtime and let it stay cached when optional application chunks change.
export const rendererCodeSplitting = {
  groups: [
    {
      name: "react-runtime",
      test: /[/\\]node_modules[/\\](?:react|react-dom|scheduler)[/\\]/,
      priority: 20,
    },
    // three.js (the in-chat 3D viewer, loaded on demand) is one 660 kB chunk otherwise;
    // its core and its WebGL renderer are separate files upstream, so they split cleanly.
    {
      name: "three-core",
      test: /[/\\]node_modules[/\\]three[/\\]build[/\\]three\.core\.js$/,
      priority: 15,
    },
    {
      name: "three-webgl",
      test: /[/\\]node_modules[/\\]three[/\\]build[/\\]three\.module\.js$/,
      priority: 15,
    },
  ],
};

export const rendererVendorAliases = [
  {
    find: /^elkjs\/lib\/elk\.bundled\.js$/,
    replacement: path.join(root, "src/renderer/lib/elk-worker-adapter.ts"),
  },
];

// The dev dependency optimizer applies aliases too, so pre-bundling Mermaid
// would inline the adapter, whose `?url` worker import only Vite's own asset
// pipeline can load. Leave the aliased import external to the pre-bundle; the
// dev server then resolves it to the adapter like any other source module.
// The import scan cannot see the adapter's CommonJS ELK client behind the
// alias; include it up front so the first ELK diagram does not reload the page.
export const rendererOptimizeDeps = {
  exclude: ["elkjs/lib/elk.bundled.js"],
  include: ["elkjs/lib/elk-api.js"],
};

/** Record actual emitted chunks, separately from assets such as worker engines. */
export function rendererBundleReport(target) {
  let emitted;
  return {
    name: "cowork-renderer-bundle-report",
    writeBundle(_options, bundle) {
      emitted = { directory: path.resolve(_options.dir), bundle };
    },
    closeBundle() {
      if (!emitted) return;
      const { directory: outputDirectory, bundle } = emitted;
      const scriptFiles = [];
      const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) scriptFiles.push(file);
        }
      };
      walk(outputDirectory);
      const chunks = [];
      const javascriptAssets = [];
      const publicScripts = [];
      for (const file of scriptFiles.sort()) {
        const fileName = path.relative(outputDirectory, file).split(path.sep).join("/");
        const source = readFileSync(file);
        const fingerprint = {
          fileName,
          bytes: source.byteLength,
          gzipBytes: gzipSync(source).byteLength,
          sha256: createHash("sha256").update(source).digest("hex"),
        };
        const item = bundle[fileName];
        if (item?.type === "chunk") {
          chunks.push({
            ...fingerprint,
            isEntry: item.isEntry,
            isDynamicEntry: item.isDynamicEntry,
            imports: item.imports,
            dynamicImports: item.dynamicImports,
            modules: Object.entries(item.modules).map(([id, details]) => ({
              id: path.relative(root, id).split(path.sep).join("/"),
              renderedLength: details.renderedLength,
            })),
          });
        } else if (item?.type === "asset") javascriptAssets.push(fingerprint);
        else publicScripts.push(fingerprint);
      }
      const directory = path.join(root, "tmp/qa");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `bundle-build-${target}.json`),
        JSON.stringify(
          { target, outputDirectory, chunks, javascriptAssets, publicScripts },
          null,
          2,
        ) + "\n",
      );
    },
  };
}
