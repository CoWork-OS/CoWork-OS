import { Console } from "node:console";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ configureNodeTlsTrust: vi.fn() }));
vi.mock("../node-tls-trust", () => mocks);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function captureConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = (chunks: string[]) =>
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
  vi.stubGlobal("console", new Console({ stdout: output(stdout), stderr: output(stderr) }));
  return { stdout, stderr };
}

describe("early Node TLS diagnostics", () => {
  it.each([
    { result: { status: "configured", addedCertificates: 30 }, diagnostic: "Added 30" },
    { result: { status: "unavailable" }, diagnostic: "Could not load" },
  ])(
    "keeps CLI JSON stdout parseable after $result.status bootstrap",
    async ({ result, diagnostic }) => {
      mocks.configureNodeTlsTrust.mockReturnValue(result);
      const { stdout, stderr } = captureConsole();

      await import("../node-tls-bootstrap");
      console.log(JSON.stringify({ status: "ready" }));

      expect(JSON.parse(stdout.join(""))).toEqual({ status: "ready" });
      expect(stderr.join("")).toContain(diagnostic);
    },
  );

  it("stays silent when trust is already configured or explicitly selected", async () => {
    mocks.configureNodeTlsTrust.mockReturnValue({ status: "unchanged" });
    const { stdout, stderr } = captureConsole();

    await import("../node-tls-bootstrap");

    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});
