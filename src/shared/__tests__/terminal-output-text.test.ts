import { describe, expect, it } from "vitest";
import {
  CODE_BLOCK_RUN_MESSAGE_OUTPUT_LIMIT,
  buildCodeBlockRunMessage,
  parseCodeBlockRunMessage,
  terminalOutputToPlainText,
  truncateMiddle,
} from "../terminal-output-text";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

describe("terminalOutputToPlainText", () => {
  it("drops colours, OSC marks and CRLF pairs", () => {
    const raw = `${ESC}]7;file://host/tmp${BEL}${ESC}[1;31merror:${ESC}[0m failed\r\nhint: pull\r\n\r\n`;
    expect(terminalOutputToPlainText(raw)).toBe("error: failed\nhint: pull");
  });

  it("draws carriage-return progress the way the terminal shows it", () => {
    const raw = "Counting objects:  33% (1/3)\rCounting objects: 100% (3/3), done.\r\n";
    expect(terminalOutputToPlainText(raw)).toBe("Counting objects: 100% (3/3), done.");
  });

  it("applies backspaces", () => {
    expect(terminalOutputToPlainText("abx\bc")).toBe("abc");
  });

  it("applies line erases, so text deleted at a prompt is gone", () => {
    expect(terminalOutputToPlainText(`% secret${"\b".repeat(6)}${ESC}[K`)).toBe("%");
    expect(terminalOutputToPlainText(`abcdef${ESC}[3D${ESC}[0Kxy`)).toBe("abcxy");
    expect(terminalOutputToPlainText(`abcdef${ESC}[3D${ESC}[1K`)).toBe("    ef");
    expect(terminalOutputToPlainText(`abcdef${ESC}[2Kxy`)).toBe("      xy");
  });

  it("applies cursor moves and deleted characters", () => {
    expect(terminalOutputToPlainText(`abc${ESC}[2DX`)).toBe("aXc");
    expect(terminalOutputToPlainText(`ab${ESC}[3Cc`)).toBe("ab   c");
    expect(terminalOutputToPlainText(`abcd${ESC}[3D${ESC}[P`)).toBe("acd");
  });

  it("drops what came before a clear of the scrollback", () => {
    expect(terminalOutputToPlainText(`old\r\n${ESC}[H${ESC}[2J${ESC}[3Jnew\r\n`)).toBe("new");
    expect(terminalOutputToPlainText(`old\r\n${ESC}cnew`)).toBe("new");
  });
});

describe("truncateMiddle", () => {
  it("keeps the head and the tail", () => {
    const { text, truncated } = truncateMiddle("a".repeat(50) + "b".repeat(50), 20);
    expect(truncated).toBe(true);
    expect(text.startsWith("aaaaaa\n")).toBe(true);
    expect(text.endsWith("b".repeat(14))).toBe(true);
    expect(text).toContain("80 characters omitted");
  });
});

describe("code block run message", () => {
  it("round-trips the command and exit status", () => {
    const message = buildCodeBlockRunMessage({
      command: "git push origin main",
      output: `${ESC}[31m ! [rejected]${ESC}[0m main -> main\r\n`,
      exitCode: 1,
    });
    expect(message).toContain("exit code 1");
    expect(message).toContain("```text\n ! [rejected] main -> main\n```");
    expect(parseCodeBlockRunMessage(message)).toEqual({
      command: "git push origin main",
      exitCode: 1,
      tabId: null,
    });
  });

  it("says when nothing was printed and when the status is unknown", () => {
    const message = buildCodeBlockRunMessage({ command: "true", output: "", exitCode: null });
    expect(message).toContain("It printed nothing.");
    expect(parseCodeBlockRunMessage(message)).toEqual({
      command: "true",
      exitCode: null,
      tabId: null,
    });
  });

  it("uses longer fences when the command or output contains one", () => {
    const message = buildCodeBlockRunMessage({
      command: "printf '```\\n'",
      output: "```\r\n",
      exitCode: 0,
    });
    expect(message).toContain("````sh\nprintf '```\\n'\n````");
    expect(parseCodeBlockRunMessage(message)?.command).toBe("printf '```\\n'");
  });

  it("shortens long output and says so", () => {
    const message = buildCodeBlockRunMessage({
      command: "yes | head",
      output: "y\n".repeat(CODE_BLOCK_RUN_MESSAGE_OUTPUT_LIMIT),
      exitCode: 0,
    });
    expect(message).toContain("Output (shortened):");
    expect(message.length).toBeLessThan(CODE_BLOCK_RUN_MESSAGE_OUTPUT_LIMIT + 400);
  });

  it("names the tab the command ran in as a terminal tab link", () => {
    const message = buildCodeBlockRunMessage({
      command: "npm test",
      output: "1 failed\r\n",
      exitCode: 1,
      tab: { id: "tab:ws-1:tab-1760000000-ab12", label: "cowork" },
    });
    expect(message.split("\n")[0]).toBe(
      "I ran this command in my terminal tab [cowork](#terminal/tab%3Aws-1%3Atab-1760000000-ab12) (exit code 1):",
    );
    expect(parseCodeBlockRunMessage(message)).toEqual({
      command: "npm test",
      exitCode: 1,
      tabId: "tab:ws-1:tab-1760000000-ab12",
    });
  });

  it("keeps a tab label with brackets or line breaks parseable", () => {
    const message = buildCodeBlockRunMessage({
      command: "ls",
      output: "",
      exitCode: 0,
      tab: { id: "tab:ws-1:tab-2", label: "odd [dir]\nname" },
    });
    expect(message).toContain("tab [odd dir name](#terminal/tab%3Aws-1%3Atab-2) (exit code 0):");
    expect(parseCodeBlockRunMessage(message)).toMatchObject({ tabId: "tab:ws-1:tab-2" });
  });

  it("still reads messages from before the tab was named", () => {
    const message = [
      "I ran this command in my terminal (exit code 0):",
      "",
      "```sh",
      "git status",
      "```",
      "",
      "It printed nothing.",
    ].join("\n");
    expect(parseCodeBlockRunMessage(message)).toEqual({
      command: "git status",
      exitCode: 0,
      tabId: null,
    });
  });

  it("does not parse ordinary messages", () => {
    expect(parseCodeBlockRunMessage("Please run git status")).toBeNull();
  });
});
