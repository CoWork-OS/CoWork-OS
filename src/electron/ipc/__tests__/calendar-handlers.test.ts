import { describe, expect, it, vi } from "vitest";

const handle = vi.fn();
vi.mock("electron", () => ({ ipcMain: { handle: (...args: unknown[]) => handle(...args) } }));

import { IPC_CHANNELS } from "../../../shared/types";
import {
  createCalendarIpcHandlers,
  setupCalendarHandlers,
  type CalendarIpcDeps,
} from "../calendar-handlers";

const WS = "11111111-1111-4111-8111-111111111111";
const SUGGESTION = "22222222-2222-4222-8222-222222222222";

function setup(overrides: Partial<CalendarIpcDeps> = {}) {
  const deps = {
    proposals: {
      accept: vi.fn(async () => ({ ok: true as const, kind: "focus_hold" as const })),
      dismiss: vi.fn(() => true),
      bookHold: vi.fn(async () => ({ ok: true as const, kind: "focus_hold" as const })),
    },
    getSuggestionTitle: vi.fn(async () => "Block focus time for the deck"),
    markSuggestionActedOn: vi.fn(async () => {}),
    onChanged: vi.fn(),
    checkRateLimit: vi.fn(),
    ...overrides,
  };
  return { deps, handlers: createCalendarIpcHandlers(deps) };
}

describe("calendar IPC", () => {
  it("accepts only proposal ids and signals the queue after a change", async () => {
    const { deps, handlers } = setup();
    const accept = handlers[IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT];
    await expect(accept("hold:c1")).resolves.toEqual({ ok: true, kind: "focus_hold" });
    expect(deps.proposals.accept).toHaveBeenCalledWith("hold:c1");
    expect(deps.checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT);
    expect(deps.onChanged).toHaveBeenCalledOnce();
    for (const bad of [
      "",
      "task:1",
      "hold: c1",
      42,
      { id: "hold:c1" },
      `hold:${"x".repeat(400)}`,
    ]) {
      await expect(accept(bad)).rejects.toThrow();
    }
    expect(deps.proposals.accept).toHaveBeenCalledOnce();
  });

  it("doesn't signal a change that didn't happen", async () => {
    const { deps, handlers } = setup();
    deps.proposals.accept.mockResolvedValueOnce({
      ok: false,
      reason: "gone",
      message: "This no longer applies to your calendar.",
    } as never);
    await handlers[IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT]("conflict:a:b");
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  it("dismisses a proposal", async () => {
    const { deps, handlers } = setup();
    await expect(handlers[IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS]("prep:e1:123")).resolves.toEqual({
      ok: true,
    });
    expect(deps.proposals.dismiss).toHaveBeenCalledWith("prep:e1:123");
    expect(deps.onChanged).toHaveBeenCalledOnce();
    deps.proposals.dismiss.mockReturnValueOnce(false);
    await expect(handlers[IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS]("prep:e1:123")).resolves.toEqual({
      ok: false,
    });
    expect(deps.onChanged).toHaveBeenCalledOnce();
  });

  it("only takes changes from the app's top-level window", async () => {
    const { deps } = setup();
    setupCalendarHandlers(deps);
    const registered = new Map(
      handle.mock.calls.map(([channel, fn]) => [channel as string, fn as Function]),
    );
    const accept = registered.get(IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT)!;
    expect(() => accept({ senderFrame: { parent: {} } }, "hold:c1")).toThrow("app window");
    expect(() => accept({}, "hold:c1")).toThrow("app window");
    await expect(accept({ senderFrame: { parent: null } }, "hold:c1")).resolves.toMatchObject({
      ok: true,
    });
    expect(deps.proposals.accept).toHaveBeenCalledOnce();
  });

  it("holds time under the stored suggestion's title, then records it as acted on", async () => {
    const { deps, handlers } = setup();
    const hold = handlers[IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION];
    await expect(
      hold({ workspaceId: WS, suggestionId: SUGGESTION, start: 1_000, end: 2_000 }),
    ).resolves.toEqual({ ok: true, kind: "focus_hold" });
    expect(deps.getSuggestionTitle).toHaveBeenCalledWith(WS, SUGGESTION);
    expect(deps.proposals.bookHold).toHaveBeenCalledWith({
      title: "Focus: Block focus time for the deck",
      start: 1_000,
      end: 2_000,
    });
    expect(deps.markSuggestionActedOn).toHaveBeenCalledWith(WS, SUGGESTION);
    expect(deps.onChanged).toHaveBeenCalledOnce();
  });

  it("rejects a renderer-supplied title and unknown suggestions", async () => {
    const { deps, handlers } = setup();
    const hold = handlers[IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION];
    await expect(
      hold({ workspaceId: WS, suggestionId: SUGGESTION, start: 1, end: 2, title: "Anything" }),
    ).rejects.toThrow();
    await expect(
      hold({ workspaceId: WS, suggestionId: "not-a-uuid", start: 1, end: 2 }),
    ).rejects.toThrow();
    deps.getSuggestionTitle.mockResolvedValueOnce(null as never);
    await expect(
      hold({ workspaceId: WS, suggestionId: SUGGESTION, start: 1, end: 2 }),
    ).resolves.toMatchObject({ ok: false, reason: "gone" });
    expect(deps.proposals.bookHold).not.toHaveBeenCalled();
    expect(deps.markSuggestionActedOn).not.toHaveBeenCalled();
  });

  it("stops at the rate limit before doing anything", async () => {
    const { deps, handlers } = setup({
      checkRateLimit: () => {
        throw new Error("Rate limit exceeded.");
      },
    });
    await expect(handlers[IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS]("hold:c1")).rejects.toThrow(
      "Rate limit",
    );
    expect(deps.proposals.dismiss).not.toHaveBeenCalled();
  });
});
