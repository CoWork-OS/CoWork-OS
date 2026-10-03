/**
 * Conservative classifier for commands that can initiate network egress.
 *
 * This is intentionally a boundary classifier, not a shell parser. A false
 * positive causes an approval prompt, or blocks the command where shell
 * networking is disabled; a false negative would let a command bypass a
 * profile's network policy. Commands that are not recognized remain subject to
 * the normal shell approval and sandbox controls.
 *
 * Arguments that are only data to a command are masked before matching:
 * payloads written to local files, the search patterns of grep-like tools, and
 * git messages and history searches. Network library names (fetch, requests,
 * socket, ...) count only in code a command runs: inline interpreter code
 * (`python -c`, `node -e`, ...), a program piped or redirected into an
 * interpreter or shell, and the names of the scripts, package scripts and make
 * targets it runs. A command that cannot be tokenized is matched as a whole.
 */

// A command name starts the text or follows whitespace, a shell operator, a
// quote (`sh -c "curl …"`), a backtick or a backslash, and ends the same way.
const NETWORK_COMMAND_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|()`'"\\])(?:curl|wget|httpie|aria2c|axel|ftp|sftp|scp|ssh|telnet|nc|netcat)(?=$|[\s;&|()`'"])/i,
  /(?:^|[\s;&|()`'"\\])git\s+(?:clone|fetch|pull|push|ls-remote|submodule)(?=$|[\s;&|()`'"])/i,
  /(?:^|[\s;&|()`'"\\])(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|publish|pack|view|search|outdated)(?=$|[\s;&|()`'"])/i,
  /(?:^|[\s;&|()`'"\\])(?:pip|pip3)\s+(?:install|download|index)(?=$|[\s;&|()`'"])/i,
  /(?:^|[\s;&|()`'"\\])(?:cargo|go)\s+(?:install|get)(?=$|[\s;&|()`'"])/i,
  // Package installs that used to be caught only when a package shared a
  // network library's name (`poetry add requests`).
  /(?:^|[\s;&|()`'"\\])(?:poetry\s+(?:add|install|update)|pipenv\s+(?:install|update|sync)|uv\s+(?:add|sync)|(?:conda|mamba|micromamba)\s+(?:install|create|update)|deno\s+(?:add|install))(?=$|[\s;&|()`'"])/i,
  // Bash network redirections such as `exec 3<>/dev/tcp/host/80`.
  /\/dev\/(?:tcp|udp)\//i,
  /\b(?:resolvectl|nslookup|dig|host)\b/i,
];

const NETWORK_LIBRARY_PATTERN =
  /\b(?:fetch|axios|urllib|requests|socket|http\.client|net\.http)\b/i;
// Captures the authority (host, port and any userinfo) of each http(s) URL.
const URL_AUTHORITY_PATTERN = /\bhttps?:\/\/([^\s/?#'"`]*)/gi;
const LOOPBACK_AUTHORITY_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d*)?$/i;
const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "httpie",
  "aria2c",
  "axel",
  "ftp",
  "sftp",
  "scp",
  "ssh",
  "telnet",
  "nc",
  "netcat",
]);
const GIT_NETWORK_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "submodule",
]);
const GIT_MESSAGE_SUBCOMMANDS = new Set(["commit", "tag", "merge", "stash", "notes"]);
const GIT_HISTORY_SEARCH_SUBCOMMANDS = new Set(["log", "show", "whatchanged"]);
const GIT_GLOBAL_ARG_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "exec",
  "builtin",
  "timeout",
  "stdbuf",
  "xargs",
]);
const DATA_ARGUMENT_PLACEHOLDER = "DATA_ARGUMENT";
// Commands that can change what `grep` or `git` resolves to.
const COMMAND_REDEFINERS = new Set(["alias", "function", "hash", "eval", "source", ".", "enable"]);
// Commands that run code named by an operand: a package script or binary, a
// program run through a runner (`uv run`, `go run`), a make target, a Java
// class or a sourced file.
const SCRIPT_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "uv",
  "uvx",
  "pipx",
  "poetry",
  "pdm",
  "hatch",
  "go",
  "dotnet",
  "swift",
  "make",
  "just",
  "java",
  "rscript",
  "watch",
  "source",
  ".",
]);
// Runners whose every operand names code to run (targets, class and script paths).
const ALL_OPERAND_RUNNERS = new Set(["make", "just", "java", "rscript"]);

const GREP_ARG_OPTIONS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-f",
  "-d",
  "-D",
  // git grep: -O runs a pager command, so its value must stay visible.
  "-O",
  "--open-files-in-pager",
  "--max-depth",
  "--threads",
  "--file",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--context",
  "--after-context",
  "--before-context",
  "--max-count",
  "--label",
]);
const RG_ARG_OPTIONS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-f",
  "-g",
  "-t",
  "-T",
  "-j",
  "-M",
  "-r",
  "-E",
  "--file",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--type-add",
  "--threads",
  "--max-count",
  "--max-columns",
  "--replace",
  "--encoding",
  "--max-depth",
  "--pre",
  "--pre-glob",
  "--sort",
  "--sortr",
  "--context",
  "--after-context",
  "--before-context",
  "--ignore-file",
  "--max-filesize",
  "--engine",
]);
const AG_ARG_OPTIONS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-G",
  "-g",
  "-p",
  "--ignore",
  "--ignore-dir",
  "--depth",
  "--file-search-regex",
  "--after",
  "--before",
  "--context",
  "--max-count",
  "--pager",
  "--path-to-ignore",
  "--workers",
]);
const ACK_ARG_OPTIONS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "--type",
  "--ignore-dir",
  "--ignore-file",
  "--output",
  "--context",
  "--after-context",
  "--before-context",
  "--max-count",
  "--pager",
]);
const SEARCH_TOOL_ARG_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["grep", GREP_ARG_OPTIONS],
  ["egrep", GREP_ARG_OPTIONS],
  ["fgrep", GREP_ARG_OPTIONS],
  ["zgrep", GREP_ARG_OPTIONS],
  ["rg", RG_ARG_OPTIONS],
  ["ag", AG_ARG_OPTIONS],
  ["ack", ACK_ARG_OPTIONS],
  ["ack-grep", ACK_ARG_OPTIONS],
]);

