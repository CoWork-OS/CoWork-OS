import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { URI, type LangiumSharedCoreServices } from "langium";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadMermaidParserSources,
  partitionMermaidParserSources,
  mermaidParserPlugin,
  markTypeOnlyReexports,
  verifyMermaidParserSourceShape,
  verifyMermaidParserSources,
} from "../scripts/build/mermaid-parser-plugin.mjs";

const root = path.resolve(import.meta.dirname, "..");
const cases = JSON.parse(
  readFileSync(path.join(root, "scripts/build/mermaid-parser/parity-cases.json"), "utf8"),
) as {
  language: string;
  factory: string;
  service: string;
  astType: string;
  valid: string;
  invalid: string;
  malformed: string;
}[];
const entries = {
  parserEntry: fileURLToPath(import.meta.resolve("@mermaid-js/parser")),
  mermaidEntry: fileURLToPath(import.meta.resolve("mermaid")),
  langiumEntry: fileURLToPath(import.meta.resolve("langium")),
};
type Payload = Record<string, unknown>;
type ParseResult = { value: Payload; lexerErrors: Payload[]; parserErrors: Payload[] };
type LanguageServices = {
  parser: { LangiumParser: { parse(text: string): ParseResult } };
  Grammar: Payload;
  LanguageMetaData: Payload;
};
type API = Record<string, unknown> & { parse(language: string, text: string): Promise<Payload> };
let temporary: string;
let entryDirectory: string;
let original: API;
let modular: API;
let sources: Map<string, string>;
let originalSizes: number[];
let modularSizes: number[];

function isObject(value: unknown): value is Payload {
  return value !== null && typeof value === "object";
}

// Compare AST data, parent identity, reference text/resolution/errors and CST
// token spans. Only implementation-specific closures and lazy private fields are
// omitted; AST references are checked explicitly instead of being JSON-erased.
function snapshotAst(root: object) {
  const paths = new Map<object, string>();
  function locate(value: unknown, location: string) {
    if (!isObject(value) || paths.has(value) || "$refText" in value) return;
    paths.set(value, location);
    for (const [key, child] of Object.entries(value)) {
      if (!key.startsWith("$")) locate(child, `${location}.${key}`);
    }
  }
  locate(root, "$");
  function cst(value: unknown): unknown {
    if (!isObject(value)) return null;
    const token = isObject(value.tokenType) ? value.tokenType.name : undefined;
    return {
      offset: value.offset,
      length: value.length,
      hidden: value.hidden,
      text: value.text,
      token,
      children: Array.isArray(value.content) ? value.content.map(cst) : undefined,
    };
  }
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!isObject(value)) return value;
    if ("$refText" in value) {
      let target: unknown;
      let error: unknown;
      try {
        const reference = value.ref;
        target = isObject(reference) ? paths.get(reference) : reference;
        const failure = value.error;
        error = isObject(failure) ? failure.message : failure;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      return { $refText: value.$refText, target, error };
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$document")
        .map(([key, child]) => [
          key,
          key === "$container"
            ? paths.get(child as object)
            : key === "$cstNode"
              ? cst(child)
              : visit(child),
        ]),
    );
  }
  return visit(root);
}

function snapshotErrors(errors: Payload[]) {
  function token(value: unknown): unknown {
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "tokenType" && isObject(child)
          ? child.name
          : key === "tokenTypeIdx"
            ? undefined
            : child,
      ]),
    );
  }
  return errors.map((error) =>
    Object.fromEntries(
      Object.entries(error)
        .filter(([key]) => key !== "stack")
        .map(([key, value]) => [
          key,
          key === "token" || key === "previousToken"
            ? token(value)
            : key === "resyncedTokens" && Array.isArray(value)
              ? value.map(token)
              : value,
        ]),
    ),
  );
}

function services(api: API, factory: string, service: string) {
  expect(typeof api[factory]).toBe("function");
  const created = (api[factory] as () => Record<string, LanguageServices>)();
  return created[service];
}

