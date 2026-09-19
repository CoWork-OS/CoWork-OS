#!/usr/bin/env node

import path from "node:path";
import {
  buildOutputTargetPath,
  ensureDir,
  getSafeFileStem,
  isoNow,
  readText,
  writeJson,
  writeText,
} from "./wiki-workbench-lib.mjs";

const CHART_PALETTE = ["#2f6fed", "#1ea672", "#d97706", "#c2410c", "#7c3aed", "#0f766e"];

function parseArgs(argv) {
  const args = {
    kind: "marp",
    theme: "default",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--vault") {
      args.vault = argv[++i];
      continue;
    }
    if (token === "--kind") {
      args.kind = argv[++i];
      continue;
    }
    if (token === "--title") {
      args.title = argv[++i];
      continue;
    }
    if (token === "--body-file") {
      args.bodyFile = argv[++i];
      continue;
    }
    if (token === "--spec-file") {
      args.specFile = argv[++i];
      continue;
    }
    if (token === "--slug") {
      args.slug = argv[++i];
      continue;
    }
    if (token === "--theme") {
      args.theme = argv[++i];
      continue;
    }
  }
  if (!args.vault) {
    throw new Error("Missing --vault <path>");
  }
  if (!args.title) {
    throw new Error("Missing --title <text>");
  }
  if (!["marp", "chart"].includes(String(args.kind))) {
    throw new Error("Invalid --kind. Use marp or chart.");
  }
  if (args.kind === "marp" && !args.bodyFile) {
    throw new Error("Missing --body-file <path> for Marp output.");
  }
  if (args.kind === "chart" && !args.specFile) {
    throw new Error("Missing --spec-file <path> for chart output.");
  }
  return args;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateLabel(value, max = 18) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function renderMarpMarkdown({ title, theme, bodyText }) {
  const trimmed = String(bodyText || "").trim();
  if (!trimmed) {
    throw new Error("Marp body file is empty.");
  }
  if (/^---\n[\s\S]*?\n---\n/i.test(trimmed) && /\nmarp:\s*true\b/i.test(trimmed)) {
    return `${trimmed}\n`;
  }

  return [
    "---",
    "marp: true",
    "paginate: true",
    `theme: ${theme || "default"}`,
    `title: ${title}`,
    "---",
    "",
    `# ${title}`,
    "",
    trimmed,
    "",
  ].join("\n");
}

function normalizeChartSpec(spec, title) {
  const input = spec && typeof spec === "object" ? spec : {};
  const rawSeries = Array.isArray(input.series)
    ? input.series
    : Array.isArray(input.data)
      ? input.data
      : [];
  const series = rawSeries
    .map((entry, index) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const label = String(entry.label ?? entry.name ?? `Item ${index + 1}`).trim();
        const value = Number(entry.value ?? entry.y ?? entry.count ?? entry.score);
        const color = typeof entry.color === "string" ? entry.color.trim() : "";
        return {
          label: label || `Item ${index + 1}`,
          value,
          color,
        };
      }
      if (Array.isArray(entry) && entry.length >= 2) {
        return {
          label: String(entry[0] ?? `Item ${index + 1}`).trim() || `Item ${index + 1}`,
          value: Number(entry[1]),
          color: "",
        };
      }
      return null;
    })
    .filter((entry) => entry && Number.isFinite(entry.value));

  if (series.length === 0) {
    throw new Error("Chart spec requires a non-empty numeric series array.");
  }

  return {
    title: String(input.title || title || "Chart").trim() || "Chart",
    subtitle: String(input.subtitle || "").trim(),
    yLabel: String(input.yLabel || input.unit || "").trim(),
    series: series.map((entry, index) => ({
      ...entry,
      color: entry.color || CHART_PALETTE[index % CHART_PALETTE.length],
    })),
  };
}

