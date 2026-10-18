import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ElementFixture {
  readonly children: ElementFixture[] = [];
  readonly style = { cssText: "" };
  readonly attributes = new Map<string, string>();
  parent?: ElementFixture;

  appendChild(child: ElementFixture) {
    this.children.push(child);
    child.parent = this;
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function documentFixture() {
  const body = new ElementFixture();
  const application = body.appendChild(new ElementFixture());
  const userDiagram = body.appendChild(new ElementFixture());
  userDiagram.setAttribute("id", "dmermaid-user-owned");
  const document = {
    body,
    documentElement: { classList: { contains: () => false } },
    createElement: vi.fn(() => new ElementFixture()),
  };
  vi.stubGlobal("document", document);
  return { body, application, userDiagram, document };
}

describe("Mermaid temporary render ownership", () => {
  it.each(["parse", "draw"])(
    "retains %s errors while removing only its owned temporary DOM",
    async (phase) => {
      const { body, application, userDiagram } = documentFixture();
      const { renderMermaidChart } = await import("../markdown-components");
      type Api = Parameters<typeof renderMermaidChart>[0];
      const failure = new Error(`${phase} failed`);
      let target: ElementFixture | undefined;
      const initialize = vi.fn<Api["initialize"]>();
      const render = vi.fn<Api["render"]>(async (_id, _chart, container) => {
        target = container as unknown as ElementFixture;
        expect(target.parent).toBe(body);
        target.appendChild(new ElementFixture());
        throw failure;
      });

      await expect(
        renderMermaidChart({ initialize, render }, "mermaid-fixture", "invalid"),
      ).rejects.toBe(failure);

      expect(initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          suppressErrorRendering: true,
          securityLevel: "strict",
          htmlLabels: false,
        }),
      );
      expect(render).toHaveBeenCalledWith("mermaid-fixture", "invalid", target);
      expect(target?.attributes.get("aria-hidden")).toBe("true");
      expect(target?.parent).toBeUndefined();
      expect(body.children).toEqual([application, userDiagram]);
    },
  );

  it("cleans up late completion and can render successfully after an invalid chart", async () => {
    const { body, application, userDiagram } = documentFixture();
    const { renderMermaidChart } = await import("../markdown-components");
    type Api = Parameters<typeof renderMermaidChart>[0];
    const result = {
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      diagramType: "flowchart-v2",
    };
    let resolveRender!: (value: typeof result) => void;
    let target: ElementFixture | undefined;
    const api = {
      initialize: vi.fn<Api["initialize"]>(),
      render: vi.fn<Api["render"]>((_id, _chart, container) => {
        target = container as unknown as ElementFixture;
        return new Promise((resolve) => {
          resolveRender = resolve;
        });
      }),
    };
    const pending = renderMermaidChart(api, "mermaid-late", "flowchart TD; A-->B");
    expect(body.children).toHaveLength(3);
    // A component's cancellation guard still ignores this result; ownership
    // cleanup must be idempotent if its temporary host was already detached.
    target!.remove();
    resolveRender(result);
    await expect(pending).resolves.toEqual(result);
    expect(body.children).toEqual([application, userDiagram]);

    api.render.mockRejectedValueOnce(new Error("invalid chart"));
    await expect(renderMermaidChart(api, "mermaid-invalid", "invalid")).rejects.toThrow(
      "invalid chart",
    );
    api.render.mockResolvedValueOnce(result);
    await expect(
      renderMermaidChart(api, "mermaid-recovered", "flowchart TD; A-->B"),
    ).resolves.toEqual(result);
    expect(body.children).toEqual([application, userDiagram]);
    expect(api.initialize).toHaveBeenCalledOnce();
  });
});
