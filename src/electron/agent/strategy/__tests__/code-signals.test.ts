import { describe, expect, it } from "vitest";
import {
  asksAboutProjectBehavior,
  hasStructuralCodeSignal,
  referencesOwnWorkspace,
} from "../code-signals";

describe("code-signals", () => {
  it.each([
    "Fix the null check in src/parser.ts",
    "package.json içindeki bağımlılıkları güncelle",
    "修复 src/utils/date.ts 中的错误",
    "Why does `parseConfig` return undefined?",
    "```ts\nconst x = 1;\n```",
    "Refactor UserService to use dependency injection",
    "Rename getUser to fetchUser everywhere",
    "The app crashes with TypeError: cannot read properties of undefined",
    "    at handleClick (Button.tsx:42:13)",
    'Traceback (most recent call last):\n  File "app.py", line 3, in <module>',
    "Call save() after the form submits",
    "Load the secrets from the .env file",
  ])("detects structural code cues: %s", (text) => {
    expect(hasStructuralCodeSignal(text)).toBe(true);
  });

  it.each([
    "Write a LinkedIn post about our launch",
    "Compare the iPhone and the Pixel camera",
    "Is macOS faster than Windows for video editing?",
    "Summarize report.pdf and notes.docx",
    "Translate this paragraph to German, e.g. for the brochure.",
    "Plan a 3.5 day trip to Rome",
    "What is the capital of France?",
  ])("ignores prose without code structure: %s", (text) => {
    expect(hasStructuralCodeSignal(text)).toBe(false);
  });

  it.each([
    "Which of our API endpoints lack auth checks?",
    "Does this project support Node 22?",
    "How should I structure the auth module in this repo?",
    "Bu projede rate limiter nerede yapılandırılıyor?",
    "Unterstützt dieses Projekt Node 22?",
    "¿Dónde se configura el limitador en este proyecto?",
    "Où est configuré le limiteur dans notre code ?",
    "这个项目在哪里配置限流？",
    "What does src/auth/session.ts do?",
  ])("detects references to the user's own project: %s", (text) => {
    expect(referencesOwnWorkspace(text)).toBe(true);
  });

  it.each([
    "What is the capital of France?",
    "How should I structure my week?",
    "Why is the sky blue?",
    "Explain how HTTPS works",
  ])("does not treat general-knowledge questions as project references: %s", (text) => {
    expect(referencesOwnWorkspace(text)).toBe(false);
  });

  it.each([
    ["Where is the rate limiter configured?", true],
    ["Where are the API routes defined?", true],
    ["Why does login fail on Safari?", true],
    ["Why is the dashboard so slow to load?", true],
    ["Why does the export endpoint return 500?", true],
    ["Where is the Eiffel Tower located?", false],
    ["Why is the sky blue?", false],
    ["Why do leaves change color in autumn?", false],
  ])("recognizes codebase location and failure questions: %s", (text, expected) => {
    expect(asksAboutProjectBehavior(text)).toBe(expected);
  });
});
