/**
 * A small fake browser page for testing the visible workbench action paths
 * without a real browser: a DOM with absolute layout rects, hit testing,
 * capture/bubble events, focus, form defaults, a React-style controlled input,
 * and a Chrome DevTools Protocol `debugger` plus the Electron webContents
 * methods the services use. Page scripts are evaluated with `document`,
 * `window` and `Event` bound to this fake.
 */

type Listener = (event: FakeEvent) => void;
type Rect = { x: number; y: number; width: number; height: number };

export class FakeEvent {
  type: string;
  bubbles: boolean;
  isTrusted = false;
  target: FakeElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  key?: string;
  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

let nextBackendNodeId = 1;

/** The node followed by its ancestors. */
function* selfAndAncestors<T extends FakeNode>(start: T): Generator<T> {
  for (let node: FakeNode | null = start; node; node = node.parentNode) yield node as T;
}

export class FakeNode {
  nodeType: number;
  parentNode: FakeElement | null = null;
  backendNodeId = nextBackendNodeId++;
  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get isConnected(): boolean {
    for (const node of selfAndAncestors<FakeNode>(this)) {
      if (node instanceof FakeElement && node.isDocumentRoot) return true;
    }
    return false;
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super(3);
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

const FOCUSABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);

export class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  childNodes: FakeNode[] = [];
  rect: Rect | null = null;
  style: { display?: string; visibility?: string; pointerEvents?: string } = {};
  z = 0;
  fixed = false;
  isDocumentRoot = false;
  page!: FakePage;
  listeners: Array<{ type: string; fn: Listener; capture: boolean }> = [];
  onclick: Listener | null = null;
  checked = false;
  disabled = false;
  readOnly = false;

