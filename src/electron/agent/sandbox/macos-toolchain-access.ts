/**
 * Developer-toolchain access for the macOS seatbelt profile.
 *
 * The process sandbox denies everything below $HOME. Package managers and
 * compilers keep their installs, configuration and download/build caches
 * there, so without targeted grants `npm`, `go build`, `cargo` or `uv` fail
 * before doing any work. This module computes the narrow set of home paths a
 * toolchain needs, the PATH that finds those toolchains, and the
 * non-credential environment they read.
 *
 * Boundaries kept here:
 * - Grants name specific directories and files. Nothing grants $HOME, an
 *   ancestor of it, or a generic tree such as ~/.cache or ~/Library/Caches.
 * - Credential stores are denied after the grants, so a grant derived from
 *   the environment (JAVA_HOME, CARGO_HOME, a PATH entry, ...) cannot expose
 *   them. Explicit user filesystem rules are emitted later in the profile
 *   and still decide for themselves.
 * - Writable caches are writable only when the workspace itself is writable.
 * - Environment passthrough is an allowlist of configuration variables;
 *   tokens, keys and session variables are never copied, and credentials
 *   embedded in proxy or index URLs are removed.
 */

import * as fs from "fs";
import * as path from "path";
import { isAccessPathWithin, isProtectedFilesystemPath } from "../../security/access-profile-paths";
import { collectPolicyPathEntries } from "./policy-paths";
import { escapeSandboxProfileString, validatePathForSandboxProfile } from "./security-utils";

/** Install and configuration locations that toolchains read but never write. */
const HOME_READ_DIRS = [
  ".cargo/bin",
  ".rustup",
  ".nvm",
  ".pyenv",
  ".volta",
  ".asdf",
  ".local/bin",
  ".local/share/uv",
  ".local/share/pnpm",
  ".bun/bin",
  ".deno",
  "go/bin",
  "Library/pnpm",
  ".config/git",
];

const HOME_READ_FILES = [
  ".gitconfig",
  ".gitignore_global",
  ".cargo/env",
  ".cargo/config",
  ".cargo/config.toml",
  ".tool-versions",
  "Library/Application Support/go/env",
];

/**
 * Package download and build caches. These are shared with the user's own,
 * unsandboxed builds, so a sandboxed command can leave cache content that a
 * later build outside the sandbox consumes. That is the same class of risk as
 * writing the workspace's own build scripts and dependencies, and is the
 * accepted cost of toolchains working offline and without re-downloading.
 */
const HOME_WRITE_DIRS = [
  ".npm",
  ".cache/pip",
  ".cache/uv",
  ".cache/pypoetry",
  ".cache/yarn",
  ".cache/pnpm",
  ".cache/node-gyp",
  ".cache/go-build",
  ".cache/typescript",
  ".cache/ms-playwright",
  ".cache/deno",
  "Library/Caches/go-build",
  "Library/Caches/pip",
  "Library/Caches/uv",
  "Library/Caches/pypoetry",
  "Library/Caches/Yarn",
  "Library/Caches/pnpm",
  "Library/Caches/ms-playwright",
  "Library/Caches/node-gyp",
  "Library/Caches/typescript",
  "Library/Caches/CocoaPods",
  "Library/Caches/deno",
  "Library/pnpm/store",
  ".cargo/registry",
  ".gradle/caches",
  ".gradle/wrapper",
  ".gradle/native",
  ".gradle/jdks",
  ".m2/repository",
  ".yarn/berry/cache",
  ".pnpm-store",
  ".local/share/pnpm/store",
  ".bun/install/cache",
  "go/pkg",
];

/**
 * uv drops an empty `.git` file into each cache bucket (sdists-v9/.git) so
 * builds there do not discover an enclosing repository. These caches allow
 * exactly that marker; see macOSFilesystemRestrictions.
 */
const HOME_GIT_MARKER_CACHES = [".cache/uv", "Library/Caches/uv"];

