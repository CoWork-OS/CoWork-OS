import { describe, expect, it } from "vitest";
import { buildSignalCliInvocation } from "../signal-cli-command";

const SEND_ARGS = ["-a", "+15550000000", "--output", "json", "send", "+15551111111"];

function windows(files: string[], env: NodeJS.ProcessEnv = {}) {
  const existing = new Set(files.map((file) => file.toLowerCase()));
  return {
    platform: "win32" as const,
    env: {
      PATH: "C:\\Windows\\System32;C:\\tools\\signal-cli\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      ...env,
    },
    fileExists: (file: string) => existing.has(file.toLowerCase()),
  };
}

describe("buildSignalCliInvocation", () => {
  it("runs signal-cli directly with the argument array on non-Windows platforms", () => {
    const args = [...SEND_ARGS, "-m", '$(touch /tmp/x) "; %PATH% !x!'];
    expect(buildSignalCliInvocation("signal-cli", args, { platform: "darwin" })).toEqual({
      file: "signal-cli",
      args,
    });
  });

  it("runs a Windows .exe directly without cmd.exe", () => {
    const invocation = buildSignalCliInvocation(
      "signal-cli",
      [...SEND_ARGS, "-m", 'hi "there" 100%'],
      windows(["C:\\tools\\signal-cli\\bin\\signal-cli.EXE"]),
    );
    expect(invocation.file).toBe("C:\\tools\\signal-cli\\bin\\signal-cli.EXE");
    expect(invocation.args).toEqual([...SEND_ARGS, "-m", 'hi "there" 100%']);
    expect(invocation.windowsVerbatimArguments).toBeUndefined();
  });

  it("resolves signal-cli.bat on PATH, quotes every argument, and sends the message via stdin", () => {
    const message = 'hello & goodbye | "quoted" 100% done! ^ <x>';
    const invocation = buildSignalCliInvocation(
      "signal-cli",
      [...SEND_ARGS, "-m", message, "-a", "C:\\files\\a.png"],
      windows(["C:\\tools\\signal-cli\\bin\\signal-cli.BAT"]),
    );

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\tools\\signal-cli\\bin\\signal-cli.BAT" "-a" "+15550000000" "--output" "json" "send" "+15551111111" "--message-from-stdin" "-a" "C:\\files\\a.png""',
      ],
      stdin: message,
      windowsVerbatimArguments: true,
    });
  });

  it("treats an explicit .cmd path as a batch file", () => {
    const invocation = buildSignalCliInvocation(
      "C:\\signal\\signal-cli.cmd",
      ["--version"],
      windows([]),
    );
    expect(invocation.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args[3]).toBe('""C:\\signal\\signal-cli.cmd" "--version""');
  });

  it.each([['contains "quotes"'], ["%COMSPEC%"], ["!var!"], ["line\r\nbreak"], ["C:\\dir\\"]])(
    "rejects batch-file arguments outside the message that cmd.exe could interpret: %j",
    (value) => {
      expect(() =>
        buildSignalCliInvocation(
          "signal-cli",
          ["-a", "+15550000000", "sendReaction", value, "-e", "x"],
          windows(["C:\\tools\\signal-cli\\bin\\signal-cli.bat"]),
        ),
      ).toThrow(/cannot be passed safely to a Windows batch file/);
    },
  );
});