beforeAll(async () => {
  temporary = mkdtempSync(path.join(os.tmpdir(), "cowork-mermaid-parser-"));
  sources = loadMermaidParserSources(entries).sources;
  const originalResult = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(entries.parserEntry)};`,
      resolveDir: root,
      sourcefile: "entry.ts",
    },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    outdir: path.join(temporary, "original"),
    outExtension: { ".js": ".mjs" },
    metafile: true,
    logLevel: "silent",
  });
  original = (await import(pathToFileURL(path.join(temporary, "original/stdin.mjs")).href)) as API;
  originalSizes = Object.values(originalResult.metafile!.outputs).map((output) => output.bytes);
  const entriesRoot = path.join(root, "tmp/qa");
  mkdirSync(entriesRoot, { recursive: true });
  entryDirectory = mkdtempSync(path.join(entriesRoot, "parser-parity-"));
  const entry = path.join(entryDirectory, "entry.mjs");
  writeFileSync(entry, 'export * from "@mermaid-js/parser";');
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [mermaidParserPlugin()],
    build: {
      outDir: path.join(temporary, "modular"),
      emptyOutDir: true,
      target: "es2022",
      minify: true,
      // Node consumes the emitted ESM directly; browser preload links are
      // separately exercised by the production renderer acceptance run.
      modulePreload: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        output: { format: "es", entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" },
      },
    },
  });
  expect(Array.isArray(result)).toBe(false);
  if (Array.isArray(result) || !("output" in result)) throw new Error("Unexpected Vite output");
  modularSizes = result.output
    .filter((item) => item.type === "chunk")
    .map((item) => Buffer.byteLength(item.code));
  modular = (await import(pathToFileURL(path.join(temporary, "modular/entry.mjs")).href)) as API;
});
afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (entryDirectory) rmSync(entryDirectory, { recursive: true, force: true });
});

it("preserves the complete published runtime API and reduces real emitted code chunks", () => {
  expect(Object.keys(modular).sort()).toEqual(Object.keys(original).sort());
  for (const key of Object.keys(original))
    expect(typeof modular[key], key).toBe(typeof original[key]);
  expect(Math.max(...originalSizes)).toBeGreaterThan(600_000);
  expect(Math.max(...modularSizes)).toBeLessThan(500_000);
  expect(Math.max(...modularSizes)).toBeLessThan(Math.max(...originalSizes) * 0.75);
  expect(modularSizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(
    originalSizes.reduce((sum, size) => sum + size, 0),
  );
  expect(cases).toHaveLength(15);
  expect(new Set(cases.map((entry) => entry.language)).size).toBe(15);
});

for (const fixture of cases) {
  describe(fixture.language, () => {
    it("keeps valid AST data, references, CST spans and service metadata identical", async () => {
      const before = services(original, fixture.factory, fixture.service);
      const after = services(modular, fixture.factory, fixture.service);
      const expected = before.parser.LangiumParser.parse(fixture.valid);
      const actual = after.parser.LangiumParser.parse(fixture.valid);
      expect(expected.lexerErrors).toEqual([]);
      expect(expected.parserErrors).toEqual([]);
      expect(actual.lexerErrors).toEqual([]);
      expect(actual.parserErrors).toEqual([]);
      expect(actual.value.$type).toBe(fixture.astType);
      expect(snapshotAst(actual.value)).toEqual(snapshotAst(expected.value));
      expect(after.LanguageMetaData).toEqual(before.LanguageMetaData);
      const predicate = `is${fixture.astType}`;
      if (typeof original[predicate] === "function") {
        expect((original[predicate] as (node: unknown) => boolean)(expected.value)).toBe(true);
        expect((modular[predicate] as (node: unknown) => boolean)(actual.value)).toBe(true);
        expect((modular[predicate] as (node: unknown) => boolean)({ $type: "Invalid" })).toBe(
          false,
        );
      }
      expect(after.Grammar).toBe(services(modular, fixture.factory, fixture.service).Grammar);
      expect(before.Grammar).toBe(services(original, fixture.factory, fixture.service).Grammar);
      expect(snapshotAst(await modular.parse(fixture.language, fixture.valid))).toEqual(
        snapshotAst(await original.parse(fixture.language, fixture.valid)),
      );
    });
    it.each(["invalid", "malformed"] as const)(
      "keeps %s error recovery and public rejection identical",
      async (kind) => {
        const before = services(
          original,
          fixture.factory,
          fixture.service,
        ).parser.LangiumParser.parse(fixture[kind]);
        const after = services(
          modular,
          fixture.factory,
          fixture.service,
        ).parser.LangiumParser.parse(fixture[kind]);
        expect(before.lexerErrors.length + before.parserErrors.length).toBeGreaterThan(0);
        expect(snapshotErrors(after.lexerErrors)).toEqual(snapshotErrors(before.lexerErrors));
        expect(snapshotErrors(after.parserErrors)).toEqual(snapshotErrors(before.parserErrors));
        expect(snapshotAst(after.value)).toEqual(snapshotAst(before.value));
        const rejection = async (api: API) => {
          try {
            await api.parse(fixture.language, fixture[kind]);
            return undefined;
          } catch (error) {
            return { name: (error as Error).name, message: (error as Error).message };
          }
        };
        expect(await rejection(modular)).toEqual(await rejection(original));
      },
    );
  });
}

for (const language of ["radar", "eventmodeling"]) {
  it(`preserves resolved ${language} cross-references through the public service factory`, async () => {
    const fixture = cases.find((entry) => entry.language === language)!;
    const documents = [];
    for (const api of [original, modular]) {
      const factory = api[fixture.factory] as () => { shared: LangiumSharedCoreServices };
      const created = factory();
      const document = created.shared.workspace.LangiumDocumentFactory.fromString(
        fixture.valid,
        URI.parse(`file:///parity-${language}.mmd`),
      );
      created.shared.workspace.LangiumDocuments.addDocument(document);
      await created.shared.workspace.DocumentBuilder.build([document], { validation: true });
      expect(document.parseResult.lexerErrors).toEqual([]);
      expect(document.parseResult.parserErrors).toEqual([]);
      expect(document.references.length).toBeGreaterThan(0);
      for (const reference of document.references) {
        expect("ref" in reference).toBe(true);
        if (!("ref" in reference)) throw new Error("Expected a single AST cross-reference");
        expect(reference.ref).toBeDefined();
        expect(reference.error).toBeUndefined();
      }
      documents.push(document);
    }
    expect(snapshotAst(documents[1].parseResult.value)).toEqual(
      snapshotAst(documents[0].parseResult.value),
    );
    expect(documents[1].diagnostics).toEqual(documents[0].diagnostics);
  });
}