/** Cargo's lock and index files sit directly in CARGO_HOME. */
const CARGO_HOME_WRITE_FILES = [
  ".package-cache",
  ".package-cache-mutate",
  ".global-cache",
  ".global-cache-journal",
  ".global-cache-wal",
  ".global-cache-shm",
];

/**
 * Credential and personal-data stores. Denied for read and write after the
 * toolchain grants so no derived grant can reach them.
 */
const HOME_SECRET_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/op",
  ".config/git/credentials",
  ".docker",
  ".kube",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".vault-token",
  ".password-store",
  ".terraform.d",
  ".cache/huggingface",
  ".local/share/keyrings",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Messages",
  "Library/Mail",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox",
  "Library/Application Support/Arc",
  "Library/Application Support/com.apple.TCC",
];

/** Toolchain bin directories added to PATH when they exist. */
const HOME_PATH_DIRS = [
  ".local/bin",
  ".cargo/bin",
  ".bun/bin",
  ".deno/bin",
  "go/bin",
  ".pyenv/shims",
  ".pyenv/bin",
  ".volta/bin",
  ".asdf/shims",
  "Library/pnpm",
];

const SYSTEM_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** Directories every macOS profile can already read; PATH entries here need no grant. */
const SYSTEM_READABLE_ROOTS = [
  "/usr/bin",
  "/usr/lib",
  "/usr/local",
  "/bin",
  "/System",
  "/opt/homebrew",
  "/Library/Frameworks",
  "/Applications/Xcode.app",
];

/** Plain configuration values copied unchanged. */
const PASSTHROUGH_ENV = [
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "GOFLAGS",
  "GOPRIVATE",
  "GONOPROXY",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOSUMDB",
  "GOTOOLCHAIN",
  "RUSTUP_TOOLCHAIN",
  "PYENV_VERSION",
  "PIP_TRUSTED_HOST",
];

/** URL-valued configuration; any embedded user:password is removed. */
const URL_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "GOPROXY",
  "PIP_INDEX_URL",
  "PIP_EXTRA_INDEX_URL",
  "UV_INDEX_URL",
  "UV_EXTRA_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "NPM_CONFIG_REGISTRY",
  "npm_config_registry",
];

/** Host lists that carry no credentials. */
const NO_PROXY_ENV = ["NO_PROXY", "no_proxy"];

/** CA bundle files: passed through and made readable. */
const CA_FILE_ENV = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "PIP_CERT",
];

const CA_DIR_ENV = ["SSL_CERT_DIR"];

/** Toolchain install roots that are read-only. */
const READ_ROOT_ENV = ["JAVA_HOME", "GOROOT", "VIRTUAL_ENV", "NVM_DIR", "PYENV_ROOT", "VOLTA_HOME"];

export interface MacOSToolchainAccess {
  /** Directories readable recursively. */
  readDirs: string[];
  /** Files readable individually. */
  readFiles: string[];
  /** Cache directories readable and writable recursively. */
  writeDirs: string[];
  /** Caches among writeDirs that keep a `.git` marker file in each top-level bucket. */
  gitMarkerCaches: string[];
  /** Lock and index files readable and writable individually. */
  writeFiles: string[];
  /** Missing parents of cache directories ($HOME/.cache, ...): mkdir only. */
  creatableDirs: string[];
  /** Credential stores denied after every grant above. */
  deniedPaths: string[];
  /** PATH for the sandboxed command; every entry is readable. */
  path: string;
  /** Non-credential toolchain environment for the sandboxed command. */
  env: Record<string, string>;
}

