import { describe, expect, it } from "vitest";
import { trailingBackgroundCommand } from "../trailing-background-command";

describe("tracked trailing ampersand commands", () => {
  it.each(["sleep 5 &", "npm run dev &", "python3 'worker.py' &  "])("recognizes %s", (command) => {
    expect(trailingBackgroundCommand(command)).toBe(command.trimEnd().slice(0, -1).trimEnd());
  });
  it.each([
    "sleep 1 && sleep 5 &",
    "sleep 5 & echo done",
    "sleep 5 &&",
    "echo '&'",
    "echo foo\\ &",
    "echo 'unterminated &",
    "echo $(sleep 5) &",
    "sh -c 'sleep 5' &",
    "nohup sleep 5 &",
    "env FOO=1 sleep 5 &",
    "sleep 5 # &",
    "echo 1\nsleep 5 &",
    "sleep 5 > out &",
    "(sleep 5) &",
    "sleep 5 & sleep 5 &",
  ])("leaves ambiguous program unchanged: %s", (command) => {
    expect(trailingBackgroundCommand(command)).toBeUndefined();
  });
});
