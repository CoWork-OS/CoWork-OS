import { afterEach, describe, expect, it, vi } from "vitest";
import { managedAccountsAvailable } from "../ManagedAccountsPanel";

const methods = {
  listManagedAccounts: async () => ({ accounts: [] }),
  upsertManagedAccount: async () => ({ account: {} }),
  removeManagedAccount: async () => ({ removed: true }),
};

describe("managedAccountsAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false in the desktop app, whose preload has no managed-account methods", () => {
    vi.stubGlobal("window", { electronAPI: { listTasks: async () => [] } });
    expect(managedAccountsAvailable()).toBe(false);
  });

  it("is true when the bridge has all three methods", () => {
    vi.stubGlobal("window", { electronAPI: { ...methods } });
    expect(managedAccountsAvailable()).toBe(true);
  });

  it("is false in a browser session whose host does not list the methods", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: {} },
      electronAPI: { ...methods },
    });
    expect(managedAccountsAvailable()).toBe(false);
  });

  it("is true in a browser session whose host lists them", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: {
        desktopMethods: {
          listManagedAccounts: {},
          upsertManagedAccount: {},
          removeManagedAccount: {},
        },
      },
      electronAPI: { ...methods },
    });
    expect(managedAccountsAvailable()).toBe(true);
  });
});
