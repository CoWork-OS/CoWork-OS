/**
 * VisualTools
 *
 * Agent tools for "agentic image generation" style loops:
 * generate -> visually annotate -> refine -> repeat.
 *
 * This tool wraps Live Canvas to provide an in-app annotation UI for an image.
 * The canvas sends structured A2UI actions back to the running task so the agent
 * can regenerate and update the annotator for the next iteration.
 */

import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { CanvasManager } from "../../canvas/canvas-manager";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";

type VisualAnnotatorTarget = {
  kind?: string; // e.g. "blog_cover", "infographic", "social_story"
  usage?: string; // where it will be used (platform, context)
  size?: string; // e.g. "1200x630", "1080x1920"
  style?: string; // e.g. "minimal", "editorial", "flat infographic"
};

export type VisualAnnotationPayloadV1 = {
  version: 1;
  kind: "visual_annotation";
  image: {
    filename: string;
    originalPath?: string;
    iteration?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  target?: VisualAnnotatorTarget;
  notes: {
    global: string;
  };
  annotations: Array<{
    id: string;
    type: "rect" | "pen";
    note?: string;
    color: string;
    strokeWidth: number;
    // normalized to the *natural* image size, in [0,1]
    data:
      | { x: number; y: number; w: number; h: number }
      | { points: Array<{ x: number; y: number }> };
    createdAt: number;
  }>;
  export: {
    markdown: string;
  };
};

type AnnotatorBootstrap = {
  version: 1;
  sessionId: string;
  title: string;
  imageFilename: string;
  originalImagePath?: string;
  iteration?: number;
  target?: VisualAnnotatorTarget;
  instructions?: string;
};

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath));
  // Ensure the file is within the workspace root
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("imagePath must be within the workspace");
  }
  return abs;
}

