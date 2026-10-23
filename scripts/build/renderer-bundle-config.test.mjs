import assert from "node:assert/strict";
import { test } from "node:test";
import { rendererOptimizeDeps, rendererVendorAliases } from "./renderer-bundle-config.mjs";

test("dependency pre-bundling leaves every vendor alias to the source pipeline", () => {
  // An alias reached from a pre-bundled dependency is inlined by the dev
  // optimizer, which cannot load Vite-only imports such as `?url` in its target.
  for (const alias of rendererVendorAliases) {
    assert.ok(
      rendererOptimizeDeps.exclude.some((specifier) => alias.find.test(specifier)),
      `${alias.find} must be excluded from optimizeDeps`,
    );
  }
});

test("the ELK client behind the alias is pre-bundled up front", () => {
  assert.ok(rendererOptimizeDeps.include.includes("elkjs/lib/elk-api.js"));
});
