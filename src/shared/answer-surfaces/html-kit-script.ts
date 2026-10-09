import { HTML_KIT_ICONS } from "./html-kit-icons";

/**
 * Helpers the design kit adds to `window.cowork` inside an inline HTML surface: named
 * icons, number formatting, count-up numbers, slider fills and themed SVG charts. It runs
 * before the bridge bootstrap, which picks the helpers up from `__coworkKit`. Everything
 * here runs inside the sandbox; nothing reaches the app.
 */
const KIT_BODY = String.raw`
var NS = "http://www.w3.org/2000/svg";
function el(tag, attrs, parent) {
  var node = document.createElementNS(NS, tag);
  Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
  if (parent) parent.appendChild(node);
  return node;
}
function html(tag, className, parent, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function icon(name, options) {
  var nodes = ICONS[String(name || "").toLowerCase()];
  if (!nodes) return null;
  var size = (options && options.size) || 24;
  var svg = el("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": (options && options.strokeWidth) || 2, "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", "class": "cw-icon" });
  nodes.forEach(function (entry) { el(entry[0], entry[1], svg); });
  return svg;
}
function renderIcons(root) {
  (root || document).querySelectorAll("[data-icon]").forEach(function (node) {
    if (node.querySelector(":scope > svg")) return;
    var svg = icon(node.getAttribute("data-icon"));
    if (svg) node.insertBefore(svg, node.firstChild);
  });
}

var compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
function format(value, options) {
  options = options || {};
  if (typeof value !== "number" || !isFinite(value)) return "—";
  var text;
  if (options.compact === true || (options.compact !== false && options.axis && Math.abs(value) >= 10000)) {
    text = compact.format(value);
  } else {
    var decimals = options.decimals;
    // Large amounts read as whole numbers ($754, not $754.2); small ones keep detail.
    if (decimals === undefined) decimals = Number.isInteger(value) || Math.abs(value) >= 100 ? 0 : Math.abs(value) < 10 ? 2 : 1;
    text = new Intl.NumberFormat("en-US", { minimumFractionDigits: options.decimals === undefined ? 0 : decimals, maximumFractionDigits: decimals }).format(value);
  }
  var unit = options.unit ? (/^[%°]/.test(options.unit) ? options.unit : " " + options.unit) : "";
  return (options.prefix || "") + text + unit;
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
/** Eases an element's number to a new value (keeps the last value per element). */
function tween(node, to, options) {
  if (typeof node === "string") node = document.querySelector(node);
  if (!node) return;
  var from = typeof node.__cwValue === "number" ? node.__cwValue : to;
  node.__cwValue = to;
  if (node.__cwFrame) cancelAnimationFrame(node.__cwFrame);
  if (from === to || reducedMotion()) { node.textContent = format(to, options); return; }
  var start = performance.now();
  function step(now) {
    var p = Math.min(1, (now - start) / 420);
    var eased = 1 - Math.pow(1 - p, 3);
    node.textContent = format(p >= 1 ? to : from + (to - from) * eased, options);
    if (p < 1) node.__cwFrame = requestAnimationFrame(step);
  }
  node.__cwFrame = requestAnimationFrame(step);
}

function syncRange(input) {
  var min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  var fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", fill + "%");
}
document.addEventListener("input", function (event) {
  if (event.target && event.target.type === "range") syncRange(event.target);
}, true);

function seriesColor(series, index, colored) {
  if (series.muted) return "var(--rf-muted)";
  if (series.tone) return "var(--cw-tone-" + String(series.tone).replace(/[^a-z]/g, "") + ")";
  return "var(--cw-c" + ((colored % 5) + 1) + ")";
}
function niceStep(range, count) {
  var raw = range / Math.max(1, count);
  var power = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  var steps = [1, 2, 2.5, 5, 10];
  for (var i = 0; i < steps.length; i++) if (steps[i] * power >= raw) return steps[i] * power;
  return 10 * power;
}
function smoothPath(points) {
  if (points.length < 2) return "";
  var d = "M" + points[0][0] + "," + points[0][1];
  for (var i = 0; i < points.length - 1; i++) {
    var p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += " C" + c1x + "," + c1y + " " + c2x + "," + c2y + " " + p2[0] + "," + p2[1];
  }
  return d;
}
var chartCount = 0;

function drawDonut(root, spec) {
  var series = (spec.series && spec.series[0]) || { values: [] };
  var values = series.values.map(function (v) { return Math.max(0, Number(v) || 0); });
  var total = values.reduce(function (a, b) { return a + b; }, 0);
  var wrap = html("div", "cw-chart-donut", root);
  var svg = el("svg", { viewBox: "0 0 200 200" }, wrap);
  var r = 80, width = 26, angle = -Math.PI / 2, gap = values.length > 1 ? 0.025 : 0;
  values.forEach(function (value, index) {
    if (!total || !value) return;
    var sweep = (value / total) * Math.PI * 2;
    var a0 = angle + gap, a1 = angle + sweep - gap;
    angle += sweep;
    if (a1 <= a0) return;
    var large = a1 - a0 > Math.PI ? 1 : 0;
    var path = el("path", { d: "M" + (100 + r * Math.cos(a0)) + "," + (100 + r * Math.sin(a0)) +
      " A" + r + "," + r + " 0 " + large + " 1 " + (100 + r * Math.cos(a1)) + "," + (100 + r * Math.sin(a1)),
      fill: "none", "stroke-width": width, "stroke-linecap": "round" }, svg);
    path.style.stroke = "var(--cw-c" + ((index % 5) + 1) + ")";
  });
  var center = el("text", { x: 100, y: 102, "text-anchor": "middle", "class": "cw-chart-center" }, svg);
  center.textContent = format(total, { prefix: spec.prefix, unit: spec.unit, compact: total >= 100000 });
  var label = el("text", { x: 100, y: 122, "text-anchor": "middle", "class": "cw-chart-center-label" }, svg);
  label.textContent = spec.centerLabel || "Total";
  var list = html("ul", "", wrap);
  (spec.labels || []).forEach(function (name, index) {
    var item = html("li", "", list);
    var swatch = html("span", "cw-chart-swatch", item);
    swatch.style.background = "var(--cw-c" + ((index % 5) + 1) + ")";
    html("span", "", item, String(name));
    html("b", "", item, format(values[index] || 0, { prefix: spec.prefix, unit: spec.unit }));
    html("span", "cw-muted", item, total ? Math.round(((values[index] || 0) / total) * 100) + "%" : "");
  });
}

function drawCartesian(root, spec, width) {
  var kind = spec.type || spec.kind || "line";
  var labels = spec.labels || [];
  var series = (spec.series || []).map(function (s) {
    return { name: s.name || "", muted: !!s.muted, tone: s.tone, values: (s.values || []).map(function (v) { var n = Number(v); return isFinite(n) ? n : null; }) };
  });
  var colored = 0;
  series.forEach(function (s, i) { s.color = seriesColor(s, i, colored); if (!s.muted && !s.tone) colored += 1; });
  var height = Math.max(120, Math.min(480, Number(spec.height) || 220));
  if (series.length > 1) {
    var legend = html("div", "cw-chart-legend", root);
    series.forEach(function (s) {
      var item = html("span", "", legend);
      var key = html("i", "cw-chart-key" + (s.muted ? " dashed" : ""), item);
      key.style.color = s.color;
      item.appendChild(document.createTextNode(s.name));
    });
  }
  var stacked = !!spec.stacked && kind !== "line";
  var all = [];
  labels.forEach(function (_, i) {
    var sum = 0;
    series.forEach(function (s) { var v = s.values[i]; if (v !== null && v !== undefined) { all.push(v); sum += v; } });
    if (stacked) all.push(sum);
  });
  var min = Math.min(0, Math.min.apply(null, all.length ? all : [0]));
  var max = Math.max.apply(null, all.length ? all : [1]);
  if (max === min) max = min + 1;
  var step = niceStep(max - min, 4);
  var top = Math.ceil(max / step) * step, bottom = Math.floor(min / step) * step;
  var axisOptions = { prefix: spec.prefix, unit: spec.unit && spec.unit.length <= 2 ? spec.unit : "", axis: true };
  var ticks = [];
  for (var t = bottom; t <= top + step / 2; t += step) ticks.push(t);
  var left = Math.max.apply(null, ticks.map(function (v) { return format(v, axisOptions).length; })) * 7 + 10;
  var endLabels = (kind === "line" || kind === "area") && !stacked && series.length <= 3 && labels.length > 1;
  var right = 12;
  if (endLabels) {
    right = 14 + Math.max.apply(null, series.map(function (s) {
      var last = s.values[s.values.length - 1];
      return last === null || last === undefined ? 0 : format(last, { prefix: spec.prefix, unit: spec.unit, axis: true }).length * 7.2;
    }));
  }
  var plotTop = 10, plotBottom = height - 24, plotW = Math.max(40, width - left - right);
  var y = function (v) { return plotTop + (1 - (v - bottom) / (top - bottom)) * (plotBottom - plotTop); };
  var band = plotW / Math.max(1, labels.length);
  var x = kind === "bar"
    ? function (i) { return left + band * i + band / 2; }
    : function (i) { return left + (labels.length <= 1 ? plotW / 2 : (plotW * i) / (labels.length - 1)); };

  var svg = el("svg", { viewBox: "0 0 " + width + " " + height, height: height, role: "img" }, root);
  if (spec.title) svg.setAttribute("aria-label", String(spec.title));
  var defs = el("defs", {}, svg);
  var id = "cwc" + (++chartCount);
  ticks.forEach(function (v) {
    el("line", { x1: left, x2: left + plotW, y1: y(v), y2: y(v), "class": "cw-chart-grid" }, svg);
    var text = el("text", { x: left - 8, y: y(v) + 4, "text-anchor": "end", "class": "cw-chart-axis" }, svg);
    text.textContent = format(v, axisOptions);
  });
  var every = Math.max(1, Math.ceil((labels.reduce(function (m, l) { return Math.max(m, String(l).length); }, 1) * 7 + 12) / (kind === "bar" ? band : plotW / Math.max(1, labels.length - 1))));
  labels.forEach(function (label, i) {
    if (i % every !== 0 && i !== labels.length - 1) return;
    var text = el("text", { x: x(i), y: height - 6, "text-anchor": "middle", "class": "cw-chart-axis" }, svg);
    text.textContent = String(label);
  });

  if (kind === "bar") {
    var groupW = Math.min(band * 0.7, 56 * (stacked ? 1 : series.length));
    var barW = stacked ? groupW : groupW / Math.max(1, series.length);
    var base = labels.map(function () { return 0; });
    series.forEach(function (s, si) {
      var grad = el("linearGradient", { id: id + "b" + si, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      var s0 = el("stop", { offset: "0%" }, grad); s0.style.stopColor = s.color;
      var s1 = el("stop", { offset: "100%" }, grad); s1.style.stopColor = s.color; s1.style.stopOpacity = "0.72";
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined) return;
        var x0 = stacked ? x(i) - groupW / 2 : x(i) - groupW / 2 + barW * si + 1;
        var y0 = y(base[i] + v), y1 = y(base[i]);
        var h = Math.abs(y1 - y0), w = Math.max(2, barW - 2), rad = Math.min(6, w / 2, h);
        var yt = Math.min(y0, y1);
        el("path", { d: "M" + x0 + "," + (yt + h) + " V" + (yt + rad) + " Q" + x0 + "," + yt + " " + (x0 + rad) + "," + yt +
          " H" + (x0 + w - rad) + " Q" + (x0 + w) + "," + yt + " " + (x0 + w) + "," + (yt + rad) + " V" + (yt + h) + " Z",
          fill: "url(#" + id + "b" + si + ")" }, svg);
        if (stacked) base[i] += v;
      });
    });
  } else {
    var running = labels.map(function () { return 0; });
    series.forEach(function (s, si) {
      var points = [];
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined) return;
        var value = stacked ? running[i] + v : v;
        if (stacked) running[i] = value;
        points.push([x(i), y(value), v]);
      });
      if (points.length === 0) return;
      var line = smoothPath(points) || "M" + points[0][0] + "," + points[0][1];
      if (kind === "area") {
        var grad = el("linearGradient", { id: id + "a" + si, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        var a0 = el("stop", { offset: "0%" }, grad); a0.style.stopColor = s.color; a0.style.stopOpacity = s.muted ? "0.1" : "0.34";
        var a1 = el("stop", { offset: "100%" }, grad); a1.style.stopColor = s.color; a1.style.stopOpacity = "0.02";
        el("path", { d: line + " L" + points[points.length - 1][0] + "," + y(Math.max(bottom, 0)) + " L" + points[0][0] + "," + y(Math.max(bottom, 0)) + " Z", fill: "url(#" + id + "a" + si + ")" }, svg);
      }
      var path = el("path", { d: line, fill: "none", "stroke-width": s.muted ? 2 : 3, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
      path.style.stroke = s.color;
      if (s.muted) path.setAttribute("stroke-dasharray", "6 5");
      if (endLabels) {
        var last = points[points.length - 1];
        var text = el("text", { x: last[0] + 8, y: last[1] + 4, "class": "cw-chart-end" }, svg);
        text.style.fill = s.color;
        text.textContent = format(last[2], { prefix: spec.prefix, unit: spec.unit, axis: true });
      }
    });
  }

  // Hover: a guide line and the values at the nearest label.
  var guide = el("line", { y1: plotTop, y2: plotBottom, "class": "cw-chart-guide", visibility: "hidden" }, svg);
  var tip = html("div", "cw-chart-tip", root);
  tip.style.display = "none";
  svg.addEventListener("mousemove", function (event) {
    var box = svg.getBoundingClientRect();
    var px = ((event.clientX - box.left) / box.width) * width;
    var index = 0, best = Infinity;
    labels.forEach(function (_, i) { var d = Math.abs(x(i) - px); if (d < best) { best = d; index = i; } });
    guide.setAttribute("x1", x(index)); guide.setAttribute("x2", x(index)); guide.setAttribute("visibility", "visible");
    tip.textContent = "";
    html("b", "", tip, String(labels[index]));
    series.forEach(function (s) {
      var row = html("div", "", tip);
      var name = html("span", "", row, s.name || "Value");
      name.style.color = s.color;
      html("span", "", row, format(s.values[index], { prefix: spec.prefix, unit: spec.unit }));
    });
    tip.style.display = "block";
    var left = (x(index) / width) * box.width + 12;
    if (left + tip.offsetWidth > box.width) left -= tip.offsetWidth + 24;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = (svg.offsetTop + 8) + "px";
  });
  svg.addEventListener("mouseleave", function () { tip.style.display = "none"; guide.setAttribute("visibility", "hidden"); });
}

/** Draws a themed chart into an element and redraws it on resize or update(spec). */
function chart(target, spec) {
  var root = typeof target === "string" ? document.querySelector(target) : target;
  if (!root) return null;
  var current = spec || {};
  root.classList.add("cw-chart");
  function draw() {
    root.textContent = "";
    var kind = current.type || current.kind;
    if (kind === "donut" || kind === "pie") drawDonut(root, current);
    else drawCartesian(root, current, Math.max(160, root.clientWidth || 600));
  }
  draw();
  var lastWidth = root.clientWidth;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () {
      if (Math.abs(root.clientWidth - lastWidth) < 4) return;
      lastWidth = root.clientWidth;
      draw();
    }).observe(root);
  }
  return { update: function (next) { current = next || current; draw(); } };
}

window.__coworkKit = { icon: icon, renderIcons: renderIcons, format: format, tween: tween, chart: chart };
function ready() {
  renderIcons(document);
  document.querySelectorAll('input[type="range"]').forEach(syncRange);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
else ready();
`;

export const HTML_KIT_SCRIPT = `(function () {\n"use strict";\nvar ICONS = ${JSON.stringify(HTML_KIT_ICONS)};\n${KIT_BODY}\n})();`;
