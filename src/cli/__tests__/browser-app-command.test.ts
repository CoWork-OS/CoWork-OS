import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../control-plane-client";
import {
  formatBrowserAppStatus,
  linkLifetime,
  openSignInLinkPrivately,
  parseSignInLink,
} from "../browser-app-command";
import { main } from "../main";

afterEach(() => {
  vi.restoreAllMocks();
});

const LINK = {
  url: "http://127.0.0.1:18789/app/#pair=abcdefghijklmnopqrstuvwxyz",
  appUrl: "http://127.0.0.1:18789/app/",
  expiresAt: Date.now() + 90_000,
};

function fakeSpawn(exitCode = 0) {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const spawnProcess = vi.fn((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    const call = { command, args, stdin: "" };
    calls.push(call);
    child.stdin.on("data", (chunk: Buffer) => (call.stdin += chunk.toString()));
    child.stdin.on("finish", () => setImmediate(() => child.emit("exit", exitCode)));
    if (command !== "osascript") setImmediate(() => child.emit("exit", exitCode));
    return child;
  });
  return {
    calls,
    spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
  };
}

describe("cowork web helpers", () => {
  it("opens the link on macOS through osascript's stdin, never its arguments", async () => {
    const { calls, spawnProcess } = fakeSpawn();
    await expect(openSignInLinkPrivately(LINK.url, "darwin", spawnProcess)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("osascript");
    expect(calls[0].args).toEqual(["-"]);
    expect(calls[0].args.join(" ")).not.toContain("pair=");
    expect(calls[0].stdin).toBe(`open location "${LINK.url}"\n`);
  });

  it("opens the link on Windows and prints it elsewhere", async () => {
    const windows = fakeSpawn();
    await expect(openSignInLinkPrivately(LINK.url, "win32", windows.spawnProcess)).resolves.toBe(
      true,
    );
    expect(windows.calls[0]).toMatchObject({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", LINK.url],
    });

    const linux = fakeSpawn();
    await expect(openSignInLinkPrivately(LINK.url, "linux", linux.spawnProcess)).resolves.toBe(
      false,
    );
    expect(linux.calls).toHaveLength(0);
  });

  it("reports a failed opener", async () => {
    const { spawnProcess } = fakeSpawn(1);
    await expect(openSignInLinkPrivately(LINK.url, "darwin", spawnProcess)).resolves.toBe(false);
  });

  it("checks the host's reply and describes the link's lifetime", () => {
    expect(parseSignInLink(LINK)).toEqual(LINK);
    expect(() => parseSignInLink({ code: "abc" })).toThrow("did not return a sign-in link");
    expect(linkLifetime(10_000, 0)).toBe("It works once, for the next 10 seconds.");
  });

  it("formats status for the app on and off", () => {
    expect(formatBrowserAppStatus({ enabled: false, remote: false, signedInBrowsers: 0 })[0]).toBe(
      "Browser app: off",
    );
    expect(
      formatBrowserAppStatus({
        enabled: true,
        appUrl: LINK.appUrl,
        remote: true,
        signedInBrowsers: 1,
      }),
    ).toEqual([
      "Browser app: on",
      `Address: ${LINK.appUrl}`,
      "Reach: this computer and other devices, through HTTPS",
      "Signed in: 1 browser",
    ]);
  });
});

describe("cowork web", () => {
  function stubClient(reply: unknown) {
    vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
    const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue(reply);
    vi.spyOn(ControlPlaneClient.prototype, "close").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return { request, stdout, stderr };
  }

  it("prints only the link on stdout for `link`", async () => {
    const { request, stdout, stderr } = stubClient(LINK);
    expect(await main(["web", "link", "--token", "test-token"])).toBe(0);
    expect(request).toHaveBeenCalledWith("web.signInLink");
    expect(stdout).toHaveBeenCalledWith(`${LINK.url}\n`);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("works once");
  });

  it("asks the host to sign every browser out", async () => {
    const { request, stdout } = stubClient({ signedOut: 2 });
    expect(await main(["web", "sign-out", "--token", "test-token"])).toBe(0);
    expect(request).toHaveBeenCalledWith("web.signOut");
    expect(stdout).toHaveBeenCalledWith("Signed out 2 browsers.\n");
  });

  it("shows status", async () => {
    const { request, stdout } = stubClient({ enabled: false, remote: false, signedInBrowsers: 0 });
    expect(await main(["web", "status", "--token", "test-token"])).toBe(0);
    expect(request).toHaveBeenCalledWith("web.status");
    expect(String(stdout.mock.calls[0]?.[0])).toContain("Browser app: off");
  });

  it("rejects an unknown subcommand", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["web", "share", "--token", "test-token"])).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Usage: cowork web");
  });
});
