import { describe, it, expect, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor /schedule slash command handling", () => {
  function createExecutor(prompt: string, toolImpl: (input: Any) => Any) {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-1",
      title: "Test Task",
      prompt,
      createdAt: Date.now() - 1000,
    };

    executor.workspace = {
      id: "workspace-1",
      path: "/tmp",
      isTemp: false,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };

    executor.daemon = {
      logEvent: vi.fn(),
      updateTaskStatus: vi.fn(),
      completeTask: vi.fn(),
      getTaskEvents: vi.fn().mockReturnValue([]),
      requestApproval: vi.fn().mockResolvedValue(true),
    };

    executor.toolRegistry = {
      executeTool: vi.fn(async (name: string, input: Any) => {
        expect(name).toBe("schedule_task");
        return toolImpl(input);
      }),
    };

    // Avoid pulling in the full snapshot dependencies.
    executor.saveConversationSnapshot = vi.fn();

    executor.conversationHistory = [];
    executor.lastAssistantOutput = null;
    executor.lastNonVerificationOutput = null;
    executor.taskCompleted = false;

    return executor as TaskExecutor & {
      daemon: {
        logEvent: ReturnType<typeof vi.fn>;
        updateTaskStatus: ReturnType<typeof vi.fn>;
        completeTask: ReturnType<typeof vi.fn>;
        getTaskEvents: ReturnType<typeof vi.fn>;
      };
      toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
      saveConversationSnapshot: ReturnType<typeof vi.fn>;
    };
  }

  it("creates a scheduled task for `/schedule every <interval> <prompt>`", async () => {
    const calls: Any[] = [];
    const executor = createExecutor("/schedule every 6h Check price.", (input) => {
      calls.push(input);
      if (input.action === "list") return [];
      if (input.action === "create") {
        return {
          success: true,
          job: {
            id: "job-1",
            name: input.name,
            enabled: true,
            schedule: { kind: "every", everyMs: 6 * 60 * 60 * 1000 },
            state: { nextRunAtMs: Date.now() + 123_000 },
          },
        };
      }
      throw new Error(`Unexpected action: ${input.action}`);
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleScheduleSlashCommand.call(
      executor,
    );
    expect(handled).toBe(true);
    expect(executor.taskCompleted).toBe(true);

    // Upsert logic: list then create
    expect(calls[0]).toEqual({ action: "list", includeDisabled: true });
    expect(calls[1]).toMatchObject({
      action: "create",
      name: "Check price.",
      prompt: "Check price.",
      schedule: { type: "interval", every: "6h" },
      enabled: true,
    });

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    const summary = executor.daemon.completeTask.mock.calls[0][1];
    expect(String(summary)).toContain('Scheduled "Check price."');
  });

  it("lists scheduled tasks for `/schedule list`", async () => {
    const executor = createExecutor("/schedule list", (input) => {
      if (input.action === "list") {
        return [
          {
            id: "job-1",
            name: "Job A",
            enabled: true,
            updatedAtMs: 2,
            schedule: { kind: "cron", expr: "0 9 * * *" },
            state: { nextRunAtMs: Date.now() + 1000 },
          },
        ];
      }
      throw new Error(`Unexpected action: ${input.action}`);
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleScheduleSlashCommand.call(
      executor,
    );
    expect(handled).toBe(true);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "Listed 1 scheduled task(s).",
      expect.objectContaining({
        terminalStatus: "ok",
      }),
    );
  });

  it("rejects too-small intervals for `/schedule every`", async () => {
    const executor = createExecutor("/schedule every 10s Too fast", (input) => {
      if (input.action === "list") return [];
      return { success: true };
    });

    await expect(
      (TaskExecutor as Any).prototype.maybeHandleScheduleSlashCommand.call(executor),
    ).rejects.toThrow(/Invalid interval/i);
  });
});

describe("TaskExecutor /simplify and /batch normalization", () => {
  function createExecutor(prompt: string, toolImpl: (name: string, input: Any) => Any) {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const resolvedInvocations = new Map<string, Any>();

    executor.task = {
      id: "task-2",
      title: "Slash command test",
      prompt,
      rawPrompt: prompt,
      userPrompt: prompt,
      agentConfig: {},
      createdAt: Date.now() - 1000,
    };

    executor.workspace = {
      id: "workspace-1",
      path: "/tmp",
      isTemp: false,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };

    executor.daemon = {
      logEvent: vi.fn(),
      updateTaskStatus: vi.fn(),
      completeTask: vi.fn(),
      getTaskEvents: vi.fn().mockReturnValue([]),
    };

    executor.toolRegistry = {
      executeTool: vi.fn(async (name: string, input: Any) => {
        const output = await toolImpl(name, input);
        if (output && typeof output === "object" && "result" in output && "resolvedSkill" in output) {
          const result = output.result as Any;
          if (typeof result?.skill_invocation_id === "string") {
            resolvedInvocations.set(result.skill_invocation_id, output.resolvedSkill);
          }
          return result;
        }
        return output;
      }),
      takeResolvedSkillInvocation: vi.fn((invocationId: string) => {
        const resolved = resolvedInvocations.get(invocationId) || null;
        resolvedInvocations.delete(invocationId);
        return resolved;
      }),
    };

    executor.saveConversationSnapshot = vi.fn();
    executor.conversationHistory = [];
    executor.lastAssistantOutput = null;
    executor.lastNonVerificationOutput = null;
    executor.taskCompleted = false;
    executor.appliedSkills = [];
    executor.taskContextNotes = [];
    executor.emitEvent = vi.fn();

    return executor as TaskExecutor & {
      toolRegistry: {
        executeTool: ReturnType<typeof vi.fn>;
        takeResolvedSkillInvocation: ReturnType<typeof vi.fn>;
      };
      emitEvent: ReturnType<typeof vi.fn>;
    };
  }

  function buildSkillToolSuccess(application: Any, invocationId = "skill-invocation-1") {
    return {
      result: {
        success: true,
        skill: application.skillId,
        skill_name: application.skillName,
        skill_invocation_id: invocationId,
        message: `Loaded skill '${application.skillName}' for this task.`,
      },
      resolvedSkill: application,
    };
  }

  it("normalizes `/simplify` into deterministic Skill execution", async () => {
    const originalPrompt = "/simplify";
    const executor = createExecutor("/simplify", (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "simplify",
        args: "",
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "simplify",
          skillName: "Simplify",
          trigger: "slash",
          args: "",
          parameters: {},
          content: "Simplify prompt expanded",
          reason: "Applied via /simplify",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe(originalPrompt);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "simplify",
          trigger: "slash",
          content: "Simplify prompt expanded",
        }),
      ]),
    );
  });

  it("normalizes `/batch` with flags into deterministic Skill execution", async () => {
    const originalPrompt =
      "/batch migrate docs to template --parallel 6 --domain writing --external confirm";
    const executor = createExecutor(
      originalPrompt,
      (name, input) => {
        expect(name).toBe("Skill");
        expect(input).toEqual({
          skill: "batch",
          args: "migrate docs to template --parallel 6 --domain writing --external confirm",
          trigger: "slash",
        });
        return buildSkillToolSuccess({
            skillId: "batch",
            skillName: "Batch",
            trigger: "slash",
            args: "migrate docs to template --parallel 6 --domain writing --external confirm",
            parameters: {
              objective: "migrate docs to template",
              parallel: 6,
              domain: "writing",
              external: "confirm",
            },
            content: "Batch prompt expanded",
            reason: "Applied via /batch",
            appliedAt: Date.now(),
          });
      },
    );

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe(originalPrompt);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "batch",
          trigger: "slash",
        }),
      ]),
    );
  });

  it("enforces `/batch` external policy default to confirm when omitted", async () => {
    const originalPrompt = "/batch migrate docs";
    const executor = createExecutor("/batch migrate docs", (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "batch",
        args: "migrate docs --external confirm",
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "batch",
          skillName: "Batch",
          trigger: "slash",
          args: "migrate docs --external confirm",
          parameters: {
            objective: "migrate docs",
            external: "confirm",
          },
          content: "Batch prompt expanded",
          reason: "Applied via /batch",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe(originalPrompt);
  });

  it("normalizes `/llm-wiki` with flags into deterministic Skill execution", async () => {
    const originalPrompt =
      "/llm-wiki agent memory systems --mode ingest --path research/wiki/agents --obsidian on";
    const executor = createExecutor(originalPrompt, (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "llm-wiki",
        args: "agent memory systems --mode ingest --path research/wiki/agents --obsidian on",
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "llm-wiki",
          skillName: "LLM Wiki",
          trigger: "slash",
          args: "agent memory systems --mode ingest --path research/wiki/agents --obsidian on",
          parameters: {
            objective: "agent memory systems",
            mode: "ingest",
            path: "research/wiki/agents",
            obsidian: "on",
          },
          content: "LLM Wiki prompt expanded",
          reason: "Applied via /llm-wiki",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe(originalPrompt);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "llm-wiki",
          trigger: "slash",
          content: "LLM Wiki prompt expanded",
        }),
      ]),
    );
  });

  it("allows `/llm-wiki` maintenance modes without an objective", async () => {
    const originalPrompt = '/llm-wiki --mode lint --path "Research Vault"';
    const executor = createExecutor(originalPrompt, (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "llm-wiki",
        args: '--mode lint --path "Research Vault"',
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "llm-wiki",
          skillName: "LLM Wiki",
          trigger: "slash",
          args: '--mode lint --path "Research Vault"',
          parameters: {
            objective: "",
            mode: "lint",
            path: "Research Vault",
          },
          content: "LLM Wiki lint prompt expanded",
          reason: "Applied via /llm-wiki",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe(originalPrompt);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "llm-wiki",
          trigger: "slash",
          content: "LLM Wiki lint prompt expanded",
        }),
      ]),
    );
  });

  it("resolves plugin slash aliases to their target skill", async () => {
    const executor = createExecutor("/geo-quick https://example.com", (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "geo-quick-audit",
        args: "https://example.com",
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "geo-quick-audit",
          skillName: "GEO Quick Audit",
          trigger: "slash",
          args: "https://example.com",
          parameters: {},
          content: "GEO audit prompt expanded",
          reason: "Applied via /geo-quick",
          appliedAt: Date.now(),
        });
    }) as Any;
    executor.resolveSkillSlashCommandName = vi.fn((name: string) =>
      name === "geo-quick" ? "geo-quick-audit" : null,
    );
    executor.getSkillForSlashCommand = vi.fn((skillId: string) =>
      skillId === "geo-quick-audit"
        ? {
            id: "geo-quick-audit",
            name: "GEO Quick Audit",
            description: "Audit a URL",
            icon: "🌐",
            prompt: "Audit {{url}}",
          }
        : undefined,
    );

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "geo-quick-audit",
          trigger: "slash",
          content: "GEO audit prompt expanded",
        }),
      ]),
    );
  });

  it("rejects `/batch` without an objective", async () => {
    const executor = createExecutor("/batch", (_name, _input) => {
      throw new Error("Skill should not be called");
    });

    await expect(
      (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(executor),
    ).rejects.toThrow(/Missing objective for \/batch/i);
  });

  it("applies `external=none` by restricting side-effect external tools", async () => {
    const executor = createExecutor("/batch migrate docs --external none", (name, input) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "batch",
        args: "migrate docs --external none",
        trigger: "slash",
      });
      return buildSkillToolSuccess({
          skillId: "batch",
          skillName: "Batch",
          trigger: "slash",
          args: "migrate docs --external none",
          parameters: {
            objective: "migrate docs",
            external: "none",
          },
          content: "Batch prompt expanded",
          reason: "Applied via /batch",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.agentConfig?.toolRestrictions).toEqual(
      expect.arrayContaining(["gmail_action", "notion_action", "voice_call"]),
    );
  });

  it("blocks side-effect external tools when `/batch external=none` policy is active", async () => {
    const executor = createExecutor("noop", (_name, _input) => ({ success: true }));
    executor.slashBatchExternalPolicy = "none";
    executor.slashBatchExternalConfirmGranted = false;

    const blocked = await (TaskExecutor as Any).prototype.maybeBlockToolByBatchExternalPolicy.call(
      executor,
      { id: "tool-1", name: "gmail_action", input: { action: "send_message" } },
      false,
    );

    expect(blocked).toBeTruthy();
    const payload = JSON.parse(String(blocked.content));
    expect(payload.blocked).toBe(true);
    expect(payload.reason).toBe("batch_external_none_policy");
  });

  it("requires explicit non-auto approval for `/batch external=confirm` side effects", async () => {
    const executor = createExecutor("noop", (_name, _input) => ({ success: true }));
    executor.slashBatchExternalPolicy = "confirm";
    executor.slashBatchExternalConfirmGranted = false;
    executor.daemon.requestApproval = vi.fn().mockResolvedValue(true);

    const first = await (TaskExecutor as Any).prototype.maybeBlockToolByBatchExternalPolicy.call(
      executor,
      { id: "tool-2", name: "gmail_action", input: { action: "send_message" } },
      false,
    );
    expect(first).toBeNull();
    expect(executor.daemon.requestApproval).toHaveBeenCalledWith(
      "task-2",
      "external_service",
      expect.stringContaining("/batch"),
      expect.objectContaining({
        tool: "gmail_action",
      }),
      { allowAutoApprove: false },
    );

    const second = await (TaskExecutor as Any).prototype.maybeBlockToolByBatchExternalPolicy.call(
      executor,
      { id: "tool-3", name: "gmail_action", input: { action: "send_message" } },
      false,
    );
    expect(second).toBeNull();
    expect(executor.daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("does not block read-only external actions under `/batch external=none`", async () => {
    const executor = createExecutor("noop", (_name, _input) => ({ success: true }));
    executor.slashBatchExternalPolicy = "none";
    executor.slashBatchExternalConfirmGranted = false;

    const blocked = await (TaskExecutor as Any).prototype.maybeBlockToolByBatchExternalPolicy.call(
      executor,
      { id: "tool-4", name: "gmail_action", input: { action: "list_messages" } },
      false,
    );

    expect(blocked).toBeNull();
  });

  it("supports inline `then run /simplify` chaining", async () => {
    const executor = createExecutor("Refactor this module then run /simplify", (name, input) => {
      expect(name).toBe("Skill");
      expect(input.skill).toBe("simplify");
      expect(input.trigger).toBe("slash");
      return buildSkillToolSuccess({
          skillId: "simplify",
          skillName: "Simplify",
          trigger: "slash",
          args: "",
          parameters: {},
          content: "Expanded simplify workflow",
          reason: "Applied via /simplify",
          appliedAt: Date.now(),
        });
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleSkillSlashCommandOrInlineChain.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.task.prompt).toBe("Refactor this module then run /simplify");
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "simplify",
          content: "Expanded simplify workflow",
        }),
      ]),
    );
  });
});