  constructor(tagName: string) {
    super(1);
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }
  get id(): string {
    return this.getAttribute("id") || "";
  }
  get className(): string {
    return this.getAttribute("class") || "";
  }
  get textContent(): string {
    return this.childNodes.map((node) => (node as FakeText | FakeElement).textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(value));
  }
  get innerText(): string {
    return this.textContent;
  }
  get isContentEditable(): boolean {
    const value = this.getAttribute("contenteditable");
    return value !== null && value !== "false";
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get ownerDocument(): FakeDocument {
    return this.page.document;
  }
  get control(): FakeElement | null {
    if (this.tagName !== "LABEL") return null;
    const target = this.getAttribute("for");
    if (target) return this.page.document.getElementById(target);
    return this.querySelectorAll("input, textarea, select")[0] || null;
  }
  get form(): FakeElement | null {
    return this.closest("form");
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this;
    this.childNodes.push(node);
    if (node instanceof FakeElement) node.adopt(this.page);
    return node;
  }
  adopt(page: FakePage): void {
    this.page = page;
    for (const child of this.children) child.adopt(page);
  }
  remove(): void {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode = null;
    this.page.detached.set(this.backendNodeId, this);
  }
  replaceWith(node: FakeElement): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    node.parentNode = parent;
    node.adopt(this.page);
    parent.childNodes.splice(index, 1, node);
    this.parentNode = null;
    this.page.detached.set(this.backendNodeId, this);
  }
  contains(node: FakeNode | null): boolean {
    let current: FakeNode | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (element: FakeElement) => {
      for (const child of element.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const groups = parseSelectorList(selector);
    return this.descendants().filter((element) =>
      groups.some((group) => matchComplex(element, group)),
    );
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  matches(selector: string): boolean {
    return parseSelectorList(selector).some((group) => matchComplex(this, group));
  }
  closest(selector: string): FakeElement | null {
    for (const element of selfAndAncestors<FakeElement>(this)) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
  isRendered(): boolean {
    for (const element of selfAndAncestors<FakeElement>(this)) {
      if (element.style.display === "none") return false;
    }
    return Boolean(this.rect && this.rect.width > 0 && this.rect.height > 0);
  }
  getBoundingClientRect(): Rect & { left: number; top: number; right: number; bottom: number } {
    const rect = this.isRendered() && this.rect ? this.rect : { x: 0, y: 0, width: 0, height: 0 };
    const scrollY = this.fixed ? 0 : this.page.scrollY;
    const y = rect.y - scrollY;
    return {
      x: rect.x,
      y,
      width: rect.width,
      height: rect.height,
      left: rect.x,
      top: y,
      right: rect.x + rect.width,
      bottom: y + rect.height,
    };
  }
  scrollIntoView(): void {
    this.page.scrollElementIntoView(this);
  }
  addEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners = this.listeners.filter(
      (entry) => !(entry.type === type && entry.fn === fn && entry.capture === capture),
    );
  }
  dispatchEvent(event: FakeEvent): boolean {
    return this.page.dispatch(this, event);
  }
  focus(): void {
    if (this.isFocusable()) this.page.document.activeElement = this;
  }
  isFocusable(): boolean {
    if (this.disabled) return false;
    return (
      FOCUSABLE_TAGS.has(this.tagName) ||
      this.isContentEditable ||
      (this.getAttribute("tabindex") !== null && this.getAttribute("tabindex") !== "-1")
    );
  }
  click(): void {
    this.page.dispatch(this, Object.assign(new FakeEvent("click", { bubbles: true })));
  }
}

/** Input/textarea with the `value` accessor on the prototype, like HTMLInputElement. */
export class FakeInputElement extends FakeElement {
  _value = "";
  selectionStart = 0;
  selectionEnd = 0;
  get maxLength(): number {
    const raw = this.getAttribute("maxlength");
    return raw === null ? -1 : Number(raw);
  }
  select(): void {
    this.selectionStart = 0;
    this.selectionEnd = this._value.length;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  /** Trusted text insertion at the selection, honoring maxlength. */
  insertAtSelection(text: string): void {
    const before = this._value.slice(0, this.selectionStart);
    const after = this._value.slice(this.selectionEnd);
    let inserted = text;
    if (this.maxLength >= 0) {
      inserted = inserted.slice(0, Math.max(0, this.maxLength - before.length - after.length));
    }
    this._value = before + inserted + after;
    this.selectionStart = this.selectionEnd = before.length + inserted.length;
  }
}
Object.defineProperty(FakeInputElement.prototype, "value", {
  configurable: true,
  get(this: FakeInputElement) {
    return this._value;
  },
  set(this: FakeInputElement, value: string) {
    this._value = String(value);
    this.selectionStart = this.selectionEnd = this._value.length;
  },
});

export class FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor(private page: FakePage) {
    this.documentElement = new FakeElement("html");
    this.documentElement.isDocumentRoot = true;
    this.documentElement.page = page;
    this.documentElement.rect = { x: 0, y: 0, width: page.viewport.width, height: page.pageHeight };
    this.body = this.documentElement.appendChild(new FakeElement("body"));
    this.body.rect = { ...this.documentElement.rect };
  }
  querySelectorAll(selector: string): FakeElement[] {
    const groups = parseSelectorList(selector);
    return [this.documentElement, ...this.documentElement.descendants()].filter((element) =>
      groups.some((group) => matchComplex(element, group)),
    );
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll("*").find((element) => element.id === id) || null;
  }
  get defaultView(): unknown {
    return null;
  }
}

/** React's controlled-input value tracking, reduced to what matters for fill. */
export function makeReactControlled(input: FakeInputElement): { state: () => string } {
  const proto = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value")!;
  let tracked = descriptor.get!.call(input) as string;
  let state = tracked;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return descriptor.get!.call(input);
    },
    set(value: string) {
      tracked = String(value);
      descriptor.set!.call(input, value);
    },
  });
  input.page.document.documentElement.addEventListener("input", (event) => {
    if (event.target !== input) return;
    const current = descriptor.get!.call(input) as string;
    if (current === tracked) return; // React: value did not change, no onChange
    tracked = current;
    state = current;
  });
  return { state: () => state };
}

type Spec = {
  tag: string;
  attrs?: Record<string, string>;
  rect?: Rect;
  style?: FakeElement["style"];
  z?: number;
  fixed?: boolean;
  disabled?: boolean;
  onclick?: Listener;
  children?: Array<Spec | string>;
};

export function el(
  tag: string,
  options: Omit<Spec, "tag" | "children"> = {},
  ...children: Array<Spec | string>
): Spec {
  return { tag, ...options, children };
}

export class FakePage {
  viewport = { width: 800, height: 600 };
  pageHeight = 3000;
  scrollY = 0;
  url = "https://example.test/start";
  document!: FakeDocument;
  log: string[] = [];
  submitted: string[] = [];
  cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private objects = new Map<string, unknown>();
  private nextObjectId = 1;
  private messageHandlers: Array<(...args: unknown[]) => void> = [];

  constructor() {
    this.reset();
  }

  reset(url?: string): void {
    this.document = new FakeDocument(this);
    this.scrollY = 0;
    if (url) this.url = url;
  }

