import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignalClient } from "../signal-client";

// Runs a fake signal-cli that echoes its argv as JSON, so the test checks the
// exact arguments the real binary would receive and that no shell ran.
describe.skipIf(process.platform === "win32")("SignalClient command execution", () => {
  let dir: string;
  let cliPath: string;
  let marker: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-client-test-"));
    cliPath = path.join(dir, "fake-signal-cli");
    marker = path.join(dir, "pwned");
    fs.writeFileSync(
      cliPath,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes shell metacharacters in messages through literally without executing them", async () => {
    const client = new SignalClient({ phoneNumber: "+15550000000", cliPath, dataDir: dir });
    const payloads = [
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `"; touch ${marker}; echo "`,
      `\\"; touch ${marker} #`,
    ];

    for (const message of payloads) {
      const run = (client as unknown as { execCommand(args: string[]): Promise<string> })
        .execCommand;
      const output = await run.call(client, ["send", "+15551111111", "-m", message]);
      expect(JSON.parse(output).argv).toEqual(["send", "+15551111111", "-m", message]);
    }

    await client.sendMessage("+15551111111", `$(touch ${marker})`);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
