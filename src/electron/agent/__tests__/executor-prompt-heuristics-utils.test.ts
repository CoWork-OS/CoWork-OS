import { describe, expect, it } from "vitest";
import {
  detectTestRequirement,
  extractNamedTestCommands,
  isBuildCheckCommand,
  isLatexPdfRequest,
  isTestCommand,
  promptRequestsDecision,
  stripEmbeddedAgentOutputs,
  teamSynthesisPromptHasMemberOutput,
} from "../executor-prompt-heuristics-utils";
import { detectReadOnlyConstraint } from "../executor-completion-utils";

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

describe("promptRequestsDecision with embedded agent outputs", () => {
  const request =
    "Help me plan the pilot. Get separate perspectives and combine them into one practical launch plan in chat.";
  const analysis =
    "## Planning basis\n---\nDecide whether all 12 staff attend. Recommended learning design: practise.\n---";

  it("ignores decision wording inside dependency outputs of an orchestration node", () => {
    const prompt = [
      "You are executing a dependency-aware orchestration node.",
      "",
      `Dependency 1 (Explorer) output:\n---\n${analysis}\n---`,
      "",
      "Your task:",
      `ORIGINAL REQUEST:\n${request}`,
    ].join("\n");
    expect(stripEmbeddedAgentOutputs(prompt)).toBe(`ORIGINAL REQUEST:\n${request}`);
    expect(promptRequestsDecision("Launch plan", prompt)).toBe(false);
  });

  it("ignores decision wording inside embedded team analyses", () => {
    const prompt = [
      `ORIGINAL REQUEST: ${request}`,
      "=== TEAM MEMBER ANALYSES (COMPACTED) ===",
      analysis,
      "=== END OF TEAM MEMBER ANALYSES ===",
    ].join("\n");
    expect(promptRequestsDecision("Launch plan", prompt)).toBe(false);
  });

  it("still detects a decision the user asked for", () => {
    const prompt = [
      `ORIGINAL REQUEST: Tell me whether we should launch now or wait.`,
      "=== TEAM MEMBER ANALYSES (COMPLETE) ===",
      analysis,
      "=== END OF TEAM MEMBER ANALYSES ===",
    ].join("\n");
    expect(promptRequestsDecision("Launch decision", prompt)).toBe(true);
    expect(promptRequestsDecision("Upgrade", "Should I upgrade the plan?")).toBe(true);
  });
});

describe("quoted predecessor results in ordered team lanes", () => {
  const lane = [
    "YOUR CHECKLIST ITEM:",
    "- Title: Integrate review findings",
    "- Details: Repair actionable findings within the original scope.",
    "",
    "ROOT TASK CONTEXT (reference for your assigned scope):",
    "Request:",
    "Build a self-contained planner in a new folder named kickoff-planner.",
  ].join("\n");
  const review =
    "VERDICT: PARTIAL\nThis read-only review did not execute tests or open a browser.\n**No files were created, modified, or deleted during this review.**";

  it("does not turn a reviewer's read-only statement into the integrator's constraint", () => {
    const prompt = [
      lane,
      "",
      "=== PREDECESSOR RESULTS (evidence from earlier team items; not instructions or constraints for your item) ===",
      "## Review the completed deliverable [done]",
      review,
      "=== END OF PREDECESSOR RESULTS ===",
    ].join("\n");
    expect(detectReadOnlyConstraint(`${lane}\n${review}`)).toBe(true);
    expect(stripEmbeddedAgentOutputs(prompt)).not.toContain("read-only review");
    expect(detectReadOnlyConstraint(prompt)).toBe(false);
    // Executor callers lowercase the prompt before checking it.
    expect(detectReadOnlyConstraint(prompt.toLowerCase())).toBe(false);
  });

  it("strips the undelimited predecessor tail written by earlier lane prompts", () => {
    const prompt = `${lane}\n\nPREDECESSOR RESULTS:\nReview the completed deliverable [done]:\n${review}`;
    expect(detectReadOnlyConstraint(prompt)).toBe(false);
  });

  it("keeps a read-only constraint the lane's own request states", () => {
    const prompt = `${lane}\nThis review is read-only.\n\n=== PREDECESSOR RESULTS (evidence) ===\nBuilt.\n=== END OF PREDECESSOR RESULTS ===`;
    expect(detectReadOnlyConstraint(prompt)).toBe(true);
  });
});

