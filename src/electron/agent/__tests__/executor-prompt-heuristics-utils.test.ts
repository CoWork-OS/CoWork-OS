import { describe, expect, it } from "vitest";
import {
  detectTestRequirement,
  extractNamedTestCommands,
  isBuildCheckCommand,
  isTestCommand,
} from "../executor-prompt-heuristics-utils";

describe("detectTestRequirement", () => {
  it("detects explicit test-run requests", () => {
    expect(detectTestRequirement("Run the unit tests after the change.")).toBe(true);
    expect(detectTestRequirement("Please execute the test suite.")).toBe(true);
  });

  it("does not treat explicit test-run prohibitions as requirements", () => {
    expect(detectTestRequirement("Do not execute tests.")).toBe(false);
    expect(
      detectTestRequirement(
        "Read files only; do not run commands, modify files, or execute tests.",
      ),
    ).toBe(false);
    expect(detectTestRequirement("No need to run the test suite.")).toBe(false);
  });

  it("preserves a later positive request after a negated one", () => {
    expect(detectTestRequirement("Do not run tests now. Run the test suite after the fix.")).toBe(
      true,
    );
  });

  it("does not treat a request to avoid asking as a test prohibition", () => {
    expect(detectTestRequirement("Do not ask me before running the tests.")).toBe(true);
  });

  it.each([
    "Fix the date parser and run npm test.",
    "Fix the flaky retry logic, then run `pytest -q tests/test_retry.py`.",
    "Update the handler and make sure all tests still pass.",
    "Refactor the cache; the existing tests must pass.",
    "Iterate until the failing test passes.",
    "Get the test suite passing again after the upgrade.",
    "Fix the bug and run go test ./... before finishing.",
    "Run `make check` and make sure the tests pass.",
  ])("requires a test run for an imperative run/ensure-pass request: %s", (prompt) => {
    expect(detectTestRequirement(prompt)).toBe(true);
  });

  it.each([
    "Write a blog post comparing jest and vitest.",
    "Explain how our pytest fixtures are organized.",
    "Plan how to migrate the test suite to vitest.",
    "Add a GitHub Actions workflow that runs pytest on every push.",
    "Add a CI job to run the test suite on pull requests.",
    "Add a GitHub Actions workflow that will run pytest on every push.",
    "Set up jest for this project.",
    "Write unit tests for parser.ts (no need to run them; CI will).",
  ])("does not require a test run for a mention without run intent: %s", (prompt) => {
    expect(detectTestRequirement(prompt)).toBe(false);
  });
});

describe("isTestCommand", () => {
  it.each([
    "npm test",
    "npm t",
    "npm run test:unit",
    "pnpm -r test",
    "pnpm --filter api test",
    "yarn workspace api test",
    "npx vitest run src/a.test.ts",
    "npx vitest@latest run",
    "uv run pytest -q",
    "python -m pytest tests",
    "python3 -m unittest discover",
    "make test",
    "make check",
    "./gradlew test",
    "./gradlew :app:test",
    "mvn test",
    "./mvnw -q verify",
    "dotnet test",
    "swift test",
    "go test ./...",
    "cargo test",
    "cargo nextest run",
    "bundle exec rspec",
    "rspec spec/models",
    "vendor/bin/phpunit",
    "ctest --output-on-failure",
    "deno test",
    "mix test",
    "npx playwright test",
    "node --test",
    "tox -e py311",
    "bazel test //...",
    "turbo run test",
    "cd api && npm test",
  ])("recognizes %s", (command) => {
    expect(isTestCommand(command)).toBe(true);
  });

  it.each([
    "npm run build",
    "npm install",
    "make",
    "./gradlew build",
    "git status",
    "ls tests",
    "cat jest.config.js",
    "pip install pytest-xdist",
  ])("does not treat %s as a test run", (command) => {
    expect(isTestCommand(command)).toBe(false);
  });
});

describe("isBuildCheckCommand", () => {
  it.each([
    "npm run build",
    "pnpm lint",
    "yarn run typecheck",
    "npm run build:prod",
    "npx tsc --noEmit",
    "tsc -p tsconfig.json",
    "eslint src",
    "ruff check .",
    "mypy app",
    "go build ./...",
    "go vet ./...",
    "cargo check",
    "cargo clippy",
    "./gradlew build",
    "mvn -q package",
    "cd web && npm run lint",
    "node_modules/.bin/eslint src",
  ])("recognizes %s", (command) => {
    expect(isBuildCheckCommand(command)).toBe(true);
  });

  it.each([
    "npm test",
    "npm install",
    "grep -rn build src",
    "cat tsconfig.json",
    "ls build",
    "git status",
    "pip install mypy",
  ])("does not treat %s as a build or check", (command) => {
    expect(isBuildCheckCommand(command)).toBe(false);
  });
});

describe("extractNamedTestCommands", () => {
  it("returns the backticked commands the prompt asks to run for tests", () => {
    expect(
      extractNamedTestCommands(
        "Fix the parser, then run `./scripts/ci.sh --fast` and make sure the tests pass.",
      ),
    ).toEqual(["./scripts/ci.sh --fast"]);
    expect(extractNamedTestCommands("Run `npm run build` to bundle the app.")).toEqual([]);
  });
});
