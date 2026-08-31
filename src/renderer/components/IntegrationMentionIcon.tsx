import { createElement } from "react";

type IconNode = {
  tag: "circle" | "line" | "path" | "polygon" | "polyline" | "rect";
  attrs: Record<string, string | number>;
};

type IntegrationIconMeta = {
  glyph: string;
  bg: string;
  fg?: string;
  nodes?: IconNode[];
};

const mailIcon: IconNode[] = [
  { tag: "rect", attrs: { x: 3, y: 5, width: 18, height: 14, rx: 2 } },
  { tag: "path", attrs: { d: "m3 7 9 6 9-6" } },
];

const messageIcon: IconNode[] = [
  { tag: "path", attrs: { d: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" } },
];

const ICON_META: Record<string, IntegrationIconMeta> = {
  gmail: { glyph: "M", bg: "#f2f4f7", fg: "#d93025", nodes: mailIcon },
  "google-drive": {
    glyph: "D",
    bg: "#e8f0fe",
    fg: "#188038",
    nodes: [
      { tag: "polygon", attrs: { points: "8 3 13 3 21 17 16 17" } },
      { tag: "polygon", attrs: { points: "8 3 3 12 8 21 16 17" } },
      { tag: "line", attrs: { x1: 3, y1: 12, x2: 11, y2: 12 } },
    ],
  },
  "google-calendar": {
    glyph: "31",
    bg: "#e8f0fe",
    fg: "#1a73e8",
    nodes: [
      { tag: "rect", attrs: { x: 3, y: 4, width: 18, height: 17, rx: 2 } },
      { tag: "line", attrs: { x1: 8, y1: 2, x2: 8, y2: 6 } },
      { tag: "line", attrs: { x1: 16, y1: 2, x2: 16, y2: 6 } },
      { tag: "line", attrs: { x1: 3, y1: 10, x2: 21, y2: 10 } },
      { tag: "path", attrs: { d: "M9 15h6M12 12v6" } },
    ],
  },
  "google-docs": {
    glyph: "D",
    bg: "#e8f0fe",
    fg: "#1a73e8",
    nodes: [
      { tag: "path", attrs: { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" } },
      { tag: "polyline", attrs: { points: "14 2 14 8 20 8" } },
      { tag: "line", attrs: { x1: 8, y1: 13, x2: 16, y2: 13 } },
      { tag: "line", attrs: { x1: 8, y1: 17, x2: 14, y2: 17 } },
    ],
  },
  "google-sheets": {
    glyph: "S",
    bg: "#e6f4ea",
    fg: "#188038",
    nodes: [
      { tag: "rect", attrs: { x: 4, y: 4, width: 16, height: 16, rx: 2 } },
      { tag: "line", attrs: { x1: 4, y1: 10, x2: 20, y2: 10 } },
      { tag: "line", attrs: { x1: 4, y1: 15, x2: 20, y2: 15 } },
      { tag: "line", attrs: { x1: 10, y1: 10, x2: 10, y2: 20 } },
      { tag: "line", attrs: { x1: 15, y1: 10, x2: 15, y2: 20 } },
    ],
  },
  "google-tasks": {
    glyph: "T",
    bg: "#e8f0fe",
    fg: "#1a73e8",
    nodes: [
      { tag: "rect", attrs: { x: 4, y: 4, width: 16, height: 16, rx: 2 } },
      { tag: "path", attrs: { d: "m8 9 2 2 4-4" } },
      { tag: "path", attrs: { d: "m8 15 2 2 6-6" } },
    ],
  },
  "google-slides": {
    glyph: "P",
    bg: "#fef7e0",
    fg: "#f29900",
    nodes: [
      { tag: "rect", attrs: { x: 3, y: 4, width: 18, height: 13, rx: 2 } },
      { tag: "line", attrs: { x1: 12, y1: 17, x2: 12, y2: 21 } },
      { tag: "line", attrs: { x1: 8, y1: 21, x2: 16, y2: 21 } },
      { tag: "path", attrs: { d: "M8 10h8" } },
    ],
  },
  "google-chat": { glyph: "C", bg: "#e6f4ea", fg: "#188038", nodes: messageIcon },
  slack: {
    glyph: "#",
    bg: "#f3e8ff",
    fg: "#611f69",
    nodes: [
      { tag: "line", attrs: { x1: 9, y1: 5, x2: 9, y2: 19 } },
      { tag: "line", attrs: { x1: 15, y1: 5, x2: 15, y2: 19 } },
      { tag: "line", attrs: { x1: 5, y1: 9, x2: 19, y2: 9 } },
      { tag: "line", attrs: { x1: 5, y1: 15, x2: 19, y2: 15 } },
    ],
  },
  notion: {
    glyph: "N",
    bg: "#f4f4f5",
    fg: "#111827",
    nodes: [
      { tag: "rect", attrs: { x: 5, y: 4, width: 14, height: 16, rx: 2 } },
      { tag: "path", attrs: { d: "M9 16V8h1.5l4 8V8" } },
    ],
  },
  box: {
    glyph: "B",
    bg: "#e0f2fe",
    fg: "#0061d5",
    nodes: [
      { tag: "path", attrs: { d: "m21 8-9-5-9 5 9 5 9-5z" } },
      { tag: "path", attrs: { d: "M3 8v8l9 5 9-5V8" } },
      { tag: "path", attrs: { d: "M12 13v8" } },
    ],
  },
  onedrive: {
    glyph: "O",
    bg: "#e0f2fe",
    fg: "#0369a1",
    nodes: [
      { tag: "path", attrs: { d: "M17 18H8a5 5 0 1 1 1.7-9.7A6 6 0 0 1 21 11a4 4 0 0 1-4 7z" } },
    ],
  },
  sharepoint: {
    glyph: "S",
    bg: "#ccfbf1",
    fg: "#0078d4",
    nodes: [
      { tag: "circle", attrs: { cx: 7, cy: 12, r: 3 } },
      { tag: "circle", attrs: { cx: 17, cy: 7, r: 3 } },
      { tag: "circle", attrs: { cx: 17, cy: 17, r: 3 } },
      { tag: "line", attrs: { x1: 10, y1: 11, x2: 14, y2: 8 } },
      { tag: "line", attrs: { x1: 10, y1: 13, x2: 14, y2: 16 } },
    ],
  },
  dropbox: {
    glyph: "D",
    bg: "#dbeafe",
    fg: "#0061ff",
    nodes: [
      { tag: "polygon", attrs: { points: "7 3 12 6 7 9 2 6" } },
      { tag: "polygon", attrs: { points: "17 3 22 6 17 9 12 6" } },
      { tag: "polygon", attrs: { points: "7 11 12 14 7 17 2 14" } },
      { tag: "polygon", attrs: { points: "17 11 22 14 17 17 12 14" } },
      { tag: "polygon", attrs: { points: "12 16 17 19 12 22 7 19" } },
    ],
  },
  agentmail: { glyph: "A", bg: "#ffedd5", fg: "#ea580c", nodes: mailIcon },
  inbox: {
    glyph: "@",
    bg: "#ede9fe",
    fg: "#7c3aed",
    nodes: [
      { tag: "path", attrs: { d: "M22 12h-6l-2 3h-4l-2-3H2" } },
      { tag: "path", attrs: { d: "M5 12V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7" } },
      { tag: "path", attrs: { d: "M5 12v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" } },
    ],
  },
  discord: {
    glyph: "D",
    bg: "#eef2ff",
    fg: "#5865f2",
    nodes: [
      {
        tag: "path",
        attrs: { d: "M8 7a14 14 0 0 1 8 0l2 9a9 9 0 0 1-4 2l-1-2h-2l-1 2a9 9 0 0 1-4-2z" },
      },
      { tag: "circle", attrs: { cx: 10, cy: 12, r: 1 } },
      { tag: "circle", attrs: { cx: 14, cy: 12, r: 1 } },
    ],
  },
  teams: {
    glyph: "T",
    bg: "#eef2ff",
    fg: "#6264a7",
    nodes: [
      { tag: "circle", attrs: { cx: 9, cy: 8, r: 3 } },
      { tag: "circle", attrs: { cx: 17, cy: 9, r: 2 } },
      { tag: "path", attrs: { d: "M4 20a5 5 0 0 1 10 0" } },
      { tag: "path", attrs: { d: "M14 17a4 4 0 0 1 6 3" } },
    ],
  },
  telegram: {
    glyph: "T",
    bg: "#e0f2fe",
    fg: "#229ed9",
    nodes: [
      { tag: "path", attrs: { d: "m22 2-7 20-4-9-9-4z" } },
      { tag: "path", attrs: { d: "M22 2 11 13" } },
    ],
  },
  whatsapp: {
    glyph: "W",
    bg: "#dcfce7",
    fg: "#128c7e",
    nodes: [
      {
        tag: "path",
        attrs: { d: "M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.4A8.5 8.5 0 1 1 21 11.5z" },
      },
      { tag: "path", attrs: { d: "M9 8c1 4 3 6 7 7" } },
    ],
  },
  signal: {
    glyph: "S",
    bg: "#dbeafe",
    fg: "#3a76f0",
    nodes: [...messageIcon, { tag: "path", attrs: { d: "M9 12h6" } }],
  },
  imessage: { glyph: "i", bg: "#dcfce7", fg: "#22c55e", nodes: messageIcon },
  email: { glyph: "@", bg: "#f1f5f9", fg: "#475569", nodes: mailIcon },
  browser: {
    glyph: "B",
    bg: "#dbeafe",
    fg: "#1d4ed8",
    nodes: [
      { tag: "circle", attrs: { cx: 12, cy: 12, r: 9 } },
      { tag: "path", attrs: { d: "M3 12h18" } },
      { tag: "path", attrs: { d: "M12 3a14 14 0 0 1 0 18" } },
      { tag: "path", attrs: { d: "M12 3a14 14 0 0 0 0 18" } },
    ],
  },
  x: {
    glyph: "X",
    bg: "#f4f4f5",
    fg: "#111827",
    nodes: [
      { tag: "line", attrs: { x1: 6, y1: 6, x2: 18, y2: 18 } },
      { tag: "line", attrs: { x1: 18, y1: 6, x2: 6, y2: 18 } },
    ],
  },
  mcp: {
    glyph: "M",
    bg: "#ede9fe",
    fg: "#6d28d9",
    nodes: [
      { tag: "rect", attrs: { x: 4, y: 4, width: 16, height: 16, rx: 2 } },
      { tag: "path", attrs: { d: "M8 12h8M12 8v8" } },
    ],
  },
};

function fallbackGlyph(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "I";
  return trimmed.slice(0, 1).toUpperCase();
}

export function getIntegrationMentionIconMeta(iconKey: string | undefined, label: string) {
  const meta = (iconKey && ICON_META[iconKey]) || ICON_META.mcp;
  return {
    glyph: meta.glyph || fallbackGlyph(label),
    bg: meta.bg,
    fg: meta.fg || "#111827",
    nodes: meta.nodes,
  };
}

function SvgIcon({ nodes }: { nodes: IconNode[] }) {
  return (
    <svg
      className="integration-mention-icon-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {nodes.map((node, index) => createElement(node.tag, { key: index, ...node.attrs }))}
    </svg>
  );
}

function appendSvgIcon(target: HTMLElement, nodes: IconNode[]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "integration-mention-icon-svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const node of nodes) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", node.tag);
    Object.entries(node.attrs).forEach(([key, value]) => {
      child.setAttribute(key, String(value));
    });
    svg.appendChild(child);
  }

  target.appendChild(svg);
}

export function renderIntegrationMentionIconContent(
  target: HTMLElement,
  iconKey: string | undefined,
  label: string,
) {
  const meta = getIntegrationMentionIconMeta(iconKey, label);
  target.style.backgroundColor = meta.bg;
  target.style.color = meta.fg;
  target.replaceChildren();
  if (meta.nodes) {
    appendSvgIcon(target, meta.nodes);
  } else {
    target.textContent = meta.glyph;
  }
}

export function IntegrationMentionIcon({
  iconKey,
  label,
  size = "sm",
}: {
  iconKey?: string;
  label: string;
  size?: "xs" | "sm";
}) {
  const meta = getIntegrationMentionIconMeta(iconKey, label);
  return (
    <span
      className={`integration-mention-icon integration-mention-icon-${size}`}
      style={{ backgroundColor: meta.bg, color: meta.fg }}
      aria-hidden="true"
    >
      {meta.nodes ? <SvgIcon nodes={meta.nodes} /> : meta.glyph}
    </span>
  );
}
