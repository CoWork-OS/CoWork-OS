import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { listMissingRuntimeDependencies } = require("../npm_install_mode.cjs");

test("the launcher accepts an installed import-only dependency without entering repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-launcher-deps-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          "only-import": "1.0.0",
          "common-js": "1.0.0",
          missing: "1.0.0",
          "@types/unused": "1.0.0",
        },
      }),
    );
    const esm = path.join(root, "node_modules", "only-import");
    fs.mkdirSync(esm, { recursive: true });
    fs.writeFileSync(
      path.join(esm, "package.json"),
      JSON.stringify({ name: "only-import", type: "module", exports: { import: "./index.mjs" } }),
    );
    fs.writeFileSync(
      path.join(esm, "index.mjs"),
      "throw new Error('The availability probe must not execute packages');\n",
    );
    const cjs = path.join(root, "node_modules", "common-js");
    fs.mkdirSync(cjs);
    fs.writeFileSync(
      path.join(cjs, "package.json"),
      JSON.stringify({ name: "common-js", main: "index.js" }),
    );
    fs.writeFileSync(path.join(cjs, "index.js"), "throw new Error('Do not execute');\n");
    assert.throws(() => require.resolve("only-import", { paths: [root] }), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    assert.deepEqual(listMissingRuntimeDependencies(root), [{ name: "missing", version: "1.0.0" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
