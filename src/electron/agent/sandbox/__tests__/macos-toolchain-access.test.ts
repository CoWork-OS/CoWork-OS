import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  macOSToolchainProfileRules,
  resolveMacOSToolchainAccess,
  sanitizeNpmrc,
  stripUrlCredentials,
  writeSanitizedNpmrc,
} from "../macos-toolchain-access";

describe("macOS toolchain access", () => {
  let base: string;
  let home: string;
  let workspace: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-toolchain-")));
    home = path.join(base, "home");
    workspace = path.join(base, "workspace");
    for (const dir of [
      ".cargo/bin",
      ".rustup",
      ".local/bin",
      ".config/git",
      ".config/gcloud",
      ".ssh",
      "tool-data",
      "bin",
    ]) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
    }
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = t\n");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const resolve = (env: NodeJS.ProcessEnv = {}, allowWrites = true) =>
    resolveMacOSToolchainAccess({ homeDir: home, env, workspacePath: workspace, allowWrites });

  it("grants named toolchain locations, never $HOME or a generic cache tree", () => {
    const access = resolve();
    expect(access.readDirs).toEqual(
      expect.arrayContaining([
        path.join(home, ".cargo/bin"),
        path.join(home, ".rustup"),
        path.join(home, ".local/bin"),
        path.join(home, ".config/git"),
      ]),
    );
    expect(access.readFiles).toContain(path.join(home, ".gitconfig"));
    expect(access.writeDirs).toEqual(
      expect.arrayContaining([
        path.join(home, ".npm"),
        path.join(home, "Library/Caches/go-build"),
        path.join(home, ".cache/uv"),
        path.join(home, ".cargo/registry"),
        path.join(home, "go/pkg"),
      ]),
    );
    const everything = [...access.readDirs, ...access.writeDirs];
    for (const broad of [
      home,
      path.join(home, ".cache"),
      path.join(home, "Library"),
      path.join(home, "Library/Caches"),
      path.join(home, ".config"),
      path.join(home, ".cargo"),
    ]) {
      expect(everything).not.toContain(broad);
    }
    // Cargo git checkouts carry .git directories; they are read-only.
    expect(access.writeDirs).not.toContain(path.join(home, ".cargo/git"));
  });

  it("grants no cache writes for a read-only workspace", () => {
    const access = resolve({}, false);
    expect(access.writeDirs).toEqual([]);
    expect(access.writeFiles).toEqual([]);
    expect(access.creatableDirs).toEqual([]);
    expect(access.readDirs).toContain(path.join(home, ".cargo/bin"));
  });

  it("lets a first run create only the missing parents of a cache", () => {
    const access = resolve();
    expect(access.creatableDirs).toEqual(
      expect.arrayContaining([path.join(home, ".cache"), path.join(home, "Library/Caches")]),
    );
    expect(access.creatableDirs).not.toContain(home);
    const rules = macOSToolchainProfileRules(access);
    expect(rules).toMatch(/\(allow file-write-create \(require-all \(vnode-type DIRECTORY\)/);
  });

  it("denies credential stores after every grant", () => {
    const access = resolve({ JAVA_HOME: path.join(home, "tool-data") });
    const rules = macOSToolchainProfileRules(access);
    const lastGrant = Math.max(
      rules.lastIndexOf("(allow file-read*"),
      rules.lastIndexOf("(allow file-write-create"),
    );
    for (const secret of [
      ".ssh",
      ".gnupg",
      ".aws",
      ".config/gcloud",
      ".docker",
      ".netrc",
      ".kube",
      ".npmrc",
      ".git-credentials",
      "Library/Keychains",
      "Library/Application Support/Google/Chrome",
      "Library/Messages",
      "Library/Mail",
    ]) {
      const rule = `(deny file-read* file-write* (subpath "${path.join(home, secret)}"))`;
      expect(rules).toContain(rule);
      expect(rules.indexOf(rule)).toBeGreaterThan(lastGrant);
    }
  });

  it("refuses environment-derived roots that would expose $HOME or a credential store", () => {
    const access = resolve({
      JAVA_HOME: home,
      GOROOT: "/",
      VIRTUAL_ENV: path.join(home, ".config"),
      PYENV_ROOT: path.join(home, ".ssh"),
      CARGO_HOME: path.dirname(home),
      GOCACHE: workspace,
      SSL_CERT_FILE: path.join(home, ".ssh", "id_rsa"),
    });
    for (const rejected of [home, "/", path.join(home, ".config"), path.join(home, ".ssh")]) {
      expect(access.readDirs).not.toContain(rejected);
    }
    expect(access.writeDirs).not.toContain(workspace);
    expect(access.writeDirs).not.toContain(path.join(path.dirname(home), "registry"));
    expect(access.env).toEqual({});
  });

  it("follows valid toolchain relocations and CA bundles", () => {
    const cargoHome = path.join(base, "cargo-home");
    const javaHome = path.join(base, "jdk");
    const caFile = path.join(base, "corp-ca.pem");
    fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
    fs.mkdirSync(javaHome);
    fs.writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n");
    const access = resolve({ CARGO_HOME: cargoHome, JAVA_HOME: javaHome, SSL_CERT_FILE: caFile });
    expect(access.writeDirs).toContain(path.join(cargoHome, "registry"));
    expect(access.readDirs).toEqual(
      expect.arrayContaining([path.join(cargoHome, "bin"), javaHome]),
    );
    expect(access.readFiles).toContain(caFile);
    expect(access.env).toMatchObject({
      CARGO_HOME: cargoHome,
      JAVA_HOME: javaHome,
      SSL_CERT_FILE: caFile,
    });
  });

  it("passes proxy and registry settings without credentials and never passes tokens", () => {
    const access = resolve({
      HTTPS_PROXY: "http://user:secret@proxy.example.com:8080",
      http_proxy: "http://proxy.example.com:3128",
      NO_PROXY: "localhost,.internal",
      PIP_INDEX_URL: "https://token@pypi.example.com/simple",
      ALL_PROXY: "user:pw@proxy:1080",
      GITHUB_TOKEN: "ghp_secret",
      NPM_TOKEN: "npm_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      ANTHROPIC_API_KEY: "sk-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LC_ALL: "en_US.UTF-8",
    });
    expect(access.env).toEqual({
      HTTPS_PROXY: "http://proxy.example.com:8080/",
      http_proxy: "http://proxy.example.com:3128",
      NO_PROXY: "localhost,.internal",
      PIP_INDEX_URL: "https://pypi.example.com/simple",
      LC_ALL: "en_US.UTF-8",
    });
    expect(JSON.stringify(access.env)).not.toMatch(/secret|token@|pw@/);
  });

  it("builds PATH from absolute, existing, readable entries with system directories last", () => {
    const access = resolve({
      PATH: [
        "/usr/bin",
        ".",
        "node_modules/.bin",
        path.join(home, "bin"),
        path.join(home, "tool-data"),
        path.join(home, "missing/bin"),
        "/opt/homebrew/bin",
      ].join(path.delimiter),
    });
    const entries = access.path.split(path.delimiter);
    expect(entries).not.toContain(".");
    expect(entries).not.toContain("node_modules/.bin");
    expect(entries).not.toContain(path.join(home, "missing/bin"));
    // A non-bin directory in $HOME may be a tool's data (and credential) store.
    expect(entries).not.toContain(path.join(home, "tool-data"));
    expect(access.readDirs).not.toContain(path.join(home, "tool-data"));
    expect(entries[0]).toBe(path.join(home, "bin"));
    expect(entries).toContain(path.join(home, ".cargo/bin"));
    expect(entries).toContain(path.join(home, ".local/bin"));
    expect(entries.indexOf("/usr/bin")).toBeGreaterThan(entries.indexOf(path.join(home, "bin")));
    expect(entries.slice(-2)).toEqual(
      ["/usr/sbin", "/sbin"].filter((dir) => fs.existsSync(dir)).slice(-2),
    );
  });

  it("removes credentials from npmrc text and keeps registry and script settings", () => {
    const sanitized = sanitizeNpmrc(
      [
        "registry=https://npm.example.com/",
        "//npm.example.com/:_authToken=abc123",
        "//npm.example.com/:_auth = basic",
        "//npm.example.com/:username=me",
        "//npm.example.com/:_password=cGFzcw==",
        "email=me@example.com",
        "@corp:registry=https://npm.example.com/",
        "ignore-scripts=true",
        "; comment",
      ].join("\n"),
    );
    expect(sanitized).toBe(
      [
        "registry=https://npm.example.com/",
        "@corp:registry=https://npm.example.com/",
        "ignore-scripts=true",
        "; comment",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(home, ".npmrc"), "//r/:_authToken=abc\nfund=false\n");
    const target = writeSanitizedNpmrc(home, {}, base);
    expect(target).toBe(path.join(base, "npmrc"));
    expect(fs.readFileSync(target as string, "utf8")).toBe("fund=false\n");
    expect(writeSanitizedNpmrc(path.join(base, "nobody"), {}, base)).toBeUndefined();
  });

  it("strips URL credentials and drops unparseable credentialed values", () => {
    expect(stripUrlCredentials("http://a:b@h:1")).toBe("http://h:1/");
    expect(stripUrlCredentials("http://h:1")).toBe("http://h:1");
    expect(stripUrlCredentials("a:b@h:1")).toBeUndefined();
    expect(stripUrlCredentials("h:1")).toBe("h:1");
  });
});
