import { describe, expect, it, vi } from "vitest";
import { createQuitConfirmation, quitConfirmationText } from "../quit-confirmation";

function setup(overrides: Partial<Parameters<typeof createQuitConfirmation>[0]> = {}) {
  const ask = vi.fn(() => true);
  let time = 0;
  const confirmation = createQuitConfirmation(
    {
      isEnabled: () => true,
      workingTaskCount: () => 2,
      isUnattended: () => false,
      ask,
      ...overrides,
    },
    () => time,
  );
  return { confirmation, ask, advance: (ms: number) => (time += ms) };
}

describe("quit confirmation", () => {
  it("asks once when tasks are working and remembers a yes for the rest of the quit", () => {
    const { confirmation, ask } = setup();
    expect(confirmation.confirmQuit()).toBe(true);
    expect(confirmation.confirmQuit()).toBe(true);
    expect(confirmation.confirmClose()).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith(2);
  });

  it("cancels the quit on a no and asks again next time", () => {
    const ask = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { confirmation } = setup({ ask });
    expect(confirmation.confirmQuit()).toBe(false);
    expect(confirmation.confirmQuit()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["nothing is working", { workingTaskCount: () => 0 }],
    ["the setting is off", { isEnabled: () => false }],
    ["nobody can answer", { isUnattended: () => true }],
  ])("does not ask when %s", (_label, overrides) => {
    const { confirmation, ask } = setup(overrides);
    expect(confirmation.confirmQuit()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("never blocks quitting when a check throws", () => {
    const { confirmation, ask } = setup({
      workingTaskCount: () => {
        throw new Error("daemon gone");
      },
    });
    expect(confirmation.confirmQuit()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask twice when closing the last window leads to the quit", () => {
    const { confirmation, ask, advance } = setup();
    expect(confirmation.confirmClose()).toBe(true);
    advance(200);
    expect(confirmation.confirmQuit()).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("asks again when a confirmed close did not end in a quit", () => {
    const { confirmation, ask, advance } = setup();
    expect(confirmation.confirmClose()).toBe(true);
    advance(60_000);
    expect(confirmation.confirmQuit()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("keeps the window when the close is declined", () => {
    const ask = vi.fn(() => false);
    const { confirmation } = setup({ ask });
    expect(confirmation.confirmClose()).toBe(false);
    expect(confirmation.confirmClose()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("words the question for one task and for several", () => {
    expect(quitConfirmationText(1).detail).toContain("1 task is still running");
    expect(quitConfirmationText(3).detail).toContain("3 tasks are still running");
  });
});