type InterpreterFamily = "python" | "node" | "bun" | "deno" | "ruby" | "perl" | "php" | "shell";

// Interpreter options whose value is a separate argument, not a script path.
const INTERPRETER_ARG_OPTIONS: Record<InterpreterFamily, ReadonlySet<string>> = {
  python: new Set(["-W", "-X", "-Q"]),
  node: new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "-C",
    "--conditions",
    "--input-type",
    "--env-file",
    "--title",
  ]),
  bun: new Set(["-r", "--preload", "--cwd", "--env-file", "-c", "--config"]),
  deno: new Set(["-c", "--config", "--import-map", "--lock", "--cert"]),
  ruby: new Set(["-I", "-r", "-C", "-E", "-F"]),
  perl: new Set(["-I", "-M", "-m"]),
  php: new Set(["-c", "-d", "-z"]),
  shell: new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]),
};

interface ShellToken {
  text: string;
  start: number;
  end: number;
  kind: "word" | "separator" | "redirect";
}

interface ShellSegment {
  words: ShellToken[];
  redirects: string[];
  pipedInto: boolean;
  end: number;
}

/**
 * Split a command into words, command separators and redirection operators.
 * Quotes and escapes stay part of their word. Returns null for unbalanced
 * quotes, which callers treat as "unsure".
 */
function tokenizeShell(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let wordStart = -1;
  let quote: string | null = null;
  const endWord = (end: number) => {
    if (wordStart >= 0) {
      tokens.push({ text: command.slice(wordStart, end), start: wordStart, end, kind: "word" });
    }
    wordStart = -1;
  };
  const pushOperator = (start: number, end: number, kind: ShellToken["kind"]) => {
    endWord(start);
    tokens.push({ text: command.slice(start, end), start, end, kind });
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      if (wordStart < 0) wordStart = index;
      quote = char;
      continue;
    }
    if (char === "\\") {
      if (wordStart < 0) wordStart = index;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord(index);
      continue;
    }
    if (char === "#" && wordStart < 0) {
      // A comment runs to the end of the line; its quotes do not pair up.
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "<" || char === ">" || (char === "&" && command[index + 1] === ">")) {
      let end = index + 1;
      while (end < command.length && end - index < 3 && /[<>&|-]/.test(command[end])) end += 1;
      pushOperator(index, end, "redirect");
      index = end - 1;
      continue;
    }
    if (";&|()`\n".includes(char)) {
      const doubled =
        (char === "&" || char === "|") &&
        (command[index + 1] === char || (char === "|" && command[index + 1] === "&"));
      const end = doubled ? index + 2 : index + 1;
      pushOperator(index, end, "separator");
      index = end - 1;
      continue;
    }
    if (wordStart < 0) wordStart = index;
  }
  if (quote) return null;
  endWord(command.length);
  return tokens;
}