  /** Replace the document as a navigation does, and emit Page.frameNavigated. */
  navigate(url: string, ...body: Array<Spec | string>): void {
    this.reset(url);
    this.mount(...body);
    for (const handler of this.messageHandlers) {
      handler({}, "Page.frameNavigated", { frame: { id: "main", url } });
    }
  }

  mount(...body: Array<Spec | string>): FakeElement[] {
    return body
      .map((spec) => this.build(spec, this.document.body))
      .filter(Boolean) as FakeElement[];
  }

  private build(spec: Spec | string, parent: FakeElement): FakeElement | null {
    if (typeof spec === "string") {
      parent.appendChild(new FakeText(spec));
      return null;
    }
    const tag = spec.tag.toLowerCase();
    const element =
      tag === "input" || tag === "textarea" ? new FakeInputElement(tag) : new FakeElement(tag);
    parent.appendChild(element);
    for (const [name, value] of Object.entries(spec.attrs || {})) element.setAttribute(name, value);
    if (element instanceof FakeInputElement && spec.attrs?.value) element._value = spec.attrs.value;
    element.rect = spec.rect || null;
    element.style = spec.style || {};
    element.z = spec.z || 0;
    element.fixed = spec.fixed === true;
    element.disabled = spec.disabled === true;
    if (spec.onclick) element.onclick = spec.onclick;
    for (const child of spec.children || []) this.build(child, element);
    return element;
  }

  byId(id: string): FakeElement {
    const found = this.document.getElementById(id);
    if (!found) throw new Error(`no #${id}`);
    return found;
  }

  scrollElementIntoView(element: FakeElement): void {
    if (element.fixed || !element.rect) return;
    const top = element.rect.y - this.scrollY;
    if (top >= 0 && top + element.rect.height <= this.viewport.height) return;
    const centered = element.rect.y - (this.viewport.height - element.rect.height) / 2;
    this.scrollY = Math.max(
      0,
      Math.min(this.pageHeight - this.viewport.height, Math.round(centered)),
    );
  }

  /** Topmost rendered element at a viewport point. */
  elementAt(x: number, y: number): FakeElement | null {
    const all = [this.document.documentElement, ...this.document.documentElement.descendants()];
    let best: FakeElement | null = null;
    for (const element of all) {
      if (!element.isRendered() || element.style.pointerEvents === "none") continue;
      const rect = element.getBoundingClientRect();
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
      if (!best || element.z >= best.z) best = element;
    }
    return best;
  }

  dispatch(target: FakeElement, event: FakeEvent): boolean {
    event.target = target;
    const path: FakeElement[] = [];
    for (let node: FakeElement | null = target; node; node = node.parentNode) path.unshift(node);
    const invoke = (node: FakeElement, capture: boolean) => {
      for (const entry of node.listeners.slice()) {
        if (entry.type === event.type && entry.capture === capture) entry.fn(event);
      }
    };
    for (const node of path.slice(0, -1)) {
      if (event.propagationStopped) break;
      invoke(node, true);
    }
    if (!event.propagationStopped) {
      invoke(target, true);
      invoke(target, false);
      if (event.type === "click" && target.onclick) target.onclick(event);
    }
    if (event.bubbles) {
      for (const node of path.slice(0, -1).reverse()) {
        if (event.propagationStopped) break;
        invoke(node, false);
        if (event.type === "click" && node.onclick) node.onclick(event);
      }
    }
    if (!event.defaultPrevented) this.defaultAction(target, event);
    return !event.defaultPrevented;
  }

  private defaultAction(target: FakeElement, event: FakeEvent): void {
    if (event.type !== "click") return;
    const control = target.closest("label")?.control;
    if (control && control !== target && !control.contains(target)) {
      this.dispatch(
        control,
        Object.assign(new FakeEvent("click", { bubbles: true }), { isTrusted: true }),
      );
      return;
    }
    if (target.tagName === "INPUT" && target.getAttribute("type") === "checkbox") {
      target.checked = !target.checked;
    }
    const button = target.closest("button");
    if (button && (button.getAttribute("type") || "submit") === "submit" && button.form) {
      this.submit(button.form);
    }
  }

  private submit(form: FakeElement): void {
    const event = new FakeEvent("submit", { bubbles: true });
    if (this.dispatch(form, event)) this.submitted.push(form.id || "form");
  }

  private trusted(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    return Object.assign(new FakeEvent(type, { bubbles: true }), { isTrusted: true }, extra);
  }

