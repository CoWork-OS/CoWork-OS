import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "../ipc-error-message";

describe("ipcErrorMessage", () => {
  it("drops Electron's remote method prefix", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'mailbox:sync': Error: No connected mailbox was found.",
        ),
      ),
    ).toBe("No connected mailbox was found.");
    expect(ipcErrorMessage("Error invoking remote method 'x:y': TypeError: bad input")).toBe(
      "bad input",
    );
  });

  it("keeps other messages as they are", () => {
    expect(ipcErrorMessage("Target email is required.")).toBe("Target email is required.");
    expect(ipcErrorMessage(new Error("Mailbox Ask failed."))).toBe("Mailbox Ask failed.");
  });
});