function safeJsonForHtml(value: unknown): string {
  // Prevent breaking out of <script> by escaping "<" (covers "</script" and HTML tags).
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderVisualAnnotatorHtml(bootstrap: AnnotatorBootstrap): string {
  const bootstrapJson = safeJsonForHtml(bootstrap);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${"Visual Annotator"}</title>
  <style>
    :root{
      --bg0:#0b1020;
      --bg1:#0e1630;
      --panel:#111a36;
      --panel2:#0f1733;
      --text:#e8ecff;
      --muted:#a7b1d6;
      --line:rgba(255,255,255,.10);
      --accent:#59d6ff;
      --accent2:#a6ff6b;
      --danger:#ff5c7a;
      --shadow:0 20px 60px rgba(0,0,0,.35);
      --radius:16px;
      --mono: "SF Mono", "Fira Code", "Consolas", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;
      font-family:var(--sans);
      color:var(--text);
      background:
        radial-gradient(1200px 700px at 15% 0%, rgba(89,214,255,.12), transparent 60%),
        radial-gradient(900px 600px at 100% 15%, rgba(166,255,107,.10), transparent 60%),
        linear-gradient(180deg, var(--bg0), var(--bg1));
      overflow:hidden;
    }
    header{
      height:64px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:0 16px;
      border-bottom:1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,0));
      backdrop-filter: blur(8px);
    }
    .title{
      display:flex;
      flex-direction:column;
      gap:2px;
      min-width: 0;
    }
    .title h1{
      margin:0;
      font-size:14px;
      letter-spacing:.2px;
      font-weight:650;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .title .sub{
      font-size:12px;
      color:var(--muted);
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .actions{
      display:flex;
      gap:8px;
      align-items:center;
      flex: 0 0 auto;
    }
    button{
      font:inherit;
      color:var(--text);
      background:rgba(255,255,255,.06);
      border:1px solid var(--line);
      padding:8px 10px;
      border-radius:12px;
      cursor:pointer;
      transition:transform .06s ease, background .12s ease, border-color .12s ease;
    }
    button:hover{background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.14)}
    button:active{transform:translateY(1px)}
    button.primary{
      background: linear-gradient(180deg, rgba(89,214,255,.25), rgba(89,214,255,.08));
      border-color: rgba(89,214,255,.35);
      box-shadow: 0 0 0 1px rgba(89,214,255,.05), 0 10px 30px rgba(89,214,255,.10);
    }
    button.good{
      background: linear-gradient(180deg, rgba(166,255,107,.22), rgba(166,255,107,.08));
      border-color: rgba(166,255,107,.32);
    }
    button.danger{
      background: linear-gradient(180deg, rgba(255,92,122,.22), rgba(255,92,122,.08));
      border-color: rgba(255,92,122,.35);
    }
    main{
      height: calc(100% - 64px);
      display:grid;
      grid-template-columns: 1fr 360px;
      gap: 14px;
      padding: 14px;
    }
    .stage{
      min-width: 0;
      border-radius: var(--radius);
      background: rgba(17,26,54,.55);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .stageInner{
      position:absolute;
      inset:0;
      display:grid;
      place-items:center;
      padding: 18px;
    }
    .imgWrap{
      position:relative;
      max-width:100%;
      max-height:100%;
      border-radius: 14px;
      overflow:hidden;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(0,0,0,.15);
    }
    #img{
      display:block;
      max-width: 100%;
      max-height: calc(100vh - 160px);
      width:auto;
      height:auto;
      user-select:none;
      -webkit-user-drag:none;
    }
    #overlay{
      position:absolute;
      inset:0;
      width:100%;
      height:100%;
      touch-action:none;
      cursor: crosshair;
    }
    .sidebar{
      border-radius: var(--radius);
      background: rgba(17,26,54,.55);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      overflow:hidden;
      display:flex;
      flex-direction:column;
      min-width: 0;
    }
    .sideSection{
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .sideSection:last-child{border-bottom:none}
    .label{
      font-size:12px;
      color:var(--muted);
      margin-bottom:8px;
      letter-spacing:.15px;
    }
    .toolbar{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
    }
    .tool{
      padding: 7px 10px;
      border-radius: 12px;
      border:1px solid var(--line);
      background: rgba(255,255,255,.05);
      cursor:pointer;
      user-select:none;
      font-size:12px;
      color: var(--muted);
    }
    .tool.active{
      color: var(--text);
      border-color: rgba(89,214,255,.35);
      background: rgba(89,214,255,.10);
    }
    .row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    input[type="color"]{
      width: 38px;
      height: 28px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: transparent;
      padding:0;
      cursor:pointer;
    }
    input[type="range"]{width: 150px}
    textarea{
      width:100%;
      min-height: 92px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: rgba(0,0,0,.18);
      color: var(--text);
      padding: 10px;
      font-family: var(--sans);
      line-height: 1.35;
      outline:none;
    }
    textarea:focus{border-color: rgba(89,214,255,.35); box-shadow: 0 0 0 3px rgba(89,214,255,.08)}
    .mono{
      font-family: var(--mono);
      font-size: 12px;
      color: #cdd4ff;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: rgba(0,0,0,.16);
      max-height: 220px;
      overflow:auto;
    }
    .list{
      display:flex;
      flex-direction:column;
      gap:8px;
      max-height: 220px;
      overflow:auto;
      padding-right: 2px;
    }
    .item{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 8px 10px;
      background: rgba(0,0,0,.12);
      cursor:pointer;
    }
    .item .meta{
      min-width:0;
      display:flex;
      flex-direction:column;
      gap:2px;
    }
    .item .meta .k{font-size:12px; color: var(--text); font-weight:600}
    .item .meta .v{font-size:12px; color: var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .pill{
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: rgba(255,255,255,.04);
      flex: 0 0 auto;
    }
    .toast{
      position: absolute;
      left: 16px;
      bottom: 16px;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(0,0,0,.35);
      box-shadow: var(--shadow);
      color: var(--text);
      font-size: 12px;
      display:none;
      max-width: 520px;
    }
    .toast.show{display:block}
    .hint{
      position:absolute;
      right: 16px;
      bottom: 16px;
      font-size: 12px;
      color: var(--muted);
      background: rgba(0,0,0,.25);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
    }
    @media (max-width: 980px){
      main{grid-template-columns: 1fr}
      .sidebar{display:none}
    }
  </style>
</head>
<body>
  <script id="bootstrap" type="application/json">${bootstrapJson}</script>
  <header>
    <div class="title">
      <h1 id="title">Visual Annotator</h1>
      <div class="sub" id="subtitle">Draw on the image, add notes, and send feedback back to the agent.</div>
    </div>
    <div class="actions">
      <button id="btnSend" class="primary" title="Send feedback to the task (no regeneration)">Send Feedback</button>
      <button id="btnRegen" class="good" title="Send feedback and ask the agent to regenerate">Regenerate</button>
      <button id="btnApprove" title="Approve this iteration">Approve</button>
      <button id="btnClear" class="danger" title="Clear all annotations">Clear</button>
    </div>
  </header>

  <main>
    <section class="stage">
      <div class="stageInner">
        <div class="imgWrap" id="imgWrap">
          <img id="img" alt="Annotation target" />
          <canvas id="overlay"></canvas>
        </div>
      </div>
      <div class="toast" id="toast"></div>
      <div class="hint">Tools: Rect (R), Pen (P), Undo (Cmd/Ctrl+Z)</div>
    </section>

    <aside class="sidebar">
      <div class="sideSection">
        <div class="label">Tools</div>
        <div class="toolbar">
          <div class="tool active" data-tool="rect">Rect (R)</div>
          <div class="tool" data-tool="pen">Pen (P)</div>
          <button id="btnUndo" title="Undo last annotation">Undo</button>
        </div>
      </div>

      <div class="sideSection">
        <div class="label">Style</div>
        <div class="row">
          <div class="pill">Color</div>
          <input id="color" type="color" value="#59d6ff" />
          <div class="pill">Width</div>
          <input id="width" type="range" min="1" max="14" step="1" value="4" />
        </div>
      </div>

      <div class="sideSection">
        <div class="label">Global Notes</div>
        <textarea id="globalNotes" placeholder="Example: Make bubbles light green. Clean up the icons. Use complementary colors. Increase contrast."></textarea>
      </div>

      <div class="sideSection">
        <div class="label">Annotations</div>
        <div class="list" id="annList"></div>
      </div>

      <div class="sideSection">
        <div class="label">Compiled Feedback</div>
        <div class="mono" id="compiled"></div>
      </div>
    </aside>
  </main>

  <script>
    const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent || '{}');
    const $ = (id) => document.getElementById(id);

    const img = $('img');
    const overlay = $('overlay');
    const imgWrap = $('imgWrap');
    const titleEl = $('title');
    const subtitleEl = $('subtitle');
    const toastEl = $('toast');
    const annListEl = $('annList');
    const compiledEl = $('compiled');
    const globalNotesEl = $('globalNotes');
    const colorEl = $('color');
    const widthEl = $('width');

    const toolsEls = Array.from(document.querySelectorAll('.tool'));

    let tool = 'rect'; // 'rect' | 'pen'
    let drawing = false;
    let natural = { w: 0, h: 0 };

    /** @type {Array<any>} */
    let annotations = [];
    /** @type {any|null} */
    let live = null;

    function uid() {
      return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
    }

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    function setTool(next) {
      tool = next;
      for (const el of toolsEls) el.classList.toggle('active', el.dataset.tool === tool);
      overlay.style.cursor = tool === 'pen' ? 'crosshair' : 'crosshair';
      toast('Tool: ' + tool.toUpperCase());
    }

    function getDisplayRect() {
      const r = img.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function toNorm(p) {
      const r = getDisplayRect();
      const x = (p.x - r.left) / r.width;
      const y = (p.y - r.top) / r.height;
      return { x: clamp01(x), y: clamp01(y) };
    }

    function clamp01(n) {
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(1, n));
    }

    function resizeOverlay() {
      // Match overlay backing store to displayed size for crisp rendering
      const r = img.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      overlay.width = Math.max(1, Math.floor(r.width * dpr));
      overlay.height = Math.max(1, Math.floor(r.height * dpr));
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      redraw();
    }

    function redraw() {
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      const drawOne = (a, alpha=1) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = a.color;
        ctx.shadowBlur = 10;
        if (a.type === 'rect') {
          const x = a.data.x * overlay.clientWidth;
          const y = a.data.y * overlay.clientHeight;
          const w = a.data.w * overlay.clientWidth;
          const h = a.data.h * overlay.clientHeight;
          ctx.strokeRect(x, y, w, h);
        } else if (a.type === 'pen') {
          const pts = a.data.points || [];
          if (pts.length > 1) {
            ctx.beginPath();
            for (let i=0;i<pts.length;i++){
              const px = pts[i].x * overlay.clientWidth;
              const py = pts[i].y * overlay.clientHeight;
              if (i===0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      };

      for (const a of annotations) drawOne(a, 0.95);
      if (live) drawOne(live, 0.75);
    }

    function compileMarkdown() {
      const t = bootstrap.target || {};
      const lines = [];
      lines.push('# Visual feedback');
      if (t.kind || t.size || t.usage || t.style) {
        lines.push('');
        lines.push('Target:');
        if (t.kind) lines.push('- kind: ' + t.kind);
        if (t.size) lines.push('- size: ' + t.size);
        if (t.usage) lines.push('- usage: ' + t.usage);
        if (t.style) lines.push('- style: ' + t.style);
      }
      const global = (globalNotesEl.value || '').trim();
      if (global) {
        lines.push('');
        lines.push('Global notes:');
        lines.push('- ' + global.replace(/\\n/g, '\\n- '));
      }
      if (annotations.length) {
        lines.push('');
        lines.push('Changes (regions are normalized x/y/w/h in [0..1] relative to the image):');
	        for (let i=0;i<annotations.length;i++){
	          const a = annotations[i];
	          if (a.type === 'rect') {
	            const d = a.data;
	            const region =
	              'rect x=' + d.x.toFixed(3) +
	              ' y=' + d.y.toFixed(3) +
	              ' w=' + d.w.toFixed(3) +
	              ' h=' + d.h.toFixed(3);
	            const note = (a.note || '').trim() || '(no note)';
	            lines.push((i + 1) + '. ' + region + ': ' + note);
	          } else {
	            const note = (a.note || '').trim() || '(no note)';
	            lines.push((i + 1) + '. pen stroke: ' + note);
	          }
	        }
	      }
      return lines.join('\\n');
    }

    function refreshSidebar() {
      // list
      annListEl.innerHTML = '';
      for (let i=0;i<annotations.length;i++){
        const a = annotations[i];
        const div = document.createElement('div');
        div.className = 'item';
        const meta = document.createElement('div');
        meta.className = 'meta';
        const k = document.createElement('div');
        k.className = 'k';
        k.textContent = (a.type === 'rect' ? 'Rect' : 'Pen') + ' #' + (i+1);
        const v = document.createElement('div');
        v.className = 'v';
        v.textContent = a.note ? a.note : '(click to add note)';
        meta.appendChild(k);
        meta.appendChild(v);
        const pill = document.createElement('div');
        pill.className = 'pill';
        pill.textContent = a.type;
        div.appendChild(meta);
        div.appendChild(pill);
        div.addEventListener('click', () => {
          const next = prompt('Annotation note (what should change in this region?)', a.note || '');
          if (next !== null) {
            a.note = next.trim();
            refreshSidebar();
          }
        });
        annListEl.appendChild(div);
      }

      // compiled
      const md = compileMarkdown();
      compiledEl.textContent = md;
      return md;
    }

    function payloadV1() {
      const md = refreshSidebar();
      /** @type {any} */
      const payload = {
        version: 1,
        kind: 'visual_annotation',
        image: {
          filename: bootstrap.imageFilename,
          originalPath: bootstrap.originalImagePath,
          iteration: bootstrap.iteration,
          naturalWidth: natural.w || undefined,
          naturalHeight: natural.h || undefined
        },
        target: bootstrap.target,
        notes: {
          global: (globalNotesEl.value || '').trim()
        },
        annotations,
        export: { markdown: md }
      };
      return payload;
    }

    async function send(actionName) {
      const api = window.coworkCanvas;
      if (!api || typeof api.sendA2UIAction !== 'function') {
        toast('coworkCanvas API not available (this must run in canvas://)');
        return;
      }
      const ctx = payloadV1();
      await api.sendA2UIAction(actionName, 'visual-annotator', ctx);
      toast('Sent to agent: ' + actionName);
    }

    function undo() {
      if (!annotations.length) return;
      annotations.pop();
      live = null;
      redraw();
      refreshSidebar();
    }

    // Hook UI buttons
    $('btnSend').addEventListener('click', () => send('visual_feedback'));
    $('btnRegen').addEventListener('click', () => send('visual_regenerate'));
    $('btnApprove').addEventListener('click', () => send('visual_approve'));
    $('btnClear').addEventListener('click', () => {
      annotations = [];
      live = null;
      redraw();
      refreshSidebar();
      toast('Cleared');
    });
    $('btnUndo').addEventListener('click', undo);

    // Tool selection
    for (const el of toolsEls) {
      el.addEventListener('click', () => setTool(el.dataset.tool));
    }

    // Notes changes
    globalNotesEl.addEventListener('input', () => refreshSidebar());

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'r') setTool('rect');
      if (k === 'p') setTool('pen');
    });

    // Pointer handling
    overlay.addEventListener('pointerdown', (e) => {
      if (!natural.w || !natural.h) return;
      const p = { x: e.clientX, y: e.clientY };
      const n = toNorm(p);
      drawing = true;
      overlay.setPointerCapture(e.pointerId);

      const color = colorEl.value || '#59d6ff';
      const strokeWidth = Number(widthEl.value || '4');

      if (tool === 'rect') {
        live = {
          id: uid(),
          type: 'rect',
          color,
          strokeWidth,
          data: { x: n.x, y: n.y, w: 0, h: 0 },
          createdAt: Date.now()
        };
      } else {
        live = {
          id: uid(),
          type: 'pen',
          color,
          strokeWidth,
          data: { points: [n] },
          createdAt: Date.now()
        };
      }
      redraw();
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!drawing || !live) return;
      const n = toNorm({ x: e.clientX, y: e.clientY });
      if (live.type === 'rect') {
        const d = live.data;
        // Ensure rect expands from initial anchor
        d.w = clamp01(n.x - d.x);
        d.h = clamp01(n.y - d.y);
      } else {
        live.data.points.push(n);
      }
      redraw();
    });

    overlay.addEventListener('pointerup', (e) => {
      if (!drawing) return;
      drawing = false;
      overlay.releasePointerCapture(e.pointerId);
      if (!live) return;

      // Normalize rect to positive w/h
      if (live.type === 'rect') {
        const d = live.data;
        let x = d.x, y = d.y, w = d.w, h = d.h;
        if (w < 0) { x = x + w; w = Math.abs(w); }
        if (h < 0) { y = y + h; h = Math.abs(h); }
        live.data = { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };

        // Tiny rectangles are usually accidental
        if (live.data.w < 0.01 && live.data.h < 0.01) {
          live = null;
          redraw();
          return;
        }
      } else {
        const pts = live.data.points || [];
        if (pts.length < 2) {
          live = null;
          redraw();
          return;
        }
      }

      const note = prompt('What should change here? (optional)', '');
      if (note !== null && note.trim()) live.note = note.trim();
      annotations.push(live);
      live = null;
      redraw();
      refreshSidebar();
    });

    // Image load wiring
    function init() {
      const t = bootstrap.target || {};
      titleEl.textContent = bootstrap.title || 'Visual Annotator';
      const bits = [];
      if (t.kind) bits.push(t.kind);
      if (t.size) bits.push(t.size);
      if (bootstrap.iteration !== undefined) bits.push('iteration ' + bootstrap.iteration);
      subtitleEl.textContent = bits.length ? bits.join(' · ') : 'Draw on the image, add notes, and send feedback back to the agent.';

      if (bootstrap.instructions) {
        globalNotesEl.placeholder = bootstrap.instructions;
      }

      // Bust caching per open/update by using a query string
      img.src = bootstrap.imageFilename + '?v=' + Date.now();
      img.addEventListener('load', () => {
        natural.w = img.naturalWidth || 0;
        natural.h = img.naturalHeight || 0;
        resizeOverlay();
        refreshSidebar();
        toast('Image loaded: ' + natural.w + 'x' + natural.h);
      });
      window.addEventListener('resize', () => resizeOverlay());
    }

    init();
  </script>
