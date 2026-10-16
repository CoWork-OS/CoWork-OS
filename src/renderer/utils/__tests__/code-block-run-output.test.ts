import { describe, expect, it } from "vitest";
import { ansiToLines } from "../ansi-lines";
import { extractRunnableCommand, isRunnableShellLanguage } from "../code-block-runs";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

describe("ansiToLines", () => {
  it("keeps colour and weight as spans", () => {
    const lines = ansiToLines(
      `12:20PM ${ESC}[32mINF${ESC}[0m ${ESC}[1mno leaks found${ESC}[22m\r\n`,
    );
    expect(lines).toEqual([
      [
        { text: "12:20PM " },
        { text: "INF", fg: 2 },
        { text: " " },
        { text: "no leaks found", bold: true },
      ],
    ]);
  });

  it("carries colour across lines until reset and supports bright colours", () => {
    const lines = ansiToLines(`${ESC}[91mone\r\ntwo${ESC}[0m\r\nthree`);
    expect(lines).toEqual([
      [{ text: "one", fg: 9 }],
      [{ text: "two", fg: 9 }],
      [{ text: "three" }],
    ]);
  });

  it("redraws on carriage return and erase-in-line, and drops OSC marks", () => {
    const lines = ansiToLines(
      `${ESC}]133;C${BEL}Writing  50%\r${ESC}[KWriting 100%, done.\r\n${ESC}]133;D;0${BEL}`,
    );
    expect(lines).toEqual([[{ text: "Writing 100%, done." }]]);
  });

  it("trims blank lines at the edges but keeps inner ones", () => {
    expect(ansiToLines("\r\nfirst\r\n\r\nlast\r\n\r\n")).toEqual([
      [{ text: "first" }],
      [],
      [{ text: "last" }],
    ]);
  });
});

describe("runnable shell code blocks", () => {
  it("offers Run only for shell languages", () => {
    expect(isRunnableShellLanguage("bash")).toBe(true);
    expect(isRunnableShellLanguage("ZSH")).toBe(true);
    expect(isRunnableShellLanguage("console")).toBe(false);
    expect(isRunnableShellLanguage("python")).toBe(false);
  });

  it("drops prompt markers only when every command line has one", () => {
    expect(extractRunnableCommand("$ npm install\n$ npm test\n")).toBe("npm install\nnpm test");
    expect(extractRunnableCommand("echo $ HOME\n")).toBe("echo $ HOME");
    expect(extractRunnableCommand("$ ls\nfile.txt")).toBe("$ ls\nfile.txt");
  });
});
