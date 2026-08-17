import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNumbatBinary } from "../NumbatBinaryResolver";

const temporaryRoots: string[] = [];
const originalBinary = process.env.COWORK_NUMBAT_BINARY;
const originalSha256 = process.env.COWORK_NUMBAT_SHA256;
const originalCwd = process.cwd();

function fixtureBinary(mode = 0o700): { path: string; sha256: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "numbat-resolver-test-"));
  temporaryRoots.push(root);
  const binaryPath = path.join(root, process.platform === "win32" ? "numbat.exe" : "numbat");
  fs.writeFileSync(binaryPath, "pinned runtime fixture", { mode });
  if (process.platform !== "win32") fs.chmodSync(binaryPath, mode);
  const sha256 = createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
  return { path: binaryPath, sha256 };
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalBinary === undefined) delete process.env.COWORK_NUMBAT_BINARY;
  else process.env.COWORK_NUMBAT_BINARY = originalBinary;
  if (originalSha256 === undefined) delete process.env.COWORK_NUMBAT_SHA256;
  else process.env.COWORK_NUMBAT_SHA256 = originalSha256;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("NumbatBinaryResolver", () => {
  it("accepts an explicit runtime only when its checksum matches", () => {
    const fixture = fixtureBinary();
    process.env.COWORK_NUMBAT_BINARY = fixture.path;
    process.env.COWORK_NUMBAT_SHA256 = fixture.sha256;

    expect(resolveNumbatBinary()).toEqual(
      expect.objectContaining({
        path: fixture.path,
        sha256: fixture.sha256,
        source: "environment",
      }),
    );
  });

  it("rejects checksum drift", () => {
    const fixture = fixtureBinary();
    process.env.COWORK_NUMBAT_BINARY = fixture.path;
    process.env.COWORK_NUMBAT_SHA256 = "0".repeat(64);

    expect(() => resolveNumbatBinary()).toThrow(
      "Numbat binary checksum does not match the pinned manifest",
    );
  });

  it.skipIf(process.platform === "win32")("rejects writable or symbolic-link runtimes", () => {
    const fixture = fixtureBinary(0o777);
    process.env.COWORK_NUMBAT_BINARY = fixture.path;
    process.env.COWORK_NUMBAT_SHA256 = fixture.sha256;
    expect(() => resolveNumbatBinary()).toThrow("Numbat binary is group- or world-writable");

    const linkPath = `${fixture.path}-link`;
    fs.symlinkSync(fixture.path, linkPath);
    process.env.COWORK_NUMBAT_BINARY = linkPath;
    expect(() => resolveNumbatBinary()).toThrow("Numbat binary must not be a symbolic link");
  });

  it("never resolves a runtime manifest from the active working directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "numbat-untrusted-cwd-"));
    temporaryRoots.push(root);
    const numbatDir = path.join(root, "build", "numbat");
    const binaryDir = path.join(numbatDir, "bin", `${process.platform}-${process.arch}`);
    fs.mkdirSync(binaryDir, { recursive: true });
    const maliciousBinary = path.join(
      binaryDir,
      process.platform === "win32" ? "numbat.exe" : "numbat",
    );
    fs.writeFileSync(maliciousBinary, "untrusted cwd runtime", { mode: 0o700 });
    const sha256 = createHash("sha256").update(fs.readFileSync(maliciousBinary)).digest("hex");
    fs.writeFileSync(
      path.join(numbatDir, "manifest.json"),
      JSON.stringify({
        version: "malicious",
        commit: "malicious",
        schemaVersion: "0.2.0",
        adapterProtocol: "cowork-os/numbat-hook/v1",
        targets: {
          [`${process.platform}-${process.arch}`]: {
            path: path.relative(numbatDir, maliciousBinary),
            sha256,
          },
        },
      }),
    );
    delete process.env.COWORK_NUMBAT_BINARY;
    delete process.env.COWORK_NUMBAT_SHA256;
    process.chdir(root);

    expect(resolveNumbatBinary().path).not.toBe(maliciousBinary);
  });
});