</body>
</html>`;
}

export class VisualTools {
  private canvasManager: CanvasManager;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.canvasManager = CanvasManager.getInstance();
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private async getOrCreateSession(input: {
    sessionId?: string;
    title?: string;
  }): Promise<{ sessionId: string; sessionDir: string }> {
    if (input.sessionId) {
      const session = this.canvasManager.getSession(input.sessionId);
      if (!session) throw new Error(`Canvas session not found: ${input.sessionId}`);
      return { sessionId: session.id, sessionDir: session.sessionDir };
    }

    const session = await this.canvasManager.createSession(
      this.taskId,
      this.workspace.id,
      input.title || "Visual Annotator",
    );
    return { sessionId: session.id, sessionDir: session.sessionDir };
  }

  private async stageImage(sessionDir: string, sourceAbsPath: string): Promise<string> {
    const extRaw = path.extname(sourceAbsPath).toLowerCase();
    const ext = extRaw && extRaw.length <= 8 ? extRaw : ".png";
    const imageFilename = `image${ext}`;

    // Clear previous staged image files
    try {
      const files = await fs.readdir(sessionDir);
      await Promise.all(
        files
          .filter((f) => f.startsWith("image."))
          .map((f) => fs.rm(path.join(sessionDir, f), { force: true })),
      );
    } catch {
      // best effort
    }

    await fs.copyFile(sourceAbsPath, path.join(sessionDir, imageFilename));
    return imageFilename;
  }

  async openImageAnnotator(input: {
    imagePath: string;
    sessionId?: string;
    title?: string;
    iteration?: number;
    target?: VisualAnnotatorTarget;
    instructions?: string;
  }): Promise<{ sessionId: string; sessionDir: string; imageFilename: string }> {
    if (!this.workspace.permissions.read) {
      throw new Error("Read permission not granted for visual annotation");
    }
    if (!input?.imagePath || typeof input.imagePath !== "string" || !input.imagePath.trim()) {
      throw new Error("Missing required parameter: imagePath");
    }

    const absImagePath = resolveWorkspacePath(this.workspace.path, input.imagePath.trim());
    if (!existsSync(absImagePath)) {
      throw new Error(`Image not found: ${input.imagePath}`);
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "visual_open_annotator",
      imagePath: input.imagePath,
      sessionId: input.sessionId,
      title: input.title,
      iteration: input.iteration,
    });

    const { sessionId, sessionDir } = await this.getOrCreateSession({
      sessionId: input.sessionId,
      title: input.title,
    });
    const imageFilename = await this.stageImage(sessionDir, absImagePath);

    const html = renderVisualAnnotatorHtml({
      version: 1,
      sessionId,
      title: input.title || "Visual Annotator",
      imageFilename,
      originalImagePath: input.imagePath,
      iteration: input.iteration,
      target: input.target,
      instructions: input.instructions,
    });

    await this.canvasManager.pushContent(sessionId, html, "index.html");
    await this.canvasManager.showCanvas(sessionId);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "visual_open_annotator",
      success: true,
      sessionId,
      imageFilename,
    });

    return { sessionId, sessionDir, imageFilename };
  }

  async updateImageAnnotator(input: {
    sessionId: string;
    imagePath: string;
    title?: string;
    iteration?: number;
    target?: VisualAnnotatorTarget;
    instructions?: string;
  }): Promise<{ success: boolean; sessionId: string; imageFilename: string }> {
    if (!this.workspace.permissions.read) {
      throw new Error("Read permission not granted for visual annotation");
    }
    if (!input?.sessionId || typeof input.sessionId !== "string") {
      throw new Error("Missing required parameter: sessionId");
    }
    if (!input?.imagePath || typeof input.imagePath !== "string" || !input.imagePath.trim()) {
      throw new Error("Missing required parameter: imagePath");
    }

    const session = this.canvasManager.getSession(input.sessionId);
    if (!session) throw new Error(`Canvas session not found: ${input.sessionId}`);

    const absImagePath = resolveWorkspacePath(this.workspace.path, input.imagePath.trim());
    if (!existsSync(absImagePath)) {
      throw new Error(`Image not found: ${input.imagePath}`);
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "visual_update_annotator",
      imagePath: input.imagePath,
      sessionId: input.sessionId,
      iteration: input.iteration,
    });

    const imageFilename = await this.stageImage(session.sessionDir, absImagePath);
    const html = renderVisualAnnotatorHtml({
      version: 1,
      sessionId: session.id,
      title: input.title || session.title || "Visual Annotator",
      imageFilename,
      originalImagePath: input.imagePath,
      iteration: input.iteration,
      target: input.target,
      instructions: input.instructions,
    });

    await this.canvasManager.pushContent(session.id, html, "index.html");

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "visual_update_annotator",
      success: true,
      sessionId: session.id,
      imageFilename,
    });

    return { success: true, sessionId: session.id, imageFilename };
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "visual_open_annotator",
        description:
          "Open an interactive visual annotation UI in Live Canvas for a workspace image. " +
          "The user can draw rectangles/pen strokes and add notes, then click Send Feedback / Regenerate / Approve. " +
          "Those actions are sent back to the running task as a [Canvas Interaction] message with structured JSON context.",
        input_schema: {
          type: "object",
          properties: {
            imagePath: {
              type: "string",
              description:
                "Workspace-relative path to the image to annotate (must be inside the workspace).",
            },
            sessionId: {
              type: "string",
              description:
                "Optional existing canvas session ID to reuse. If omitted, a new session is created.",
            },
            title: {
              type: "string",
              description: "Optional title to show in the annotator header.",
            },
            iteration: {
              type: "number",
              description: "Optional iteration number to show in the UI (e.g., 1, 2, 3...).",
            },
            target: {
              type: "object",
              description: "Optional target context for the visual (usage, size, style).",
              properties: {
                kind: { type: "string" },
                usage: { type: "string" },
                size: { type: "string" },
                style: { type: "string" },
              },
            },
            instructions: {
              type: "string",
              description: "Optional placeholder guidance for what feedback to leave.",
            },
          },
          required: ["imagePath"],
        },
      },
      {
        name: "visual_update_annotator",
        description:
          "Update an existing visual annotation canvas session with a new image iteration (e.g., after regenerating). " +
          "This keeps the same canvas window but replaces the image and updates header metadata.",
        input_schema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The canvas session ID returned by visual_open_annotator.",
            },
            imagePath: {
              type: "string",
              description: "Workspace-relative path to the new image iteration to display.",
            },
            title: { type: "string" },
            iteration: { type: "number" },
            target: {
              type: "object",
              properties: {
                kind: { type: "string" },
                usage: { type: "string" },
                size: { type: "string" },
                style: { type: "string" },
              },
            },
            instructions: { type: "string" },
          },
          required: ["sessionId", "imagePath"],
        },
      },
    ];
  }
}
