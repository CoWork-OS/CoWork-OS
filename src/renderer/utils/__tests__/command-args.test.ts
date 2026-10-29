import { describe, expect, it } from "vitest";
import { formatCommandArgs, parseCommandArgs } from "../command-args";

describe("command arguments", () => {
  it("splits on whitespace and keeps quoted spaces in one argument", () => {
    expect(parseCommandArgs("--root \"/Users/me/My Documents\"  --title 'two words'")).toEqual([
      "--root",
      "/Users/me/My Documents",
      "--title",
      "two words",
    ]);
  });

  it("joins quoted and bare parts and keeps empty quoted arguments", () => {
    expect(parseCommandArgs('--name="A B" ""')).toEqual(["--name=A B", ""]);
  });

  it("leaves backslashes alone so Windows paths survive", () => {
    expect(parseCommandArgs('C:\\tools\\server.js "C:\\Program Files\\x"')).toEqual([
      "C:\\tools\\server.js",
      "C:\\Program Files\\x",
    ]);
  });

  it("round-trips stored arguments through the edit field unchanged", () => {
    const stored = ["--root", "/tmp/My Folder", "--title", "two words", 'say "hi"', "", "plain"];
    expect(parseCommandArgs(formatCommandArgs(stored))).toEqual(stored);
    expect(formatCommandArgs(["-y", "@scope/server"])).toBe("-y @scope/server");
  });
});
