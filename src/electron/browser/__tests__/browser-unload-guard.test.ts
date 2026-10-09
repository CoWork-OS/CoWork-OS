import { describe, expect, it, vi } from "vitest";
import { BrowserUnloadGuard } from "../browser-unload-guard";

const owner = { taskId: "t", sessionId: "default", tabId: "a", kind: "tab" as const };

/** A guest whose page has a beforeunload handler when `blocks` is true. */
function fakeGuest(blocks: boolean) {
  let onPreventUnload: ((event: { preventDefault: () => void }) => void) | undefined;
  const guest = {
    id: 7,
    destroyed: false,
    url: "https://forms.example/edit",
    isDestroyed() {
      return this.destroyed;
    },
    on: vi.fn((event: string, listener: Any) => {
      if (event === "will-prevent-unload") onPreventUnload = listener;
    }),
    loadURL: vi.fn(async (url: string) => {
      if (blocks) {
        let leave = false;
        onPreventUnload?.({ preventDefault: () => (leave = true) });
        if (!leave) throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" });
      }
      guest.url = url;
    }),
    unload(): boolean {
      let leave = false;
      onPreventUnload?.({ preventDefault: () => (leave = true) });
      return leave;
    },
  };
  return guest;
}

function setup(options: { leave: boolean; driving?: boolean; registered?: boolean }) {
  const confirmLeave = vi.fn(() => options.leave);
  const guard = new BrowserUnloadGuard({
    manager: { findTabOwner: () => (options.registered === false ? null : owner) } as Any,
    service: { isDriving: () => options.driving === true } as Any,
    confirmLeave,
  });
  return { guard, confirmLeave };
}

describe("BrowserUnloadGuard", () => {
  it("closes a tab whose page doesn't ask, without a dialog", async () => {
    const { guard, confirmLeave } = setup({ leave: false });
    const guest = fakeGuest(false);
    guard.attach(guest);
    await expect(guard.confirmClose(guest)).resolves.toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled();
  });

  it("keeps the tab when the user chooses to stay", async () => {
    const { guard, confirmLeave } = setup({ leave: false });
    const guest = fakeGuest(true);
    guard.attach(guest);
    await expect(guard.confirmClose(guest)).resolves.toBe(false);
    expect(confirmLeave).toHaveBeenCalledWith(guest, { closingTab: true });
    expect(guest.url).toBe("https://forms.example/edit");
  });

  it("closes the tab when the user chooses to leave", async () => {
    const { guard } = setup({ leave: true });
    const guest = fakeGuest(true);
    guard.attach(guest);
    await expect(guard.confirmClose(guest)).resolves.toBe(true);
  });

  it("asks on reload or navigation too, and honours the answer", () => {
    const stay = setup({ leave: false });
    const guest = fakeGuest(true);
    stay.guard.attach(guest);
    expect(guest.unload()).toBe(false);
    expect(stay.confirmLeave).toHaveBeenCalledWith(guest, { closingTab: false });

    const leave = setup({ leave: true });
    const other = fakeGuest(true);
    leave.guard.attach(other);
    expect(other.unload()).toBe(true);
  });

  it("never blocks CoWork or unregistered pages behind a dialog", async () => {
    const driving = setup({ leave: false, driving: true });
    const guest = fakeGuest(true);
    driving.guard.attach(guest);
    await expect(driving.guard.confirmClose(guest)).resolves.toBe(true);
    expect(driving.confirmLeave).not.toHaveBeenCalled();

    const unregistered = setup({ leave: false, registered: false });
    const other = fakeGuest(true);
    unregistered.guard.attach(other);
    expect(other.unload()).toBe(true);
    expect(unregistered.confirmLeave).not.toHaveBeenCalled();
  });

  it("treats a page that is already gone as closable", async () => {
    const { guard } = setup({ leave: false });
    const guest = fakeGuest(true);
    guest.destroyed = true;
    await expect(guard.confirmClose(guest)).resolves.toBe(true);
    expect(guest.loadURL).not.toHaveBeenCalled();
  });
});

describe("BrowserUnloadGuard with CoWork's debugger attached", () => {
  it("asks once: a Stay in the CDP dialog also covers the unload event that follows", () => {
    const { guard, confirmLeave } = setup({ leave: false });
    const guest = fakeGuest(true);
    guard.attach(guest);
    expect(guard.decideDialog(guest)).toBe(false);
    expect(guest.unload()).toBe(false);
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    // The next unload asks again.
    guest.unload();
    expect(confirmLeave).toHaveBeenCalledTimes(2);
  });
});