export interface MacOSToolchainAccessInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  workspacePath: string;
  /** Grant cache writes. False for read-only workspaces. */
  allowWrites: boolean;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function exists(candidate: string): boolean {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Seatbelt matches the resolved path; keep the lexical spelling for symlinked prefixes too. */
function spellings(candidate: string): string[] {
  const lexical = path.resolve(candidate);
  try {
    const real = fs.realpathSync.native(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

function isProfileSafePath(candidate: string): boolean {
  try {
    validatePathForSandboxProfile(candidate);
    return path.normalize(candidate) === candidate;
  } catch {
    return false;
  }
}

/**
 * Remove user:password from a URL value. A value that still contains "@"
 * without parsed credentials (`user:pw@proxy:1080` parses as a scheme and a
 * path) is dropped rather than guessed at.
 */
export function stripUrlCredentials(value: string): string | undefined {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url && (url.username || url.password)) {
    url.username = "";
    url.password = "";
    return url.toString();
  }
  return value.includes("@") ? undefined : value;
}

/**
 * Lines of an npmrc that carry credentials: tokens, basic auth, client
 * certificates and the identity fields npm sends with them.
 */
const NPMRC_CREDENTIAL_KEY =
  /(^|:)(_authtoken|_auth|_password|password|username|email|certfile|keyfile|cert|key|token)$/i;

/** Return the npmrc text without credential lines. */
export function sanitizeNpmrc(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return true;
      const separator = trimmed.indexOf("=");
      const key = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
      return !NPMRC_CREDENTIAL_KEY.test(key);
    })
    .join("\n");
}

/**
 * Copy the user's npmrc without credentials into `targetDir` and return its
 * path. Registry, proxy, prefix and script settings (`ignore-scripts`) keep
 * applying inside the sandbox; auth tokens never enter it, so installs from a
 * registry that requires authentication fail there instead of leaking a token.
 */
export function writeSanitizedNpmrc(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  targetDir: string,
): string | undefined {
  const source =
    env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || path.join(homeDir, ".npmrc");
  let content: string;
  try {
    content = fs.readFileSync(source, "utf8");
  } catch {
    return undefined;
  }
  const target = path.join(targetDir, "npmrc");
  fs.writeFileSync(target, sanitizeNpmrc(content), { mode: 0o600 });
  return target;
}

export function resolveMacOSToolchainAccess(
  input: MacOSToolchainAccessInput,
): MacOSToolchainAccess {
  const home = path.resolve(input.homeDir);
  const env = input.env;
  const npmrcSource = env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig;
  const deniedPaths = [
    ...new Set([
      ...HOME_SECRET_PATHS.map((relative) => path.join(home, relative)),
      ...(npmrcSource && path.isAbsolute(npmrcSource) ? [path.resolve(npmrcSource)] : []),
    ]),
  ];

  // Built-in locations may contain a denied entry (~/.config/git holds the
  // credential store's file); the denial emitted after the grant covers it.
  // A location derived from the environment must not contain one at all, so
  // a variable such as JAVA_HOME=~/.config cannot open a credential tree.
  let builtin = false;
  const isSecret = (candidate: string): boolean =>
    deniedPaths.some(
      (denied) =>
        isAccessPathWithin(denied, candidate) ||
        (!builtin && isAccessPathWithin(candidate, denied)),
    );
  // A grant on $HOME, an ancestor of it, or the filesystem root would expose
  // every unlisted file in the home directory.
  const isBroad = (candidate: string): boolean =>
    candidate === path.parse(candidate).root || isAccessPathWithin(candidate, home);
  const acceptableRead = (candidate: string | undefined): candidate is string =>
    !!candidate &&
    path.isAbsolute(candidate) &&
    isProfileSafePath(path.resolve(candidate)) &&
    !isBroad(path.resolve(candidate)) &&
    !isSecret(path.resolve(candidate));
  const acceptableWrite = (candidate: string | undefined): candidate is string =>
    acceptableRead(candidate) &&
    !isProtectedFilesystemPath(path.resolve(candidate)) &&
    !isAccessPathWithin(path.resolve(candidate), input.workspacePath);

  const readDirs = new Set<string>();
  const readFiles = new Set<string>();
  const writeDirs = new Set<string>();
  const writeFiles = new Set<string>();
  const toolEnv: Record<string, string> = {};

  const addReadDir = (candidate: string | undefined): boolean => {
    if (!acceptableRead(candidate) || !isDirectory(candidate)) return false;
    const resolved = spellings(candidate);
    if (!resolved.every((spelling) => acceptableRead(spelling))) return false;
    for (const spelling of resolved) readDirs.add(spelling);
    return true;
  };
  const addReadFile = (candidate: string | undefined): boolean => {
    if (!acceptableRead(candidate) || !exists(candidate) || isDirectory(candidate)) return false;
    const resolved = spellings(candidate);
    if (!resolved.every((spelling) => acceptableRead(spelling))) return false;
    for (const spelling of resolved) readFiles.add(spelling);
    return true;
  };
  // Cache directories are granted even before they exist so a first run can
  // create them; their parents are existing, non-writable directories.
  const addWriteDir = (candidate: string | undefined): boolean => {
    if (!input.allowWrites || !acceptableWrite(candidate)) return false;
    const resolved = spellings(candidate);
    if (!resolved.every((spelling) => acceptableWrite(spelling))) return false;
    for (const spelling of resolved) writeDirs.add(spelling);
    return true;
  };

  builtin = true;
  for (const relative of HOME_READ_DIRS) addReadDir(path.join(home, relative));
  for (const relative of HOME_READ_FILES) addReadFile(path.join(home, relative));
  for (const relative of HOME_WRITE_DIRS) addWriteDir(path.join(home, relative));
  builtin = false;
  const gitMarkerCaches = new Set<string>();
  for (const relative of HOME_GIT_MARKER_CACHES) {
    for (const spelling of spellings(path.join(home, relative))) {
      if (writeDirs.has(spelling)) gitMarkerCaches.add(spelling);
    }
  }

  // Environment overrides relocate a toolchain; follow them only when the
  // location passes the same checks as the defaults.
  const cargoHome = env.CARGO_HOME && acceptableWrite(env.CARGO_HOME) ? env.CARGO_HOME : undefined;
  const cargoRoot = cargoHome || path.join(home, ".cargo");
  if (cargoHome) toolEnv.CARGO_HOME = cargoHome;
  // The ~/.cargo grants above cover the default location; repeat them for an
  // overridden CARGO_HOME.
  addReadDir(path.join(cargoRoot, "bin"));
  addReadFile(path.join(cargoRoot, "config.toml"));
  addReadFile(path.join(cargoRoot, "config"));
  addReadFile(path.join(cargoRoot, "env"));
  addWriteDir(path.join(cargoRoot, "registry"));
  // Cargo clones git dependencies as ordinary checkouts with a `.git`
  // directory. Every writable cache denies protected names so it cannot stage
  // a repository for the workspace (by a move or a symlink), which would
  // break those checkouts; already-fetched git dependencies stay readable.
  addReadDir(path.join(cargoRoot, "git"));
  if (input.allowWrites && acceptableWrite(path.join(cargoRoot, ".package-cache"))) {
    for (const file of CARGO_HOME_WRITE_FILES) writeFiles.add(path.join(cargoRoot, file));
  }
  if (env.RUSTUP_HOME && addReadDir(env.RUSTUP_HOME)) toolEnv.RUSTUP_HOME = env.RUSTUP_HOME;

  // Only GOPATH's module cache and bin directory are granted, so a GOPATH
  // that contains the workspace or other projects (GOPATH=~/src) is fine.
  const gopath = env.GOPATH?.split(path.delimiter).find(Boolean);
  if (gopath && path.isAbsolute(gopath)) {
    const pkg = addWriteDir(path.join(gopath, "pkg"));
    const bin = addReadDir(path.join(gopath, "bin"));
    if (pkg || bin) toolEnv.GOPATH = env.GOPATH as string;
  }
  for (const key of ["GOMODCACHE", "GOCACHE", "DENO_DIR"]) {
    if (addWriteDir(env[key])) toolEnv[key] = env[key] as string;
  }
  for (const key of READ_ROOT_ENV) {
    if (addReadDir(env[key])) toolEnv[key] = env[key] as string;
  }
  if (env.NVM_BIN && addReadDir(env.NVM_BIN)) toolEnv.NVM_BIN = env.NVM_BIN;
  for (const key of ["BUN_INSTALL", "PNPM_HOME"]) {
    const value = env[key];
    if (value && addReadDir(key === "BUN_INSTALL" ? path.join(value, "bin") : value)) {
      toolEnv[key] = value;
    }
  }
  const npmPrefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  if (npmPrefix && addReadDir(npmPrefix)) toolEnv.NPM_CONFIG_PREFIX = npmPrefix;

  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (value) toolEnv[key] = value;
  }
  for (const key of URL_ENV) {
    const value = env[key] && stripUrlCredentials(env[key] as string);
    if (value) toolEnv[key] = value;
  }
  for (const key of NO_PROXY_ENV) {
    const value = env[key];
    if (value && !value.includes("@")) toolEnv[key] = value;
  }
  for (const key of CA_FILE_ENV) {
    if (addReadFile(env[key])) toolEnv[key] = env[key] as string;
  }
  for (const key of CA_DIR_ENV) {
    if (addReadDir(env[key])) toolEnv[key] = env[key] as string;
  }

  // PATH: the user's own entries first (their ordering decides which
  // toolchain wins), then known toolchain locations, then system defaults.
  // Only absolute, existing, readable directories are kept, so PATH never
  // resolves into the workspace by a relative entry or into a denied tree.
  const systemDefaults = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  const inherited = String(env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !systemDefaults.has(entry));
  const nvmFallback = env.NVM_BIN ? [] : [latestNvmBin(env.NVM_DIR || path.join(home, ".nvm"))];
  const candidates = [
    ...inherited,
    ...HOME_PATH_DIRS.map((relative) => path.join(home, relative)),
    ...(env.NVM_BIN ? [env.NVM_BIN] : nvmFallback.filter((entry): entry is string => !!entry)),
    ...SYSTEM_PATH_DIRS,
  ];
  const pathEntries: string[] = [];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (pathEntries.includes(resolved) || !isDirectory(resolved)) continue;
    // Lexical comparison: a symlinked entry such as /Library/TeX/texbin
    // resolves into /usr/local, but the link itself still needs a grant.
    if (SYSTEM_READABLE_ROOTS.some((root) => isLexicallyWithin(root, resolved))) {
      pathEntries.push(resolved);
      continue;
    }
    // Inside $HOME only bin-style directories become readable: an arbitrary
    // PATH entry such as a tool's data directory may hold its credentials.
    const insideHome = isAccessPathWithin(home, resolved);
    const binLike = /^(s?bin|shims)$/.test(path.basename(resolved));
    const knownHomeDir = HOME_PATH_DIRS.some((relative) => path.join(home, relative) === resolved);
    if (insideHome && !binLike && !knownHomeDir) continue;
    if (addReadDir(resolved) || [...readDirs].some((dir) => isAccessPathWithin(dir, resolved))) {
      pathEntries.push(resolved);
      // npm-style prefixes link bin entries to ../lib/node_modules.
      if (insideHome && binLike)
        addReadDir(path.join(path.dirname(resolved), "lib", "node_modules"));
    }
  }

  // A first run may need to create the parent of a cache (uv uses
  // ~/.cache/uv and ~/.cache may not exist yet). Only directories, only the
  // missing links between $HOME and a granted cache, and nothing inside them
  // beyond the cache itself.
  const creatableDirs = new Set<string>();
  for (const dir of [...writeDirs, ...writeFiles]) {
    if (!isLexicallyWithin(home, dir)) continue;
    let parent = path.dirname(dir);
    while (parent !== home && isLexicallyWithin(home, parent)) {
      creatableDirs.add(parent);
      parent = path.dirname(parent);
    }
  }

  return {
    readDirs: [...readDirs],
    readFiles: [...readFiles],
    writeDirs: [...writeDirs],
    gitMarkerCaches: [...gitMarkerCaches],
    writeFiles: [...writeFiles],
    creatableDirs: [...creatableDirs],
    deniedPaths,
    path: pathEntries.join(path.delimiter),
    env: toolEnv,
  };
}

function isLexicallyWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Newest installed nvm Node version's bin directory, when nvm is present. */
function latestNvmBin(nvmDir: string): string | undefined {
  const versionsDir = path.join(nvmDir, "versions", "node");
  let versions: string[];
  try {
    versions = fs.readdirSync(versionsDir).filter((entry) => /^v\d+\.\d+\.\d+$/.test(entry));
  } catch {
    return undefined;
  }
  const numeric = (version: string): number[] => version.slice(1).split(".").map(Number);
  versions.sort((a, b) => {
    const [left, right] = [numeric(a), numeric(b)];
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
  });
  return versions[0] ? path.join(versionsDir, versions[0], "bin") : undefined;
}

/**
 * Entries that must be stat-able to reach a granted path: `mkdir -p` and
 * realpath stat every ancestor, and seatbelt checks each symlink a lookup
 * follows (~/.local/bin/node -> /opt/homebrew/..., /Library/TeX/texbin ->
 * ...). Metadata only; listing or reading those directories stays denied.
 */
function traversalEntries(paths: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const target of paths) {
    let current = path.dirname(target);
    while (current !== path.parse(current).root) {
      entries.add(current);
      current = path.dirname(current);
    }
    try {
      for (const entry of collectPolicyPathEntries(path.parse(target).root, [target])) {
        entries.add(entry);
      }
    } catch {
      // A link loop leaves the lexical ancestors above; the grant then fails closed.
    }
  }
  return [...entries].filter((entry) => isProfileSafePath(entry));
}

