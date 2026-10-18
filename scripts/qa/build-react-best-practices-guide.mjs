#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, "resources/skills/react-best-practices");
const rulesDirectory = path.join(directory, "rules");
const sections = fs.readFileSync(path.join(rulesDirectory, "_sections.md"), "utf8");
const priorities = [...sections.matchAll(/^## \d+\. .+ \(([^)]+)\)$/gm)].map((match) => match[1]);
const files = fs
  .readdirSync(rulesDirectory)
  .filter((file) => file.endsWith(".md") && !file.startsWith("_"));
files.sort((left, right) => {
  const priority = (file) => priorities.indexOf(file.split("-")[0]);
  return priority(left) - priority(right) || left.localeCompare(right, "en");
});
const content =
  [
    "# React Best Practices — Complete Guide",
    "Generated from the bundled rules by `node scripts/qa/build-react-best-practices-guide.mjs`. Edit individual rules, then regenerate this guide.",
    sections.trim(),
    ...files.map((file) => {
      const source = fs.readFileSync(path.join(rulesDirectory, file), "utf8");
      return `<!-- Source: rules/${file} -->\n${source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()}`;
    }),
  ].join("\n\n") + "\n";
const target = path.join(directory, "AGENTS.md");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content) {
    throw new Error(
      "Bundled React guide is missing or stale. Run npm run skills:build-react-guide.",
    );
  }
} else {
  fs.writeFileSync(target, content);
}
console.log(
  `[react-guide] ${process.argv.includes("--check") ? "Checked" : "Compiled"} ${files.length} bundled rules`,
);