function splitSegments(tokens: ShellToken[], textLength: number): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { words: [], redirects: [], pipedInto: false, end: textLength };
  let skipRedirectTarget = false;
  for (const token of tokens) {
    if (token.kind === "separator") {
      current.end = token.start;
      segments.push(current);
      current = {
        words: [],
        redirects: [],
        pipedInto: token.text === "|" || token.text === "|&",
        end: textLength,
      };
      skipRedirectTarget = false;
    } else if (token.kind === "redirect") {
      current.redirects.push(token.text);
      skipRedirectTarget = true;
    } else if (skipRedirectTarget) {
      // A redirection target or heredoc delimiter is not an argument.
      skipRedirectTarget = false;
    } else {
      current.words.push(token);
    }
  }
  segments.push(current);
  return segments;
}

function unquote(text: string): string {
  return text.replace(/["'\\]/g, "");
}

function commandName(token: ShellToken): string {
  return (unquote(token.text).split("/").pop() || "").toLowerCase();
}

/** Index of the command word, past environment assignments and wrappers like sudo or xargs. */
function commandWordIndex(words: ShellToken[]): number {
  const isAssignment = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
  let index = 0;
  while (index < words.length) {
    if (isAssignment(words[index].text)) {
      index += 1;
      continue;
    }
    if (!COMMAND_WRAPPERS.has(commandName(words[index]))) return index;
    index += 1;
    while (
      index < words.length &&
      (words[index].text.startsWith("-") ||
        isAssignment(words[index].text) ||
        /^\d+(?:\.\d+)?[smhd]?$/.test(words[index].text))
    ) {
      index += 1;
    }
  }
  return -1;
}

function pushDataSpan(spans: Array<[number, number]>, token: ShellToken | undefined): void {
  // Command substitutions run even inside a pattern or message; keep them visible.
  if (!token || /\$\(|`/.test(token.text)) return;
  spans.push([token.start, token.end]);
}

function collectSearchPatterns(
  tool: string,
  args: ShellToken[],
  spans: Array<[number, number]>,
): void {
  const argOptions = SEARCH_TOOL_ARG_OPTIONS.get(tool) ?? GREP_ARG_OPTIONS;
  let patternOptionSeen = false;
  let firstOperand: ShellToken | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text;
    if (text === "--") {
      firstOperand ??= args[index + 1];
      break;
    }
    if (text === "-e" || text === "--regexp" || (tool === "ack" && text === "--match")) {
      pushDataSpan(spans, args[index + 1]);
      patternOptionSeen = true;
      index += 1;
    } else if (/^(?:-e.|--regexp=|--match=)/.test(text)) {
      pushDataSpan(spans, args[index]);
      patternOptionSeen = true;
    } else if (argOptions.has(text)) {
      index += 1;
    } else if (!text.startsWith("-") || text === "-") {
      firstOperand ??= args[index];
    }
  }
  if (!patternOptionSeen) pushDataSpan(spans, firstOperand);
}

function gitSubcommandIndex(args: ShellToken[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text;
    if (GIT_GLOBAL_ARG_OPTIONS.has(text)) index += 1;
    else if (!text.startsWith("-")) return index;
  }
  return -1;
}

/** Mask git commit/tag/merge messages and history search strings (`log -S`, `--grep`). */
function collectGitDataArguments(args: ShellToken[], spans: Array<[number, number]>): void {
  const subcommandIndex = gitSubcommandIndex(args);
  if (subcommandIndex < 0) return;
  const subcommand = unquote(args[subcommandIndex].text).toLowerCase();
  const rest = args.slice(subcommandIndex + 1);
  if (subcommand === "grep") {
    collectSearchPatterns("grep", rest, spans);
    return;
  }
  const messages = GIT_MESSAGE_SUBCOMMANDS.has(subcommand);
  const historySearch = GIT_HISTORY_SEARCH_SUBCOMMANDS.has(subcommand);
  if (!messages && !historySearch) return;
  for (let index = 0; index < rest.length; index += 1) {
    const text = rest[index].text;
    const separateValue = messages
      ? /^-[A-Za-z]*m$/.test(text) || text === "--message"
      : text === "-S" || text === "-G" || text === "--grep";
    const attachedValue = messages
      ? /^(?:-m.|--message=)/.test(text)
      : /^(?:-[SG].|--grep=)/.test(text);
    if (separateValue) {
      pushDataSpan(spans, rest[index + 1]);
      index += 1;
    } else if (attachedValue) {
      pushDataSpan(spans, rest[index]);
    }
  }
}

/**
 * Whether the command may change what `grep` or `git` resolves to: an alias,
 * a function definition, a changed PATH, eval, or a sourced file.
 */
function mayRedefineCommands(tokens: ShellToken[], segments: ShellSegment[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "word") continue;
    if (/^(?:PATH|path)\+?=/.test(unquote(tokens[index].text))) return true;
    if (tokens[index + 1]?.text === "(" && tokens[index + 2]?.text === ")") return true;
  }
  return segments.some((segment) => {
    const index = commandWordIndex(segment.words);
    return index >= 0 && COMMAND_REDEFINERS.has(commandName(segment.words[index]));
  });
}

/** Offsets of heredoc bodies: input for the command, never shell words to mask. */
function heredocBodyRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1/g)) {
    const bodyStart = text.indexOf("\n", (match.index ?? 0) + match[0].length) + 1;
    if (bodyStart <= 0) continue;
    const end = text.slice(bodyStart).search(new RegExp(`^[\\t ]*${match[2]}[\\t ]*$`, "m"));
    ranges.push([bodyStart, end < 0 ? text.length : bodyStart + end]);
  }
  return ranges;
}

/** Replace arguments that are only data (search patterns, git messages) with a placeholder. */
function maskDataArguments(text: string, tokens: ShellToken[], segments: ShellSegment[]): string {
  if (mayRedefineCommands(tokens, segments)) return text;
  const spans: Array<[number, number]> = [];
  for (const segment of segments) {
    const index = commandWordIndex(segment.words);
    // Only the real tools: `./grep` could be anything.
    if (index < 0 || unquote(segment.words[index].text).includes("/")) continue;
    const name = commandName(segment.words[index]);
    const args = segment.words.slice(index + 1);
    if (SEARCH_TOOL_ARG_OPTIONS.has(name)) collectSearchPatterns(name, args, spans);
    else if (name === "git") collectGitDataArguments(args, spans);
  }
  const heredocBodies = heredocBodyRanges(text);
  let masked = text;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    if (heredocBodies.some(([bodyStart, bodyEnd]) => start >= bodyStart && start < bodyEnd)) {
      continue;
    }
    masked = `${masked.slice(0, start)}${DATA_ARGUMENT_PLACEHOLDER}${masked.slice(end)}`;
  }
  return masked;
}

/**
 * URLs count as network access unless their authority is a bare loopback host.
 * Userinfo or a backslash next to a loopback name can hide another host
 * (`http://evil.example\@localhost`), so those count as network access too.
 */
function containsNonLoopbackUrl(text: string): boolean {
  for (const match of text.matchAll(URL_AUTHORITY_PATTERN)) {
    if (!LOOPBACK_AUTHORITY_PATTERN.test(match[1] || "")) return true;
  }
  return false;
}

/**
 * Network tools named by path (`/usr/bin/curl`), git network subcommands after
 * global options (`git -C repo fetch`), and `fetch` subcommands of any tool
 * (`pnpm fetch`, `cargo fetch`).
 */
function isNetworkSegment(segment: ShellSegment): boolean {
  for (const word of segment.words) {
    const text = unquote(word.text);
    if (text.toLowerCase() === "fetch") return true;
    if (text.includes("/") && NETWORK_TOOLS.has(commandName(word))) return true;
  }
  const index = commandWordIndex(segment.words);
  if (index < 0 || commandName(segment.words[index]) !== "git") return false;
  const args = segment.words.slice(index + 1);
  const subcommandIndex = gitSubcommandIndex(args);
  return (
    subcommandIndex >= 0 &&
    GIT_NETWORK_SUBCOMMANDS.has(unquote(args[subcommandIndex].text).toLowerCase())
  );
}

function interpreterFamily(token: ShellToken): InterpreterFamily | null {
  const name = commandName(token);
  if (/^(?:python|pypy)[0-9.]*$/.test(name) || name === "py" || name === "ipython") return "python";
  if (name === "node" || name === "nodejs" || name === "tsx" || name === "ts-node") return "node";
  if (name === "bun" || name === "deno" || name === "ruby" || name === "perl" || name === "php") {
    return name;
  }
  if (/^(?:sh|bash|zsh|dash|ksh|mksh|ash|fish)$/.test(name)) return "shell";
  return null;
}

function isInlineCodeFlag(family: InterpreterFamily, text: string): boolean {
  switch (family) {
    case "python":
      return /^-[A-Za-z]*c$/.test(text) || /^-c\S/.test(text);
    case "shell":
      return /^-[A-Za-z]*c$/.test(text);
    case "node":
    case "bun":
      return (
        /^(?:-e|-p|-pe|--eval|--print)$/.test(text) || /^(?:--(?:eval|print)=|-[ep]\S)/.test(text)
      );
    case "ruby":
      return /^-[A-Za-z]*e$/.test(text) || /^-e\S/.test(text);
    case "perl":
      return /^-[A-Za-z]*[eE]$/.test(text) || /^-[eE]\S/.test(text);
    case "php":
      return /^-[rBRE]$/.test(text) || /^-r\S/.test(text);
    default:
      return false;
  }
}

/**
 * Where an interpreter's code comes from: an inline code flag, a script (or
 * module) path, or neither, in which case it reads its program from stdin.
 */
function locateInterpreterCode(
  family: InterpreterFamily,
  args: ShellToken[],
): { inline?: ShellToken; script?: ShellToken } {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text;
    if (isInlineCodeFlag(family, text)) return { inline: args[index] };
    if (text === "-" || (family === "shell" && /^-[A-Za-z]*s$/.test(text))) return {};
    if (
      text === "--" ||
      (family === "python" && text === "-m") ||
      (family === "php" && text === "-f")
    ) {
      return { script: args[index + 1] };
    }
    if (/^[-+]/.test(text)) {
      if (INTERPRETER_ARG_OPTIONS[family].has(text)) index += 1;
      continue;
    }
    if (family === "deno" && text === "eval") return { inline: args[index] };
    if ((family === "deno" || family === "bun") && text === "run") continue;
    // `python3 /dev/stdin <<EOF` reads its program from stdin too.
    if (/^\/dev\/(?:stdin|fd\/0)$/.test(text)) return {};
    return { script: args[index] };
  }
  return {};
}

/**
 * Code a command runs without showing it, by name: a file run by path, a
 * package script (`npm run fetch-data`), a package binary, a make target or a
 * sourced file.
 */
function entryPointNames(segment: ShellSegment): string[] {
  const index = commandWordIndex(segment.words);
  if (index < 0) return [];
  const word = segment.words[index];
  if (unquote(word.text).includes("/")) return [word.text];
  const name = commandName(word);
  if (!SCRIPT_RUNNERS.has(name)) return [];
  const operands: string[] = [];
  for (const token of segment.words.slice(index + 1)) {
    if (token.text === "--") break;
    if (!token.text.startsWith("-") && !token.text.includes("=")) operands.push(token.text);
  }
  if (ALL_OPERAND_RUNNERS.has(name)) return operands;
  const runIndex = operands.findIndex((operand) => operand === "run" || operand === "run-script");
  if (runIndex >= 0) return operands.slice(runIndex + 1, runIndex + 2);
  // npm only runs package scripts through `run`; the others accept a bare name.
  return name === "npm" ? [] : operands.slice(0, 1);
}

/** The interpreter, if any, that runs code at this word of the segment. */
function codeRunnerFamily(segment: ShellSegment, index: number): InterpreterFamily | null {
  const family = interpreterFamily(segment.words[index]);
  if (family) return family;
  // `source file` and `. file` run shell code, but `.` is also a common argument.
  const name = commandName(segment.words[index]);
  return (name === "source" || name === ".") && index === commandWordIndex(segment.words)
    ? "shell"
    : null;
}

/** The parts of a command that are code it runs; library names count only there. */
function codeScopes(text: string, segments: ShellSegment[]): string[] {
  const scopes: string[] = [];
  for (const segment of segments) {
    scopes.push(...entryPointNames(segment));
    const fedOnStdin = segment.pipedInto || segment.redirects.some((op) => op.startsWith("<"));
    for (let index = 0; index < segment.words.length; index += 1) {
      const family = codeRunnerFamily(segment, index);
      if (!family) continue;
      const code = locateInterpreterCode(family, segment.words.slice(index + 1));
      if (code.inline) scopes.push(text.slice(code.inline.start, segment.end));
      else if (code.script) scopes.push(code.script.text);
      // The program arrives on stdin from elsewhere in the command.
      else if (fedOnStdin) return [text];
    }
  }
  return scopes;
}

/**
 * Hide literal payloads that are only being written to a local file. URLs in
 * documentation text are data, not evidence that the shell will open a
 * socket. Executable heredocs (python/node/sh), pipelines, and special
 * /dev/tcp redirections intentionally remain unmasked and fail closed.
 */
function maskLocalFilePayloads(command: string): string {
  const lines = command.split(/\r?\n/);
  let dataOnlyDelimiter: string | null = null;
  const maskedLines: string[] = [];

  for (const line of lines) {
    if (dataOnlyDelimiter) {
      if (line.trim() === dataOnlyDelimiter) {
        maskedLines.push(line);
        dataOnlyDelimiter = null;
      } else {
        maskedLines.push("<local-file-payload>");
      }
      continue;
    }

    const catIndex = line.search(/\bcat\b/);
    const catSegment = catIndex >= 0 ? line.slice(catIndex) : "";
    const delimiterMatch = catSegment.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1/);
    const redirectionWithoutHeredoc = delimiterMatch
      ? catSegment.replace(delimiterMatch[0], "")
      : "";
    const hasLocalFileRedirection = /(?:^|\s)>>?\s*[^\s;&|]+/.test(redirectionWithoutHeredoc);
    const unsafeDataSink =
      !delimiterMatch ||
      !hasLocalFileRedirection ||
      /[|`]|\$\(/.test(catSegment) ||
      /\/dev\/(?:tcp|udp)\//i.test(catSegment);
    if (!unsafeDataSink) {
      dataOnlyDelimiter = delimiterMatch[2];
    }
    maskedLines.push(line);
  }

  const withoutDataOnlyHeredocs = maskedLines.join("\n");
  return withoutDataOnlyHeredocs.replace(
    /(\.write_text\(\s*)([rub]*)("""|''')[\s\S]*?\3(\s*\))/gi,
    "$1$2$3<local-file-payload>$3$4",
  );
}

/** Script files the command runs: interpreter scripts and files executed by path. */
function executedScripts(segments: ShellSegment[]): ShellToken[] {
  const scripts: ShellToken[] = [];
  for (const segment of segments) {
    const commandIndex = commandWordIndex(segment.words);
    if (commandIndex >= 0 && unquote(segment.words[commandIndex].text).includes("/")) {
      scripts.push(segment.words[commandIndex]);
    }
    for (let index = 0; index < segment.words.length; index += 1) {
      const family = codeRunnerFamily(segment, index);
      if (!family) continue;
      const script = locateInterpreterCode(family, segment.words.slice(index + 1)).script;
      if (script) scripts.push(script);
    }
  }
  return scripts;
}

/**
 * Whether the command runs a script that it also names elsewhere, as a redirect
 * target or as an argument of any command (`tee x.py`, `dd of=x.py`,
 * `cp /dev/stdin x.py`): the script may be written by the command itself, so
 * its content, a heredoc included, is code rather than data.
 */
function runsScriptItAlsoNames(tokens: ShellToken[], segments: ShellSegment[]): boolean {
  const normalizePath = (text: string) => unquote(text).replace(/^\.\//, "");
  const scripts = executedScripts(segments);
  if (scripts.length === 0) return false;
  const scriptStarts = new Set(scripts.map((script) => script.start));
  const named = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "word" || scriptStarts.has(token.start)) continue;
    named.add(normalizePath(token.text));
    // `of=x.py`, `--output=x.py`
    const equals = token.text.lastIndexOf("=");
    if (equals >= 0) named.add(normalizePath(token.text.slice(equals + 1)));
  }
  return scripts.some((script) => named.has(normalizePath(script.text)));
}

const NESTED_COMMAND_DEPTH_LIMIT = 3;
// A quoted string that names an interpreter, shell or script runner is likely
// code another command runs (`watch '…'`, `su -c '…'`, `alias x='…'`).
const NESTED_CODE_HINT =
  /(?:^|[\s;&|()`'"])(?:python[0-9.]*|pypy[0-9.]*|py|ipython|node|nodejs|tsx|ts-node|bun|deno|ruby|perl|php|sh|bash|zsh|dash|ksh|mksh|ash|fish|eval|source|npm|pnpm|yarn|npx|bunx|uv|uvx|pipx|poetry|pdm|hatch|go|dotnet|swift|make|just|java|rscript|watch)(?=$|[\s;&|()`'"])/i;

function stripOuterQuotes(text: string): string {
  const quote = text[0];
  if ((quote === "'" || quote === '"') && text.length >= 2 && text.endsWith(quote)) {
    const inner = text.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
  }
  return unquote(text);
}

/** Command text nested in quoted arguments: everything `eval` runs and code-like strings. */
function nestedCommands(segments: ShellSegment[]): string[] {
  const nested: string[] = [];
  for (const segment of segments) {
    const index = commandWordIndex(segment.words);
    if (index >= 0 && commandName(segment.words[index]) === "eval") {
      nested.push(
        segment.words
          .slice(index + 1)
          .map((word) => stripOuterQuotes(word.text))
          .join(" "),
      );
    }
    for (const word of segment.words) {
      if (!/["']/.test(word.text)) continue;
      // Also the quoted value of `alias x='…'`, `VAR='…'` or `--option='…'`.
      const equals = word.text.indexOf("=");
      const value =
        equals > 0 && equals < word.text.search(/["']/) ? word.text.slice(equals + 1) : word.text;
      const inner = stripOuterQuotes(value);
      if (NESTED_CODE_HINT.test(inner)) nested.push(inner);
    }
  }
  return nested;
}

function matchesAnywhere(text: string): boolean {
  return (
    NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(text)) ||
    containsNonLoopbackUrl(text) ||
    NETWORK_LIBRARY_PATTERN.test(text)
  );
}

function classifyCommand(command: string, depth: number): boolean {
  const executableText = maskLocalFilePayloads(command);
  const tokens = tokenizeShell(executableText);
  // Unbalanced quoting: nothing can be attributed to data, so match it all.
  if (!tokens) return matchesAnywhere(executableText);
  const commandSegments = splitSegments(tokens, executableText.length);
  // Even a heredoc written to a file is code once the command runs that file.
  if (runsScriptItAlsoNames(tokens, commandSegments)) return matchesAnywhere(command);
  const maskedText = maskDataArguments(executableText, tokens, commandSegments);
  if (NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(maskedText))) return true;
  if (containsNonLoopbackUrl(maskedText)) return true;
  // Masking replaces whole words with a bare placeholder, so quoting stays balanced.
  const segments = splitSegments(tokenizeShell(maskedText) ?? [], maskedText.length);
  if (segments.some(isNetworkSegment)) return true;
  if (codeScopes(maskedText, segments).some((scope) => NETWORK_LIBRARY_PATTERN.test(scope))) {
    return true;
  }
  const nested = nestedCommands(segments);
  // Past the recursion limit, fail closed: match nested code as a whole.
  return depth < NESTED_COMMAND_DEPTH_LIMIT
    ? nested.some((inner) => classifyCommand(inner, depth + 1))
    : nested.some(matchesAnywhere);
}

export function isLikelyNetworkShellCommand(command: string | undefined | null): boolean {
  const normalized = typeof command === "string" ? command.trim() : "";
  return normalized ? classifyCommand(normalized, 0) : false;
}
