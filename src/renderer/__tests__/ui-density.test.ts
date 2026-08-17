import fs from "fs";
import path from "path";
import vm from "vm";
import { describe, expect, it } from "vitest";
import { applyUiDensityClass } from "../utils/ui-density";

function createClassList(initialClasses: string[]) {
  const classes = new Set(initialClasses);
  return {
    add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
    remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
    values: () => [...classes],
  };
}

describe("UI density classes", () => {
  it("removes every stale density class before applying the selected density", () => {
    const classList = createClassList(["theme-dark", "density-power"]);

    applyUiDensityClass({ classList }, "focused");

    expect(classList.values()).toEqual(["theme-dark", "density-focused"]);
  });

  it("restores power density during first-paint bootstrap", () => {
    const bootstrapPath = path.resolve(__dirname, "../public/density-bootstrap.js");
    const bootstrapScript = fs.readFileSync(bootstrapPath, "utf-8");
    const classList = createClassList(["theme-dark", "density-focused", "density-full"]);

    vm.runInNewContext(bootstrapScript, {
      document: { documentElement: { classList } },
      localStorage: { getItem: () => "power" },
    });

    expect(classList.values()).toEqual(["theme-dark", "density-power"]);
  });
});