const quote = (value: string): string => `"${escapeSandboxProfileString(value)}"`;

/** Seatbelt rules granting toolchain access, followed by the credential denials. */
export function macOSToolchainProfileRules(access: MacOSToolchainAccess): string {
  const granted = [
    ...access.readDirs,
    ...access.readFiles,
    ...access.writeDirs,
    ...access.writeFiles,
  ];
  let rules = "\n; Developer toolchains: installs and configuration (read-only)\n";
  const ancestors = traversalEntries(granted);
  if (ancestors.length) {
    rules += `(allow file-read-metadata\n${ancestors.map((entry) => `  (literal ${quote(entry)})`).join("\n")}\n)\n`;
  }
  const readFilters = [
    ...access.readDirs.map((dir) => `  (subpath ${quote(dir)})`),
    ...access.readFiles.map((file) => `  (literal ${quote(file)})`),
  ];
  if (readFilters.length) rules += `(allow file-read*\n${readFilters.join("\n")}\n)\n`;
  const writeFilters = [
    ...access.writeDirs.map((dir) => `  (subpath ${quote(dir)})`),
    ...access.writeFiles.map((file) => `  (literal ${quote(file)})`),
  ];
  if (writeFilters.length) {
    rules += "; Package download and build caches (read-write)\n";
    rules += `(allow file-read* file-write*\n${writeFilters.join("\n")}\n)\n`;
  }
  if (access.creatableDirs.length) {
    const parents = access.creatableDirs.map((dir) => `(literal ${quote(dir)})`).join(" ");
    rules += `(allow file-write-create (require-all (vnode-type DIRECTORY) (require-any ${parents})))\n`;
  }
  rules += "; Credential stores stay denied even under a broader grant above\n";
  for (const denied of access.deniedPaths) {
    rules += `(deny file-read* file-write* (subpath ${quote(denied)}))\n`;
  }
  return rules;
}
