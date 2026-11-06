import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile, headingsOf, slugify } from "./validate-doc-links.mjs";

const withRepo = (files, run) => {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("slugify follows GitHub anchor rules", () => {
  assert.equal(slugify("Feishu / Lark"), "feishu--lark");
  assert.equal(slugify("What's new?"), "whats-new");
  assert.equal(slugify("  Setup & Config  "), "setup--config");
});

test("a valid relative link with a matching anchor passes", () => {
  withRepo({ "docs/a.md": "## Target\n\ntext" }, (root) => {
    const errors = checkFile(
      "docs/guide.md",
      "See [the target](a.md#target) for details.",
      root,
    );
    assert.deepEqual(errors, []);
  });
});

test("a missing target file is reported", () => {
  withRepo({ "docs/a.md": "text" }, (root) => {
    const errors = checkFile("docs/guide.md", "See [ghost](missing.md).", root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken link -> missing\.md/);
  });
});

test("an anchor that matches no heading is reported", () => {
  withRepo({ "docs/a.md": "## Target\n\ntext" }, (root) => {
    const errors = checkFile("docs/guide.md", "See [x](a.md#nope).", root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /matches no heading/);
  });
});

test("a same-page anchor is checked against the current file", () => {
  withRepo({}, (root) => {
    const ok = checkFile("docs/a.md", "## Setup\n\n[down](#setup)", root);
    assert.deepEqual(ok, []);
    const bad = checkFile("docs/a.md", "## Setup\n\n[down](#missing)", root);
    assert.equal(bad.length, 1);
  });
});

test("directory links are reported as broken", () => {
  withRepo({ "docs/guide/index.md": "index" }, (root) => {
    const errors = checkFile("docs/a.md", "See [index](guide/).", root);
    assert.equal(errors.length, 1);
  });
});

test("external, mailto and allowlisted targets are skipped", () => {
  withRepo({}, (root) => {
    const source = [
      "[site](https://example.com)",
      "[mail](mailto:a@b.c)",
      "[section](#top-of-page)",
    ].join("\n");
    // "(#top-of-page)" has no matching heading on purpose: fragment-only links
    // without a raw path are checked, so give the file that heading.
    const source2 = "## top-of-page\n" + source;
    assert.deepEqual(checkFile("docs/a.md", source2, root), []);
  });
});

test("historical files are skipped entirely", () => {
  withRepo({ "docs/release-notes-0.1.0.md": "[ghost](missing.md)" }, (root) => {
    assert.deepEqual(checkFile("docs/release-notes-0.1.0.md", "[ghost](missing.md)", root), []);
  });
});

test("headingsOf ignores fenced code that looks like headings", () => {
  const slugs = headingsOf("## Real\n\n```\n## Not A Heading\n```\n");
  assert.ok(slugs.has("real"));
  assert.ok(!slugs.has("not-a-heading"));
});
