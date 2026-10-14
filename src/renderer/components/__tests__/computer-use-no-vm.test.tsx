import { expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(initial === true ? false : initial === "" ? "darwin" : initial),
  };
});
vi.mock("../../host/browser-capabilities", () => ({
  hasHostMethods: () => true,
}));
import { ComputerUseSettings } from "../ComputerUseSettings";
it("shows native computer controls without VM connection configuration", () => {
  const html = renderToStaticMarkup(React.createElement(ComputerUseSettings));
  expect(html.toLowerCase()).toContain("computer use");
  expect(html).not.toContain("Application workers");
  expect(html).not.toContain("Import connection");
  expect(html).not.toContain("Connect application worker");
});
