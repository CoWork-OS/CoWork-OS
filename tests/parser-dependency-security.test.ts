import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A vulnerable parser can block its event loop indefinitely. Keep the deadline
// outside that process so a regression cannot hang a Vitest worker or exhaust
// the test runner's heap. These run the installed parsers, without mocks.
function runBoundedParser(source: string, maxHeapMb = 256): void {
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${maxHeapMb}`,
      "-e",
      `const assert = require("node:assert/strict");
${source}
process.stdout.write("ok");`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: process.env.CI ? 20_000 : 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    },
  );

  expect(
    { status: result.status, signal: result.signal, error: result.error?.message },
    result.stderr,
  ).toEqual({ status: 0, signal: null, error: undefined });
  expect(result.stdout).toBe("ok");
}

describe("installed YAML parser resource guards", () => {
  it("bounds repeated alias merges while preserving ordinary merge precedence", () => {
    runBoundedParser(`
const { load: loadCore, YAML11_SCHEMA } = require("js-yaml");
// Merge keys are YAML 1.1; the YAML 1.2 default schema leaves them unexpanded.
assert.deepEqual(loadCore("defaults: &defaults {size: small}\\nitem: {<<: *defaults}").item, {
  "<<": { size: "small" },
});
const load = (text, options = {}) => loadCore(text, { schema: YAML11_SCHEMA, ...options });
const ordinary = load("defaults: &defaults {color: blue, size: small}\\nitem: {<<: *defaults, size: large}");
assert.deepEqual(ordinary.item, { color: "blue", size: "large" });

const aliases = "defaults: &defaults {color: blue}\\nitems:\\n" +
  "  - {<<: *defaults}\\n".repeat(10_001);
assert.throws(() => load(aliases), /maxTotalMergeKeys/);
assert.throws(() => load(aliases, { maxTotalMergeKeys: 64 }), /maxTotalMergeKeys/);
`);
  });

  it("counts empty merge sources against the same budget", () => {
    runBoundedParser(`
const { load: loadCore, YAML11_SCHEMA } = require("js-yaml");
const load = (text, options = {}) => loadCore(text, { schema: YAML11_SCHEMA, ...options });
assert.deepEqual(load("empty: &empty {}\\nitem: {<<: *empty, value: kept}").item, { value: "kept" });

// Empty mappings previously consumed no budget, bypassing the merge-key cap.
// Each sequence stays below the separate 100-source sequence guard. The
// accumulated empty-source work must still consume the document-wide budget.
const emptySources = "empty: &empty {}\\nsources: &sources [" +
  Array(32).fill("*empty").join(", ") + "]\\nitems:\\n" +
  "  - {<<: *sources}\\n".repeat(400);
assert.throws(() => load(emptySources), /maxTotalMergeKeys/);
assert.throws(() => load(emptySources, { maxTotalMergeKeys: 64 }), /maxTotalMergeKeys/);
`);
  });

  it("finishes a large unique-key ordered map and still rejects duplicate keys", () => {
    runBoundedParser(
      `
const { load: loadCore, YAML11_SCHEMA } = require("js-yaml");
// !!omap is a YAML 1.1 type; the YAML 1.2 default schema rejects it.
assert.throws(() => loadCore("!!omap\\n- first: 1"), /unknown sequence tag/);
const load = (text) => loadCore(text, { schema: YAML11_SCHEMA });
assert.deepEqual(load("!!omap\\n- first: 1\\n- second: 2"), [{ first: 1 }, { second: 2 }]);
assert.throws(() => load("!!omap\\n- repeated: 1\\n- repeated: 2"), /duplicate key in ordered map/);

// Long common prefixes amplify the old per-entry linear uniqueness scan.
// The fixed parser accepts the same data with bounded CPU and heap use.
const count = 300_000;
const prefix = "ordered_map_" + "x".repeat(48);
const document = "!!omap\\n" + Array.from({ length: count }, (_, index) =>
  "- " + prefix + String(index).padStart(7, "0") + ": " + index
).join("\\n");
const ordered = load(document);
assert.equal(ordered.length, count);
assert.equal(ordered[0][prefix + "0000000"], 0);
assert.equal(ordered[count - 1][prefix + String(count - 1).padStart(7, "0")], count - 1);
`,
      512,
    );
  }, 30_000);
});

// Resolve through PptxGenJS so this exercises its scoped dependency override.
// PptxGenJS does not currently call image-size; these are dependency-level
// regressions, not a claim that malformed images reach it through the product.
const imageParser = `
const { createRequire } = require("node:module");
const fromPptx = createRequire(require.resolve("pptxgenjs"));
const moduleApi = fromPptx("image-size");
const imageSize = typeof moduleApi === "function" ? moduleApi : moduleApi.imageSize;
function box(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + data.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  return result;
}
`;

describe("installed presentation image parser progress guards", () => {
  it("rejects zero-length ICNS entries while preserving normal icon dimensions", () => {
    runBoundedParser(`${imageParser}
const icon = Buffer.alloc(8);
icon.write("icp4", 0, "ascii");
icon.writeUInt32BE(icon.length, 4);
const ordinary = Buffer.concat([Buffer.from("icns"), Buffer.alloc(4), icon]);
ordinary.writeUInt32BE(ordinary.length, 4);
assert.equal(imageSize(ordinary).width, 16);
assert.equal(imageSize(ordinary).height, 16);

const malformed = Buffer.from(ordinary);
malformed.writeUInt32BE(0, 12);
assert.throws(() => imageSize(malformed), /Invalid ICNS/);
`);
  });

  it("rejects a zero-length JXL box before searching for a codestream", () => {
    runBoundedParser(`${imageParser}
const signature = box("JXL ", Buffer.from([13, 10, 135, 10]));
const fileType = box("ftyp", Buffer.from("jxl "));
const stalled = box("jxlp");
stalled.writeUInt32BE(0, 0);
const malformed = Buffer.concat([signature, fileType, stalled]);
assert.throws(() => imageSize(malformed), /Invalid/);

// A normal image still passes the same public API after rejecting malformed boxes.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=", "base64");
assert.equal(imageSize(png).width, 1);
assert.equal(imageSize(png).height, 1);
`);
  });

  it("rejects a zero-length HEIF box while preserving normal image dimensions", () => {
    runBoundedParser(`${imageParser}
const dimensions = Buffer.alloc(12);
dimensions.writeUInt32BE(128, 4);
dimensions.writeUInt32BE(64, 8);
const properties = box("iprp", box("ipco", box("ispe", dimensions)));
const metadata = box("meta", Buffer.concat([Buffer.alloc(4), properties]));
const fileType = box("ftyp", Buffer.from("heic"));
const ordinary = Buffer.concat([fileType, metadata]);
assert.equal(imageSize(ordinary).width, 128);
assert.equal(imageSize(ordinary).height, 64);

const stalled = box("skip");
stalled.writeUInt32BE(0, 0);
assert.throws(() => imageSize(Buffer.concat([fileType, stalled])), /Invalid/);
`);
  });
});
