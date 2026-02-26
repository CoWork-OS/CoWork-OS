/**
 * Tests for workspace-local gateway router rules (.cowork/router/rules.monty)
 */

import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { evaluateWorkspaceRouterRules } from "../router-rules";

describe("evaluateWorkspaceRouterRules", () => {
  it("can reply deterministically based on message text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-router-"));
    const rulesDir = path.join(tmpDir, ".cowork", "router");
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(
      path.join(rulesDir, "rules.monty"),
      [
        'out = {"action": "pass"}',
        't = (input.get("text") or "").strip().lower()',
        'if t == "ping":',
        '  out = {"action": "reply", "text": "pong"}',
        "out",
      ].join("\n"),
      "utf8",
    );

    const workspace: Any = { id: "ws1", name: "WS", path: tmpDir };
    const message: Any = {
      messageId: "m1",
      chatId: "c1",
      userId: "u1",
      userName: "User",
      isGroup: false,
      text: "ping",
      timestamp: new Date(),
      attachments: [],
    };

    const res = await evaluateWorkspaceRouterRules({
      workspace,
      channelType: "telegram",
      sessionId: "s1",
      message,
      contextType: "dm",
      taskId: null,
    });

    expect(res).toEqual({ action: "reply", text: "pong" });
  });
});
