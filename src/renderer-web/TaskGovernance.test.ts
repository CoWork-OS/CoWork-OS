import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  hasApprovalAttemptRevisionChanged,
  buildInputRequestAnswers,
  InputRequestForm,
  inputRequestCanSubmit,
  inputRequestIdentity,
  parseInputs,
  readAttempt,
  writeAttempt,
} from "./TaskGovernance";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../shared/approval-draft-presentation";

afterEach(() => vi.unstubAllGlobals());

describe("browser decision recovery", () => {
  it("persists only non-secret receipt metadata for an unresolved input response", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
    writeAttempt("pending", {
      id: "request-1",
      key: "operation-key-1",
      kind: "input_request",
      expectedVersion: 123,
      decision: "submitted",
      answers: { account: { otherText: "private answer" } },
    });
    expect(items.get("pending")).not.toContain("private answer");
    expect(readAttempt("pending")).toEqual({
      id: "request-1",
      key: "operation-key-1",
      kind: "input_request",
      expectedVersion: 123,
      decision: "submitted",
    });
    writeAttempt("pending", null);
    expect(items.has("pending")).toBe(false);
  });

  it("binds recovered approval attempts to their displayed revision and invalidates changed rows", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
    const displayedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    writeAttempt("approval", {
      id: "approval-1",
      key: "operation-key-2",
      kind: "approval",
      expectedVersion: 123,
      expectedRevisionHash: displayedHash,
      decision: "approved",
    });

    expect(readAttempt("approval")).toMatchObject({
      id: "approval-1",
      kind: "approval",
      expectedRevisionHash: displayedHash,
    });
    const recovered = readAttempt("approval");
    expect(
      hasApprovalAttemptRevisionChanged(recovered, [
        { id: "approval-1", revisionHash: currentHash },
      ]),
    ).toBe(true);
    expect(
      hasApprovalAttemptRevisionChanged(recovered, [
        { id: "approval-1", revisionHash: displayedHash },
      ]),
    ).toBe(false);

    items.set(
      "legacy-approval",
      JSON.stringify({
        id: "approval-1",
        key: "operation-key-3",
        kind: "approval",
        expectedVersion: 123,
        decision: "approved",
      }),
    );
    expect(readAttempt("legacy-approval")).toBeNull();
  });
});

describe("browser responsibility write review", () => {
  const content = "the exact proposed body\n";
  const target = "reports/current.txt";
  const baseHash = "b".repeat(64);
  const proposedHash = "a".repeat(64);
  const baseReview = {
    draft: {
      state: "bound",
      files: [{ reference: target, status: "present", sha256: baseHash, size: 12 }],
    },
    previews: [
      { reference: target, sha256: baseHash, text: "the current file\n", truncated: false },
    ],
  };
  const validActionReview = {
    required: true,
    state: "valid",
    review: {
      canonicalPath: target,
      content,
      contentSha256: proposedHash,
      contentBytes: new TextEncoder().encode(content).byteLength,
      responsibilityRun: {
        id: "run-1",
        revision: 2,
        controlVersion: 3,
        workspaceId: "workspace-1",
        agentRoleId: "writer-1",
      },
    },
  };
  const markerQuestion = {
    id: RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
    header: "Write approval",
    question: "Allow this exact proposed write?",
    options: [
      { label: "Deny once", description: "Reject this write" },
      { label: "Allow once", description: "Apply this write once" },
      { label: "Allow always", description: "Remember this choice" },
    ],
  };

  function parseMarkedInput(options: { actionReview?: unknown; draft?: unknown } = {}) {
    const actionReview = Object.hasOwn(options, "actionReview")
      ? options.actionReview
      : validActionReview;
    const draft = Object.hasOwn(options, "draft") ? options.draft : baseReview;
    return parseInputs(
      {
        inputRequests: [
          {
            id: "request-1",
            taskId: "task-1",
            expectedVersion: 17,
            questions: [markerQuestion],
            ...(draft === undefined ? {} : { draftReview: draft }),
            ...(actionReview === undefined ? {} : { responsibilityActionReview: actionReview }),
          },
        ],
      },
      "task-1",
    )[0];
  }

  function render(request: ReturnType<typeof parseMarkedInput>) {
    return renderToStaticMarkup(
      createElement(InputRequestForm, {
        request,
        disabled: false,
        locked: false,
        retryDecision: null,
        onRespond: () => {},
      }),
    );
  }

  it("renders the existing target separately from the complete proposed write", () => {
    const request = parseMarkedInput();
    const html = render(request);
    expect(request.responsibilityActionReview?.state).toBe("valid");
    expect(html).toContain("Current target revision");
    expect(html).toContain("the current file");
    expect(html).toContain("Proposed write for this request");
    expect(html).toContain(target);
    expect(html).toContain(proposedHash);
    expect(html).toContain(`${content.length} bytes`);
    expect(html).toContain("the exact proposed body");
    expect(html).toContain("Allow once");
    expect(html).not.toContain("Allow always");
    expect(html).not.toContain("Other</span>");
  });

  it("fails closed when review or matching base revision is missing and keeps deny available", () => {
    const missingReview = parseMarkedInput({ actionReview: undefined });
    const missingBase = parseMarkedInput({ draft: undefined });
    const mismatchedBase = parseMarkedInput({
      draft: {
        draft: {
          state: "bound",
          files: [
            { reference: "reports/other.txt", status: "present", sha256: baseHash, size: 12 },
          ],
        },
        previews: [],
      },
    });
    for (const request of [missingReview, missingBase, mismatchedBase]) {
      expect(request.responsibilityActionReview?.state).toBe("invalid");
      const html = render(request);
      expect(html).toMatch(/<label><input[^>]*disabled=""[^>]*\/><span>Allow once/);
      expect(html).toContain("Deny once");
      expect(html).toContain("could not be reviewed");
    }
  });

  it("uses the same fail-closed decision gate for submit and keyboard form submission", () => {
    const valid = parseMarkedInput();
    const invalid = parseMarkedInput({ actionReview: undefined });
    const allow = { [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: "Allow once" };
    const deny = { [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: "Deny once" };

    expect(inputRequestCanSubmit(valid, allow, {}, inputRequestIdentity(valid))).toBe(true);
    expect(buildInputRequestAnswers(valid, allow, {})).toEqual({
      [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: { optionLabel: "Allow once" },
    });
    expect(inputRequestCanSubmit(invalid, allow, {}, inputRequestIdentity(invalid))).toBe(false);
    expect(inputRequestCanSubmit(invalid, deny, {}, inputRequestIdentity(invalid))).toBe(true);
    expect(inputRequestCanSubmit(valid, allow, {}, "stale-review-identity")).toBe(false);
  });

  it("leaves ordinary question choices and Other answers unchanged", () => {
    const [request] = parseInputs(
      {
        inputRequests: [
          {
            id: "ordinary-1",
            taskId: "task-1",
            expectedVersion: 3,
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Choose a color",
                options: [{ label: "Blue", description: "" }],
              },
            ],
          },
        ],
      },
      "task-1",
    );
    const html = render(request);
    expect(html).toContain("Blue");
    expect(html).toContain("Other");
    expect(html).not.toContain("Proposed write for this request");
    expect(
      inputRequestCanSubmit(
        request,
        { color: "__other__" },
        { color: "Green" },
        inputRequestIdentity(request),
      ),
    ).toBe(true);
  });
});