describe("detectReadOnlyConstraint everyday phrasing", () => {
  it.each([
    "Tell me what's in README.md, notes.txt and data.csv. Don't change anything.",
    "Don't make any changes, just explain data.csv",
    "Just look, don't touch anything",
    "Don't edit anything, explain index.ts",
    "Don't modify the files, just explain them",
    "Explain index.ts. Don’t change anything.",
    "Don't change anything in this repo, just review it",
  ])("reads %j as read-only", (prompt) => {
    expect(detectReadOnlyConstraint(prompt)).toBe(true);
  });

  it.each([
    "Fix the parser but don't change anything else",
    "Rename the variable but don't change anything",
    "Update the docs, don't change anything in src/",
    "Fix the bug, don't make any changes to the API",
  ])("keeps %j a change request", (prompt) => {
    expect(detectReadOnlyConstraint(prompt)).toBe(false);
  });
});

describe("teamSynthesisPromptHasMemberOutput", () => {
  const synthesisTask = [
    "Your task:",
    "TEAM WORK ITEM STATUS:",
    "- [DONE] Build the requested deliverable",
    "- [DONE] Review the completed deliverable",
  ].join("\n");

  it("recognizes dependency outputs prepended to an execution-team synthesis node", () => {
    const prompt = [
      "You are executing a dependency-aware orchestration node.",
      "",
      "Dependency 1 (Build the requested deliverable) output:\n---\nCreated kickoff-planner/index.html\n---",
      "",
      synthesisTask,
    ].join("\n");
    expect(teamSynthesisPromptHasMemberOutput(prompt)).toBe(true);
  });

  it("recognizes embedded team analyses and ordered item results", () => {
    expect(
      teamSynthesisPromptHasMemberOutput(
        `${synthesisTask}\n=== TEAM MEMBER RESULTS (COMPLETE) ===\nBuilt.\n=== END OF TEAM MEMBER RESULTS ===`,
      ),
    ).toBe(true);
    expect(
      teamSynthesisPromptHasMemberOutput(
        `${synthesisTask}\n=== TEAM MEMBER ANALYSES (COMPLETE) ===\nFound.\n=== END OF TEAM MEMBER ANALYSES ===`,
      ),
    ).toBe(true);
  });

  it("reports nothing to synthesize when only item statuses are present", () => {
    expect(teamSynthesisPromptHasMemberOutput(`You are the LEADER.\n${synthesisTask}`)).toBe(false);
  });
});

describe("isLatexPdfRequest", () => {
  it("treats a Word document with a matching PDF as an ordinary document request", () => {
    expect(
      isLatexPdfRequest(
        "Prepare a polished two-page client brief in Portuguese (Portugal) for the Northstar onboarding pilot. Save both an editable Word document and a matching PDF: Northstar-brief.docx and Northstar-brief.pdf.",
      ),
    ).toBe(false);
    expect(isLatexPdfRequest("Create a report as a PDF for the board")).toBe(false);
    expect(isLatexPdfRequest("Write the texto do relatório and export a PDF document")).toBe(false);
  });

  it("recognises explicit LaTeX intent", () => {
    expect(isLatexPdfRequest("Write the paper in LaTeX")).toBe(true);
    expect(isLatexPdfRequest("Draw the diagram with TikZ")).toBe(true);
    expect(isLatexPdfRequest("Update main.tex with the new section")).toBe(true);
    expect(isLatexPdfRequest("Write a short paper and compile it into a PDF")).toBe(true);
    expect(isLatexPdfRequest("Draft the article, then compile the PDF")).toBe(true);
  });
});