  private insertText(text: string): void {
    const active = this.document.activeElement;
    if (!active) return;
    if (active instanceof FakeInputElement) {
      if (active.readOnly || active.disabled) return;
      active.insertAtSelection(text);
      this.dispatch(active, this.trusted("input"));
    } else if (active.isContentEditable) {
      // The fake keeps no selection inside contenteditable: insertText replaces after select-all.
      active.textContent =
        (active.getAttribute("data-selected-all") === "1" ? "" : active.textContent) + text;
      active.setAttribute("data-selected-all", "0");
      this.dispatch(active, this.trusted("input"));
    }
  }

  private deleteSelection(): void {
    const active = this.document.activeElement;
    if (active instanceof FakeInputElement) {
      if (active.selectionStart === active.selectionEnd && active.selectionStart > 0) {
        active.selectionStart -= 1;
      }
      active.insertAtSelection("");
      this.dispatch(active, this.trusted("input"));
    }
  }

  private focusNext(): void {
    const focusables = this.document
      .querySelectorAll("*")
      .filter((element) => element.isFocusable());
    const index = focusables.indexOf(this.document.activeElement as FakeElement);
    this.document.activeElement = focusables[index + 1] || null;
  }

  /** Globals visible to page scripts. */
  globals(): Record<string, unknown> {
    const location = {};
    Object.defineProperty(location, "href", { get: () => this.url });
    const win = {
      innerWidth: this.viewport.width,
      innerHeight: this.viewport.height,
      getComputedStyle: (element: FakeElement) => ({
        display: element.style.display || "block",
        visibility: element.style.visibility || "visible",
      }),
      getSelection: () => ({
        removeAllRanges() {},
        addRange(range: { node: FakeElement }) {
          range.node.setAttribute("data-selected-all", "1");
        },
      }),
      scrollTo: () => undefined,
      scrollBy: () => undefined,
    };
    Object.defineProperty(win, "scrollY", { get: () => this.scrollY });
    return { document: this.document, window: win, Event: FakeEvent, location };
  }

  evaluate(code: string, thisArg?: unknown, args: unknown[] = []): unknown {
    const globals = this.globals();
    const names = Object.keys(globals);
    (this.document as unknown as { createRange: () => unknown }).createRange = () => ({
      node: null as FakeElement | null,
      selectNodeContents(node: FakeElement) {
        this.node = node;
      },
    });
    const fn = new Function(...names, `return (${code});`);
    const value = fn(...names.map((name) => globals[name]));
    return thisArg === undefined
      ? value
      : (value as (...a: unknown[]) => unknown).apply(thisArg, args);
  }

  private remote(value: unknown): Record<string, unknown> {
    if (value instanceof FakeNode) {
      const objectId = `obj-${this.nextObjectId++}`;
      this.objects.set(objectId, value);
      return { type: "object", subtype: "node", objectId };
    }
    if (value === null) return { type: "object", subtype: "null", value: null };
    return { type: typeof value, value };
  }

  private nodeByBackendId(backendNodeId: unknown): FakeNode | undefined {
    const visit = (element: FakeElement): FakeNode | undefined => {
      if (element.backendNodeId === backendNodeId) return element;
      for (const child of element.childNodes) {
        if (child.backendNodeId === backendNodeId) return child;
        if (child instanceof FakeElement) {
          const found = visit(child);
          if (found) return found;
        }
      }
      return undefined;
    };
    return visit(this.document.documentElement) || this.detached.get(Number(backendNodeId));
  }

  /** Nodes removed from the document stay resolvable, like real backend node ids. */
  detached = new Map<number, FakeNode>();

  private quadsFor(element: FakeElement): number[][] {
    if (!element.isConnected || !element.isRendered()) {
      throw new Error("Could not compute content quads.");
    }
    const rect = element.getBoundingClientRect();
    return [
      [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom],
    ];
  }