function renderBarChartSvg(spec) {
  const width = 1200;
  const height = 720;
  const margin = { top: 110, right: 64, bottom: 140, left: 96 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = spec.series.map((entry) => entry.value);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values, 1);
  const valueRange = Math.max(1, maxValue - minValue);
  const zeroY = margin.top + ((maxValue - 0) / valueRange) * plotHeight;
  const barGap = Math.max(16, Math.floor(plotWidth * 0.02));
  const barWidth = Math.max(
    24,
    Math.floor((plotWidth - barGap * Math.max(0, spec.series.length - 1)) / spec.series.length),
  );
  const totalBarsWidth =
    barWidth * spec.series.length + barGap * Math.max(0, spec.series.length - 1);
  const startX = margin.left + Math.max(0, Math.floor((plotWidth - totalBarsWidth) / 2));
  const gridTicks = 5;

  const gridLines = [];
  for (let index = 0; index <= gridTicks; index += 1) {
    const value = maxValue - (valueRange / gridTicks) * index;
    const y = margin.top + (index / gridTicks) * plotHeight;
    gridLines.push(`
      <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="rgba(148,163,184,0.24)" stroke-width="1" />
      <text x="${margin.left - 12}" y="${y + 5}" text-anchor="end" fill="#94a3b8" font-size="14">${escapeHtml(value.toFixed(Math.abs(value) >= 10 ? 0 : 1))}</text>
    `);
  }

  const bars = spec.series.map((entry, index) => {
    const x = startX + index * (barWidth + barGap);
    const scaledHeight = (Math.abs(entry.value) / valueRange) * plotHeight;
    const y = entry.value >= 0 ? zeroY - scaledHeight : zeroY;
    const label = truncateLabel(entry.label);
    const valueY = entry.value >= 0 ? y - 10 : y + scaledHeight + 24;
    return `
      <g>
        <title>${escapeHtml(`${entry.label}: ${entry.value}`)}</title>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(2, scaledHeight)}" rx="10" fill="${escapeHtml(entry.color)}" opacity="0.92" />
        <text x="${x + barWidth / 2}" y="${valueY}" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="600">${escapeHtml(String(entry.value))}</text>
        <text x="${x + barWidth / 2}" y="${height - margin.bottom + 28}" text-anchor="middle" fill="#cbd5e1" font-size="14">${escapeHtml(label)}</text>
      </g>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-subtitle">
  <defs>
    <linearGradient id="chart-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#111827" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="24" fill="url(#chart-bg)" />
  <text id="chart-title" x="${margin.left}" y="58" fill="#f8fafc" font-size="34" font-weight="700">${escapeHtml(spec.title)}</text>
  <text id="chart-subtitle" x="${margin.left}" y="88" fill="#94a3b8" font-size="18">${escapeHtml(spec.subtitle || spec.yLabel || "Deterministic vault chart")}</text>
  ${gridLines.join("\n")}
  <line x1="${margin.left}" y1="${zeroY}" x2="${width - margin.right}" y2="${zeroY}" stroke="#e2e8f0" stroke-width="1.5" opacity="0.55" />
  ${bars.join("\n")}
</svg>
`;
}

function renderMarpOutput(args) {
  const bodyText = readText(args.bodyFile);
  const slug = getSafeFileStem(args.slug || args.title, "slides");
  const outputPath = buildOutputTargetPath(path.resolve(args.vault), "marp", `${slug}.md`);
  const metadataPath = buildOutputTargetPath(path.resolve(args.vault), "marp", `${slug}.meta.json`);

  ensureDir(path.dirname(outputPath));
  writeText(
    outputPath,
    renderMarpMarkdown({
      title: args.title,
      theme: args.theme,
      bodyText,
    }),
  );
  writeJson(metadataPath, {
    kind: "marp",
    title: args.title,
    renderedAt: isoNow(),
    bodyFile: path.resolve(args.bodyFile),
    outputPath,
    theme: args.theme,
  });

  return { kind: "marp", outputPath, metadataPath };
}

function renderChartOutput(args) {
  const spec = JSON.parse(readText(args.specFile));
  const normalizedSpec = normalizeChartSpec(spec, args.title);
  const slug = getSafeFileStem(args.slug || args.title, "chart");
  const outputPath = buildOutputTargetPath(path.resolve(args.vault), "chart", `${slug}.svg`);
  const specOutputPath = buildOutputTargetPath(
    path.resolve(args.vault),
    "chart",
    `${slug}.spec.json`,
  );
  const metadataPath = buildOutputTargetPath(
    path.resolve(args.vault),
    "chart",
    `${slug}.meta.json`,
  );

  ensureDir(path.dirname(outputPath));
  writeText(outputPath, renderBarChartSvg(normalizedSpec));
  writeJson(specOutputPath, normalizedSpec);
  writeJson(metadataPath, {
    kind: "chart",
    title: normalizedSpec.title,
    renderedAt: isoNow(),
    specFile: path.resolve(args.specFile),
    outputPath,
    seriesCount: normalizedSpec.series.length,
  });

  return {
    kind: "chart",
    outputPath,
    specOutputPath,
    metadataPath,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = args.kind === "chart" ? renderChartOutput(args) : renderMarpOutput(args);
  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        vaultPath: path.resolve(args.vault),
        title: args.title,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
