import os from "node:os";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgInput: "\x1b[48;5;236m",
} as const;

const BRAND = "\x1b[38;5;44m";
const ACCENT = "\x1b[38;5;50m";
const WARN = "\x1b[38;5;214m";

export interface WelcomeScreenOptions {
  version?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  width?: number;
  color?: boolean;
}

export function renderWelcomeScreen(options: WelcomeScreenOptions = {}): string {
  const width = Math.max(76, Math.min(options.width ?? process.stdout.columns ?? 120, 160));
  const color = options.color ?? shouldColor();
  const version = options.version || "dev";
  const cwd = formatCwd(options.cwd || process.cwd());
  const provider = options.provider || "local runtime";
  const model = options.model || "configure a provider";
  const boxWidth = width - 4;
  const leftWidth = Math.max(30, Math.min(44, Math.floor(boxWidth * 0.32)));
  const rightWidth = boxWidth - leftWidth - 1;
  const rightLines = [
    styled("Getting started", WARN, color),
    "Type a task and press Enter to run it",
    styled("/doctor", ACCENT, color) + " checks runtime and providers",
    styled("/providers list", ACCENT, color) + " shows model setup",
    styled("/workspace list", ACCENT, color) + " shows local workspaces",
    styled("/exit", ACCENT, color) + " leaves CoWork OS",
  ];
  const leftLines = [
    center(styled("Welcome back", ANSI.bold + ANSI.white, color), leftWidth),
    "",
    center(styled("╔═╗ ╔═╗ ╦ ╦ ╔═╗ ╦═╗ ╦╔═", BRAND, color), leftWidth),
    center(styled("║   ║ ║ ║║║ ║ ║ ╠╦╝ ╠╩╗", BRAND, color), leftWidth),
    center(styled("╚═╝ ╚═╝ ╚╩╝ ╚═╝ ╩╚═ ╩ ╩", BRAND, color), leftWidth),
    center(styled("╔═╗ ╔═╗", BRAND, color), leftWidth),
    center(styled("║ ║ ╚═╗", BRAND, color), leftWidth),
    center(styled("╚═╝ ╚═╝", BRAND, color), leftWidth),
    "",
    center(styled(`${model} · ${provider}`, ANSI.gray, color), leftWidth),
    center(styled(cwd, ANSI.gray, color), leftWidth),
  ];

  const bodyHeight = Math.max(leftLines.length, rightLines.length, 10);
  const title = ` CoWork OS ${version} `;
  const top =
    styled("╭", BRAND, color) +
    styled("─".repeat(2), BRAND, color) +
    styled(title, ANSI.bold + BRAND, color) +
    styled("─".repeat(Math.max(0, boxWidth - visibleLength(title) - 2)), BRAND, color) +
    styled("╮", BRAND, color);
  const bottom = styled("╰" + "─".repeat(boxWidth) + "╯", BRAND, color);
  const rows = [top];
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] || "", leftWidth);
    const right = padVisible(rightLines[i] || "", rightWidth - 2);
    rows.push(
      styled("│", BRAND, color) +
        left +
        styled("│", BRAND, color) +
        " " +
        right +
        " " +
        styled("│", BRAND, color),
    );
  }
  rows.push(bottom);
  rows.push("");
  rows.push(styled("─".repeat(width), ANSI.gray, color));
  rows.push(renderShortcutFooter(width, color));
  return rows.join("\n");
}

export function renderPromptLine(
  width = process.stdout.columns ?? 100,
  color = shouldColor(),
): string {
  const marker = styled("❯", ANSI.bold + ACCENT, color);
  const input = `${marker} `;
  return styled(padVisible(input, width), ANSI.bgInput, color);
}

export function promptMarker(color = shouldColor()): string {
  return styled("❯ ", ANSI.bold + ACCENT, color);
}

function renderShortcutFooter(width: number, color: boolean): string {
  const left = " ? for shortcuts  ·  / for commands  ·  @ for files ";
  const right = " ● ready · /effort ";
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return styled(left, ANSI.gray, color) + " ".repeat(gap) + styled(right, ANSI.gray, color);
}

function formatCwd(cwd: string): string {
  const home = os.homedir();
  const compact = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return compact.length > 42 ? `…${compact.slice(-41)}` : compact;
}

function center(input: string, width: number): string {
  const len = visibleLength(input);
  if (len >= width) return truncateVisible(input, width);
  const left = Math.floor((width - len) / 2);
  return `${" ".repeat(left)}${input}${" ".repeat(width - len - left)}`;
}

function padVisible(input: string, width: number): string {
  const truncated = truncateVisible(input, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleLength(truncated)))}`;
}

function truncateVisible(input: string, width: number): string {
  if (visibleLength(input) <= width) return input;
  const plain = stripAnsi(input);
  if (plain.length <= width) return input;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function visibleLength(input: string): number {
  return stripAnsi(input).length;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function styled(input: string, code: string, color: boolean): string {
  return color ? `${code}${input}${ANSI.reset}` : input;
}

function shouldColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}
