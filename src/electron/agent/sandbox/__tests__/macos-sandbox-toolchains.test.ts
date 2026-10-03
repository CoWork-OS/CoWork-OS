import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

const hasNpm = (() => {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ENV_KEYS = [
  "HOME",
  "PATH",
  "HTTPS_PROXY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "SSL_CERT_FILE",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "npm_config_cache",
];

// Runs real sandbox-exec processes against a temporary home directory laid
// out like a developer machine, so the user's own caches are never touched.
describe.skipIf(process.platform !== "darwin")("macOS sandbox developer toolchains", () => {
  let base: string;
  let home: string;
  let workspace: Workspace;
  let savedEnv: Record<string, string | undefined>;
  const sandboxes: MacOSSandbox[] = [];

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-toolchains-")));
    home = path.join(base, "home");
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    for (const dir of [".cargo/bin", ".ssh", ".aws", "Library/Caches", "Library/Keychains"]) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
    fs.writeFileSync(path.join(home, ".aws", "credentials"), "aws_secret_access_key=x");
    fs.writeFileSync(path.join(home, ".netrc"), "machine h login u password p");
    fs.writeFileSync(
      path.join(home, ".npmrc"),
      "registry=https://registry.example.com/\n//registry.example.com/:_authToken=NPM-SECRET\nfund=false\n",
    );
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Sandbox Test\n");
    const fakeCargo = path.join(home, ".cargo", "bin", "fake-cargo");
    fs.writeFileSync(fakeCargo, "#!/bin/sh\necho fake-cargo-ran\n");
    fs.chmodSync(fakeCargo, 0o755);

    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = home;
    // What an app launched from the Dock inherits.
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    process.env.HTTPS_PROXY = "http://proxyuser:proxy-secret@proxy.example.com:3128";
    process.env.GITHUB_TOKEN = "ghp_should_not_pass";
    process.env.NPM_TOKEN = "npm_should_not_pass";

    workspace = {
      id: "sandbox-toolchains",
      name: "Sandbox toolchains",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  const run = async (command: string) => {
    const sandbox = new MacOSSandbox(workspace);
    sandboxes.push(sandbox);
    return sandbox.execute(command, [], { cwd: workspace.path, timeout: 60_000 });
  };

  it("writes package caches under $HOME, including ones that do not exist yet", async () => {
    const result = await run(
      [
        'mkdir -p "$HOME/.npm/_cacache" && echo ok > "$HOME/.npm/_cacache/probe"',
        'mkdir -p "$HOME/Library/Caches/go-build/00" && echo ok > "$HOME/Library/Caches/go-build/00/probe"',
        'mkdir -p "$HOME/.cache/uv/sdists-v9" && : > "$HOME/.cache/uv/sdists-v9/.git"',
        'mkdir -p "$HOME/.cargo/registry/index" && : > "$HOME/.cargo/.package-cache"',
      ].join(" && "),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, ".npm/_cacache/probe"), "utf8")).toBe("ok\n");
    expect(fs.existsSync(path.join(home, "Library/Caches/go-build/00/probe"))).toBe(true);
  });

  it.skipIf(!hasNpm)("runs npm against its cache and a credential-free npmrc", async () => {
    const result = await run(
      'npm config get cache && npm config get registry && npm cache verify >/dev/null && cat "$NPM_CONFIG_USERCONFIG"',
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(path.join(home, ".npm"));
    expect(result.stdout).toContain("https://registry.example.com/");
    expect(result.stdout).toContain("fund=false");
    expect(result.stdout).not.toContain("NPM-SECRET");
    expect(fs.existsSync(path.join(home, ".npm/_cacache"))).toBe(true);
  });

  it("keeps credential stores and the rest of $HOME unreadable", async () => {
    for (const command of [
      'cat "$HOME/.ssh/id_ed25519"',
      'cat "$HOME/.aws/credentials"',
      'cat "$HOME/.netrc"',
      'cat "$HOME/.npmrc"',
      'ls "$HOME"',
      'ls "$HOME/Library/Caches"',
      'echo x > "$HOME/.ssh/authorized_keys"',
      'echo x > "$HOME/.zshrc"',
      'echo x > "$HOME/.cache/stray"',
      'ls "$HOME/Library/Keychains"',
    ]) {
      const result = await run(command);
      expect(result.exitCode, command).not.toBe(0);
    }
    expect(fs.existsSync(path.join(home, ".zshrc"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".ssh/authorized_keys"))).toBe(false);
  });

  it("finds toolchains installed under $HOME and reads git and TLS configuration", async () => {
    const result = await run(
      "fake-cargo && cat ~/.gitconfig >/dev/null && cat /private/etc/ssl/openssl.cnf >/dev/null && /usr/bin/curl -sS -o /dev/null file:///private/etc/hosts && echo all-ok",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("fake-cargo-ran");
    expect(result.stdout).toContain("all-ok");
  });

  it("passes proxy settings without credentials and never passes tokens", async () => {
    const result = await run("env");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("HTTPS_PROXY=http://proxy.example.com:3128/");
    expect(result.stdout).not.toContain("proxy-secret");
    expect(result.stdout).not.toContain("GITHUB_TOKEN");
    expect(result.stdout).not.toContain("NPM_TOKEN");
    expect(result.stdout).toMatch(new RegExp(`PATH=[^\\n]*${home}/\\.cargo/bin`));
  });

  it("keeps caches from staging a git repository for the workspace", async () => {
    for (const command of [
      'mkdir -p "$HOME/.npm/stage/.git"',
      'mkdir -p "$HOME/.npm/stage" && : > "$HOME/.npm/stage/.git"',
      'mkdir -p "$HOME/.cache/uv/.tmpabc" && : > "$HOME/.cache/uv/.tmpabc/.git"',
      'mkdir -p "$HOME/.cache/uv/sdists-v9/x/.git"',
      'mkdir -p "$HOME/.cache/uv/sdists-v9" && mv "$HOME/.cache/uv/sdists-v9" ./bucket',
      'mkdir -p "$HOME/.npm" && mv "$HOME/.npm" ./whole-cache',
      'mkdir -p "$HOME/.cache/uv/archive-v0/x" && ln -s /tmp "$HOME/.cache/uv/archive-v0/x/.git"',
    ]) {
      const result = await run(command);
      expect(result.exitCode, command).not.toBe(0);
    }
    expect(fs.existsSync(path.join(workspace.path, "bucket"))).toBe(false);
    expect(fs.existsSync(path.join(workspace.path, "whole-cache"))).toBe(false);
    // Ordinary staging still works: uv extracts into .tmpXXXX and renames it.
    const staging = await run(
      'mkdir -p "$HOME/.cache/uv/.tmpabc/pkg" "$HOME/.cache/uv/archive-v0" && mv "$HOME/.cache/uv/.tmpabc" "$HOME/.cache/uv/archive-v0/abc"',
    );
    expect(staging.exitCode, staging.stderr).toBe(0);
  });

  it("grants no cache writes to a read-only workspace", async () => {
    workspace.permissions.write = false;
    workspace.permissions.accessSandboxMode = "read-only";
    const result = await run('mkdir -p "$HOME/.npm/_cacache"');
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(home, ".npm"))).toBe(false);
    const read = await run("fake-cargo");
    expect(read.exitCode, read.stderr).toBe(0);
  });
});
