import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const args of [["--help"], ["-h"], []]) {
  test(`coworkctl usage exit status for ${args.join(" ") || "missing command"}`, () => {
    const result = spawnSync(process.execPath, ["bin/coworkctl.js", ...args], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, COWORK_CONTROL_PLANE_TOKEN: "" },
    });
    assert.equal(result.status, args.length ? 0 : 1);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /Missing token|ECONNREFUSED/);
  });
}