it("fails closed on unsupported installed package versions", () => {
  const fakeRoot = path.join(temporary, "unsupported");
  mkdirSync(fakeRoot, { recursive: true });
  writeFileSync(
    path.join(fakeRoot, "package.json"),
    '{"name":"@mermaid-js/parser","version":"9.0.0"}',
  );
  expect(() =>
    loadMermaidParserSources({ ...entries, parserEntry: path.join(fakeRoot, "entry.mjs") }),
  ).toThrow(/unsupported @mermaid-js\/parser version 9\.0\.0/);
});

it("fails closed on missing, additional or altered original source content", () => {
  const lock = JSON.parse(
    readFileSync(path.join(root, "scripts/build/mermaid-parser/source-lock.json"), "utf8"),
  );
  const originals = new Map<string, string>();
  // Re-load untouched map content for guard mutation tests instead of trusting
  // the already partitioned grammar/module declarations.
  const parserDirectory = path.dirname(entries.parserEntry);
  const maps = [path.join(parserDirectory, "mermaid-parser.core.mjs.map")];
  const chunks = path.join(parserDirectory, "chunks/mermaid-parser.core");
  maps.push(
    ...readdirSync(chunks)
      .filter((file) => file.endsWith(".map"))
      .map((file) => path.join(chunks, file)),
  );
  for (const file of maps) {
    const map = JSON.parse(readFileSync(file, "utf8"));
    map.sources.forEach((source: string, index: number) => {
      const match = /^(?:\.\.\/)+src\/(.+)$/.exec(source);
      if (match) originals.set(`src/${match[1]}`, map.sourcesContent[index]);
    });
  }
  for (const [name, content] of Object.entries(
    JSON.parse(
      readFileSync(path.join(root, "scripts/build/mermaid-parser/upstream-barrels.json"), "utf8"),
    ) as Record<string, string>,
  ))
    originals.set(name, content);
  expect(() => verifyMermaidParserSources(originals, lock)).not.toThrow();
  expect(() => verifyMermaidParserSourceShape(originals)).not.toThrow();
  expect(sources.get("src/parse.ts")).toBe(originals.get("src/parse.ts"));
  const altered = new Map(originals);
  altered.set("src/parse.ts", originals.get("src/parse.ts") + "\n// drift");
  expect(() => verifyMermaidParserSources(altered, lock)).toThrow(
    /content changed in src\/parse.ts/,
  );
  const missing = new Map(originals);
  missing.delete("src/parse.ts");
  expect(() => verifyMermaidParserSources(missing, lock)).toThrow(/inventory changed/);
  const extra = new Map(originals);
  extra.set("src/new.ts", "export {};");
  expect(() => verifyMermaidParserSources(extra, lock)).toThrow(/inventory changed/);
  const impure = new Map(originals);
  impure.set("src/index.ts", originals.get("src/index.ts") + "\nglobalThis.changed = true;");
  expect(() => verifyMermaidParserSourceShape(impure)).toThrow(/barrel has runtime statements/);
  const registration = new Map(originals);
  registration.set("src/parse.ts", originals.get("src/parse.ts") + "\nregister();");
  expect(() => verifyMermaidParserSourceShape(registration)).toThrow(
    /unexpected top-level statement|top-level call/,
  );
  const mutation = new Map(originals);
  mutation.set(
    "src/parse.ts",
    originals.get("src/parse.ts") + "\nconst effect = (globalThis.changed = true);",
  );
  expect(() => verifyMermaidParserSourceShape(mutation)).toThrow(/top-level mutation/);
  const allocation = new Map(originals);
  allocation.set(
    "src/parse.ts",
    originals.get("src/parse.ts") + "\nconst singleton = new ExternalService();",
  );
  expect(() => verifyMermaidParserSourceShape(allocation)).toThrow(
    /unexpected top-level allocation/,
  );
  const typeMarked = markTypeOnlyReexports(
    "src/language/index.ts",
    originals.get("src/language/index.ts"),
    originals,
  );
  expect(typeMarked).toContain("type MermaidAstType");
  expect(typeMarked).not.toContain("type Info,");
  const shape = new Map(originals);
  shape.set(
    "src/language/generated/grammar.ts",
    originals.get("src/language/generated/grammar.ts") +
      "\nthrow new Error('unexpected side effect');",
  );
  expect(() => partitionMermaidParserSources(shape)).toThrow(/unexpected grammar statement/);
});

