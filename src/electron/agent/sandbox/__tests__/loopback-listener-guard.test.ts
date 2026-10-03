import { describe, expect, it, vi } from "vitest";
import {
  LoopbackListenerGuard,
  isLoopbackListenAddress,
  parseNetstatListeners,
  parsePsProcessGroups,
} from "../loopback-listener-guard";

// Captured from `netstat -anv -p tcp` on macOS 26.
const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0    523  192.168.1.147.65195    4.207.44.71.443        ESTABLISHED          250         2101  131328  131376    telemetryd_v2:89468  00182 00000008 000000000180328a 20000081 04000900      3      0 000004
tcp4       0      0  *.65193                *.*                    LISTEN                 0            0  131072  131072           Python:27328  00000 00000006 0000000001803264 00000000 00000800      1      0 000000
tcp4       0      0  127.0.0.1.5173         *.*                    LISTEN                 0            0  131072  131072             node:13942  00100 00000106 00000000017f35e4 00000001 00000800      1      0 000000
tcp6       0      0  ::1.3000               *.*                    LISTEN                 0            0  131072  131072             node:13950  00100 00000106 00000000017f35e4 00000001 00000800      1      0 000000
tcp6       0      0  fe80::c4c8:5ff:f.62503 *.*                    LISTEN                 0            0  131072  131072          remoted:368    00180 00000006 00000000017df222 00000000 00000800      1      0 000000
tcp4       0      0  192.168.1.147.8080     *.*                    LISTEN                 0            0  131072  131072      Google Chrome H:777  00180 00000006 00000000017df222 00000000 00000800      1      0 000000
`;

describe("loopback listener guard parsing", () => {
  it("reads listening sockets and their owners from netstat", () => {
    expect(parseNetstatListeners(NETSTAT)).toEqual([
      { pid: 27328, address: "*.65193" },
      { pid: 13942, address: "127.0.0.1.5173" },
      { pid: 13950, address: "::1.3000" },
      { pid: 368, address: "fe80::c4c8:5ff:f.62503" },
      { pid: 777, address: "192.168.1.147.8080" },
    ]);
  });

  it.each([
    ["127.0.0.1.5173", true],
    ["127.0.0.2.80", true],
    ["::1.3000", true],
    ["fe80::1%lo0.4000", true],
    ["*.65193", false],
    ["0.0.0.0.80", false],
    ["192.168.1.147.8080", false],
    ["fe80::c4c8:5ff:f.62503", false],
  ])("classifies %s as loopback=%s", (address, loopback) => {
    expect(isLoopbackListenAddress(address)).toBe(loopback);
  });

  it("reads process groups from ps", () => {
    expect(parsePsProcessGroups("27328 27300\n  777   777\nbogus\n")).toEqual(
      new Map([
        [27328, 27300],
        [777, 777],
      ]),
    );
  });
});

describe("LoopbackListenerGuard", () => {
  function guardWith(groups: string) {
    const runner = vi.fn(async (file: string) => (file === "netstat" ? NETSTAT : groups));
    return { guard: new LoopbackListenerGuard(runner, 60_000), runner };
  }

  it("reports a watched process group that listens on all interfaces, once", async () => {
    const { guard } = guardWith("27328 27300\n777 777\n");
    const onViolation = vi.fn();
    guard.watch(27300, onViolation);

    await guard.checkNow();
    await guard.checkNow();

    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(onViolation).toHaveBeenCalledWith({ pid: 27328, address: "*.65193" });
    expect(guard.watchedCount).toBe(0);
  });

  it("ignores loopback listeners and other process groups", async () => {
    const { guard } = guardWith("27328 1\n777 2\n368 3\n");
    const onViolation = vi.fn();
    const unwatch = guard.watch(13942, onViolation);

    await guard.checkNow();

    expect(onViolation).not.toHaveBeenCalled();
    expect(guard.watchedCount).toBe(1);
    unwatch();
    expect(guard.watchedCount).toBe(0);
  });

  it("does not run ps when every listener is on loopback", async () => {
    const runner = vi.fn(
      async (_file: string) => "tcp4 0 0 127.0.0.1.5173 *.* LISTEN 0 0 1 1 node:13942\n",
    );
    const guard = new LoopbackListenerGuard(runner, 60_000);
    const unwatch = guard.watch(13942, vi.fn());

    await guard.checkNow();

    expect(runner).toHaveBeenCalledWith("netstat", ["-anv", "-p", "tcp"]);
    expect(runner.mock.calls.some(([file]) => file === "ps")).toBe(false);
    unwatch();
  });
});
