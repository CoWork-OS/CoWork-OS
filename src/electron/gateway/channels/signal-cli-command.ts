/**
 * Builds the process invocation for a signal-cli command without a shell.
 *
 * On macOS/Linux signal-cli is run directly with an argument array.
 *
 * On Windows signal-cli is distributed as `signal-cli.bat`, and Node cannot
 * run batch files without going through cmd.exe. cmd.exe has no reliable
 * escaping for `"`, `%` or `!`, so instead of escaping we:
 *  - move the message body (the only free-form, agent-influenced text) to
 *    stdin via `--message-from-stdin`, and
 *  - reject any remaining argument containing characters that cmd.exe could
 *    interpret even inside double quotes.
 * Everything left is wrapped in double quotes, where `&`, `|`, `<`, `>` and
 * `^` are literal.
 */

import * as fs from "fs";
import * as path from "path";

export interface SignalCliInvocation {
  file: string;
  args: string[];
  /** Data to write to the child's stdin, when the message was moved there. */
  stdin?: string;
  windowsVerbatimArguments?: boolean;
}

export interface SignalCliInvocationContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => boolean;
}

// Characters cmd.exe can still act on inside a double-quoted argument, plus a
// trailing backslash, which would escape the closing quote for the program.
const UNSAFE_BATCH_ARGUMENT = /["%!\r\n\0]|\\$/;

const BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

export function buildSignalCliInvocation(
  cliPath: string,
  args: string[],
  context: SignalCliInvocationContext = {},
): SignalCliInvocation {
  const platform = context.platform ?? process.platform;
  if (platform !== "win32") {
    return { file: cliPath, args };
  }

  const env = context.env ?? process.env;
  const fileExists = context.fileExists ?? fs.existsSync;
  const resolved = resolveWindowsCommand(cliPath, env, fileExists);

  if (!BATCH_EXTENSIONS.has(path.win32.extname(resolved).toLowerCase())) {
    return { file: resolved, args };
  }

  const batchArgs = [...args];
  let stdin: string | undefined;
  const messageIndex = batchArgs.includes("send") ? batchArgs.indexOf("-m") : -1;
  if (messageIndex !== -1 && messageIndex + 1 < batchArgs.length) {
    stdin = batchArgs[messageIndex + 1];
    batchArgs.splice(messageIndex, 2, "--message-from-stdin");
  }

  for (const value of [resolved, ...batchArgs]) {
    if (UNSAFE_BATCH_ARGUMENT.test(value)) {
      throw new Error(
        `signal-cli argument contains characters that cannot be passed safely to a Windows batch file: ${JSON.stringify(value)}`,
      );
    }
  }

  const commandLine = [resolved, ...batchArgs].map((value) => `"${value}"`).join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    // /d skips AutoRun commands; /s strips only the outer quotes added here.
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    stdin,
    windowsVerbatimArguments: true,
  };
}

/**
 * Resolve an extensionless command (e.g. the default "signal-cli") the way
 * cmd.exe would, using PATH and PATHEXT, so batch files are detected.
 */
function resolveWindowsCommand(
  cliPath: string,
  env: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
): string {
  if (path.win32.extname(cliPath)) {
    return cliPath;
  }

  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasDirectory = /[\\/]/.test(cliPath);
  const directories = hasDirectory ? [""] : (env.PATH || env.Path || "").split(";").filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasDirectory
        ? `${cliPath}${extension}`
        : path.win32.join(directory, `${cliPath}${extension}`);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return cliPath;
}
