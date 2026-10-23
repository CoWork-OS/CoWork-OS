import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../../resources/bot-desktop/cowork-network.sh");

// Runs the real script with stand-in iptables/ip6tables that only log their arguments.
describe.skipIf(process.platform === "win32")("cowork-network (bot desktop network limit)", () => {
  let bin: string;
  let log: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-network-bin-"));
    log = path.join(bin, "rules.log");
    for (const table of ["iptables", "ip6tables"]) {
      fs.writeFileSync(path.join(bin, table), `#!/bin/sh\necho "${table} $*" >> "${log}"\n`, {
        mode: 0o755,
      });
    }
  });

  afterEach(() => fs.rmSync(bin, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    execFileSync("/bin/sh", [SCRIPT, ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  const rules = () => fs.readFileSync(log, "utf8").trim().split("\n");

  it("allows the public internet and DNS, never this computer or the local network", () => {
    run("internet", "192.168.65.7");
    const lines = rules();
    // Closed first, so a failure part-way leaves no network rather than an open one.
    expect(lines[0]).toBe("iptables -P OUTPUT DROP");
    expect(lines).toContain("ip6tables -P OUTPUT DROP");
    const dns = lines.indexOf("iptables -A OUTPUT -d 192.168.65.7 -p udp --dport 53 -j ACCEPT");
    const lan = lines.indexOf("iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT");
    const internet = lines.indexOf("iptables -A OUTPUT -j ACCEPT");
    expect(dns).toBeGreaterThan(-1);
    expect(dns).toBeLessThan(lan);
    expect(lan).toBeLessThan(internet);
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "169.254.0.0/16", "100.64.0.0/10"]) {
      expect(lines.indexOf(`iptables -A OUTPUT -d ${range} -j REJECT`)).toBeLessThan(internet);
    }
    expect(lines.at(-1)).toBe("ip6tables -A OUTPUT -j REJECT");
    expect(lines).not.toContain("ip6tables -A OUTPUT -j ACCEPT");
  });

  it("closes everything but loopback and replies with no network", () => {
    run("off");
    const lines = rules();
    expect(lines).not.toContain("iptables -A OUTPUT -j ACCEPT");
    expect(lines.some((line) => line.includes("--dport 53"))).toBe(false);
    expect(lines).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
    expect(lines).toContain("iptables -A OUTPUT -j REJECT");
  });

  it("refuses an unknown mode or a resolver that is not an IPv4 address before any rule", () => {
    expect(() => run("open")).toThrow();
    expect(() => run("internet", "8.8.8.8;id")).toThrow();
    expect(fs.existsSync(log)).toBe(false);
  });
});
