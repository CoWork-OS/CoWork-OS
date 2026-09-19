import { describe, expect, it } from "vitest";
import { authorizationFingerprint, authorizationToolInput } from "../authorization-identity";

describe("authorization identity", () => {
  it("binds grants to exact arguments and policy, independent of object key order", () => {
    const first = {
      taskId: "task-a",
      policy: { root: "/workspace", network: false },
      input: { command: "npm test", cwd: "/workspace" },
    };
    const reordered = {
      input: { cwd: "/workspace", command: "npm test" },
      policy: { network: false, root: "/workspace" },
      taskId: "task-a",
    };
    expect(authorizationFingerprint(first)).toBe(authorizationFingerprint(reordered));
    for (const changed of [
      { ...first, taskId: "task-b" },
      { ...first, policy: { ...first.policy, root: "/other" } },
      { ...first, input: { ...first.input, command: "npm publish" } },
    ])
      expect(authorizationFingerprint(first)).not.toBe(authorizationFingerprint(changed));
  });

  it("does not let persisted presentation metadata change the requested operation", () => {
    const original = { tool: "run_command", command: "npm test", cwd: "/workspace" };
    expect(
      authorizationToolInput({
        ...original,
        permissionPrompt: {},
        accessProfile: {},
        authorization: { key: "old" },
        reason: "review",
      }),
    ).toEqual(authorizationToolInput(original));
    expect(
      authorizationToolInput({ tool: "write_file", params: { path: "a.md", content: "first" } }),
    ).not.toEqual(
      authorizationToolInput({ tool: "write_file", params: { path: "a.md", content: "second" } }),
    );
  });
});