it("keeps each grammar outside the parse entry's static import closure", async () => {
  const entry = path.join(entryDirectory, "parse-only.mjs");
  writeFileSync(entry, 'export { parse } from "@mermaid-js/parser";');
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [mermaidParserPlugin()],
    build: {
      outDir: path.join(temporary, "lazy"),
      emptyOutDir: true,
      target: "es2022",
      minify: true,
      modulePreload: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        output: { format: "es", entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" },
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Unexpected Vite output");
  const chunks = result.output.filter((item) => item.type === "chunk");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const staticImports = new Set<string>();
  function visit(file: string) {
    if (staticImports.has(file)) return;
    staticImports.add(file);
    for (const imported of byName.get(file)?.imports ?? []) visit(imported);
  }
  visit("entry.mjs");
  const owners = chunks.filter((chunk) =>
    chunk.moduleIds.some((id) => id.includes("/grammar-parts/")),
  );
  expect(owners).toHaveLength(15);
  for (const owner of owners) {
    expect(owner.moduleIds.filter((id) => id.includes("/grammar-parts/"))).toHaveLength(1);
    expect(staticImports.has(owner.fileName), owner.fileName).toBe(false);
    expect(Buffer.byteLength(owner.code)).toBeLessThan(50_000);
  }
  expect(chunks.filter((chunk) => chunk.isDynamicEntry).length).toBeGreaterThanOrEqual(15);
});