  /** Accessibility tree: one node per role-bearing element, with StaticText children. */
  private axTree(): Array<Record<string, unknown>> {
    const nodes: Array<Record<string, unknown>> = [];
    const roleOf = (element: FakeElement): string => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      if (element.tagName === "BUTTON") return "button";
      if (element.tagName === "A") return "link";
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") return "textbox";
      if (/^H[1-6]$/.test(element.tagName)) return "heading";
      if (element.tagName === "NAV") return "navigation";
      return "";
    };
    nodes.push({ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Fake" } });
    const walk = (element: FakeElement, parentId: string) => {
      for (const child of element.childNodes) {
        if (child instanceof FakeText) {
          if (!child.data.trim()) continue;
          nodes.push({
            nodeId: `t${child.backendNodeId}`,
            parentId,
            role: { value: "StaticText" },
            name: { value: child.data.trim() },
            backendDOMNodeId: child.backendNodeId,
          });
          continue;
        }
        const element = child as FakeElement;
        if (element.style.display === "none") continue;
        const role = roleOf(element);
        let id = parentId;
        if (role) {
          id = `n${element.backendNodeId}`;
          nodes.push({
            nodeId: id,
            parentId,
            role: { value: role },
            name: {
              value:
                role === "navigation"
                  ? ""
                  : element.getAttribute("aria-label") || element.textContent.trim(),
            },
            backendDOMNodeId: element.backendNodeId,
          });
        }
        walk(element, id);
      }
    };
    walk(this.document.documentElement, "root");
    return nodes;
  }

  private send(method: string, params: Record<string, unknown> = {}): unknown {
    this.cdpCalls.push({ method, params });
    switch (method) {
      case "Runtime.evaluate": {
        try {
          const value = this.evaluate(String(params.expression));
          return params.returnByValue
            ? { result: { type: typeof value, value } }
            : { result: this.remote(value) };
        } catch (error) {
          return { exceptionDetails: { text: String((error as Error).message) } };
        }
      }
      case "Runtime.callFunctionOn": {
        const target = this.objects.get(String(params.objectId));
        const args = ((params.arguments as Array<Record<string, unknown>>) || []).map((arg) =>
          "objectId" in arg ? this.objects.get(String(arg.objectId)) : arg.value,
        );
        const value = this.evaluate(String(params.functionDeclaration), target, args);
        return { result: { type: typeof value, value } };
      }
      case "DOM.describeNode": {
        const node = this.objects.get(String(params.objectId)) as FakeNode;
        return { node: { backendNodeId: node.backendNodeId } };
      }
      case "DOM.resolveNode": {
        const node = this.nodeByBackendId(params.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        return { object: this.remote(node) };
      }
      case "DOM.scrollIntoViewIfNeeded": {
        const node = this.nodeByBackendId(params.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        if (!node.isConnected) throw new Error("Node is detached from document");
        const element = node instanceof FakeElement ? node : node.parentElement;
        if (element) this.scrollElementIntoView(element);
        return {};
      }
      case "DOM.getContentQuads": {
        const node = this.nodeByBackendId(params.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        const element = node instanceof FakeElement ? node : (node.parentElement as FakeElement);
        return { quads: this.quadsFor(element) };
      }
      case "DOM.getBoxModel": {
        const node = this.nodeByBackendId(params.backendNodeId);
        if (!node) throw new Error("No node with given id found");
        const element = node instanceof FakeElement ? node : (node.parentElement as FakeElement);
        if (!element.isConnected || !element.isRendered())
          throw new Error("Could not compute box model.");
        return { model: { border: this.quadsFor(element)[0] } };
      }
      case "DOM.getNodeForLocation": {
        // Document coordinates, like Chrome.
        const hit = this.elementAt(Number(params.x), Number(params.y) - this.scrollY);
        if (!hit) throw new Error("No node found at given location");
        return { backendNodeId: hit.backendNodeId, frameId: "main" };
      }
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: {
            clientWidth: this.viewport.width,
            clientHeight: this.viewport.height,
            pageX: 0,
            pageY: this.scrollY,
          },
        };
      case "Accessibility.getFullAXTree":
        return { nodes: this.axTree() };
      case "Input.dispatchMouseEvent": {
        const x = Number(params.x);
        const y = Number(params.y);
        const hit = this.elementAt(x, y);
        this.log.push(`${params.type}@${x},${y}:${hit ? hit.id || hit.tagName : "none"}`);
        if (!hit || hit.disabled) return {};
        if (params.type === "mousePressed") {
          this.dispatch(hit, this.trusted("mousedown"));
          let focusTarget: FakeElement | null = hit;
          while (focusTarget && !focusTarget.isFocusable()) focusTarget = focusTarget.parentNode;
          if (focusTarget) focusTarget.focus();
        } else if (params.type === "mouseReleased") {
          this.dispatch(hit, this.trusted("mouseup"));
          this.dispatch(hit, this.trusted("click"));
        }
        return {};
      }
      case "Input.insertText":
        this.insertText(String(params.text));
        return {};
      case "Input.dispatchKeyEvent": {
        const active = this.document.activeElement || this.document.body;
        if (params.type === "keyUp") {
          this.dispatch(active, this.trusted("keyup", { key: String(params.key) }));
          return {};
        }
        const allowed = this.dispatch(active, this.trusted("keydown", { key: String(params.key) }));
        if (!allowed) return {};
        if (params.key === "Enter" && params.text === "\r") {
          const form = active.closest("form");
          if (active instanceof FakeInputElement && form) this.submit(form);
        } else if (params.key === "Tab") {
          this.focusNext();
        } else if (params.key === "Backspace" || params.key === "Delete") {
          this.deleteSelection();
        } else if (params.type === "keyDown" && typeof params.text === "string") {
          this.insertText(params.text);
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** Electron webContents shape used by the workbench service and session manager. */
  contents(id = 7): Record<string, unknown> {
    return {
      id,
      getURL: () => this.url,
      getTitle: () => "Fake",
      isDestroyed: () => false,
      on() {},
      once() {},
      removeListener() {},
      executeJavaScript: async (code: string) => this.evaluate(code),
      // Electron sendInputEvent keyDown without a char event: no text, no default action.
      sendInputEvent: (event: { type: string; keyCode: string }) => {
        const active = this.document.activeElement || this.document.body;
        this.dispatch(active, this.trusted(event.type.toLowerCase(), { key: event.keyCode }));
      },
      insertText: async (text: string) => this.insertText(text),
      debugger: {
        isAttached: () => true,
        attach() {},
        on: (_event: string, handler: (...args: unknown[]) => void) => {
          this.messageHandlers.push(handler);
        },
        sendCommand: async (method: string, params?: Record<string, unknown>) =>
          this.send(method, params || {}),
      },
    };
  }
}

/* ---------- minimal CSS selector matching (tag, #id, .class, [attr], [attr=v], " ", ">") ---------- */

type Compound = {
  tag: string;
  ids: string[];
  classes: string[];
  attrs: Array<[string, string | null]>;
};
type Complex = Array<{ combinator: " " | ">"; compound: Compound }>;

function invalid(selector: string): Error {
  const error = new Error(`'${selector}' is not a valid selector.`);
  error.name = "SyntaxError";
  return error;
}

function parseCompound(text: string, whole: string): Compound {
  const match = /^(\*|[a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/.exec(text);
  if (!match) throw invalid(whole);
  const compound: Compound = {
    tag: (match[1] || "*").toUpperCase(),
    ids: [],
    classes: [],
    attrs: [],
  };
  const partRe =
    /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
  let part: RegExpExecArray | null;
  while ((part = partRe.exec(match[2] || ""))) {
    if (part[1]) compound.ids.push(part[1]);
    else if (part[2]) compound.classes.push(part[2]);
    else compound.attrs.push([part[3], part[4] ?? part[5] ?? part[6] ?? null]);
  }
  return compound;
}

function parseSelectorList(selector: string): Complex[] {
  return selector.split(",").map((group) => {
    const tokens = group
      .trim()
      .replace(/\s*>\s*/g, " > ")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) throw invalid(selector);
    const complex: Complex = [];
    let combinator: " " | ">" = " ";
    for (const token of tokens) {
      if (token === ">") {
        combinator = ">";
        continue;
      }
      complex.push({ combinator, compound: parseCompound(token, selector) });
      combinator = " ";
    }
    return complex;
  });
}

function matchCompound(element: FakeElement, compound: Compound): boolean {
  if (compound.tag !== "*" && element.tagName !== compound.tag) return false;
  if (compound.ids.some((id) => element.id !== id)) return false;
  const classes = element.className.split(/\s+/);
  if (compound.classes.some((cls) => !classes.includes(cls))) return false;
  return compound.attrs.every(([name, value]) =>
    value === null ? element.hasAttribute(name) : element.getAttribute(name) === value,
  );
}

function matchComplex(element: FakeElement, complex: Complex, index = complex.length - 1): boolean {
  if (!matchCompound(element, complex[index].compound)) return false;
  if (index === 0) return true;
  if (complex[index].combinator === ">") {
    return Boolean(element.parentNode && matchComplex(element.parentNode, complex, index - 1));
  }
  for (let parent = element.parentNode; parent; parent = parent.parentNode) {
    if (matchComplex(parent, complex, index - 1)) return true;
  }
  return false;
}
