import { useId, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnswerSurfaceTone } from "../../../shared/answer-surfaces/schema";
import { formatChartNumber } from "../../../shared/answer-surfaces/runtime";

type ChartPoint = Record<string, string | number | null>;

export type AnswerSurfaceChartSeries = {
  name: string;
  style: "solid" | "muted" | "dashed";
  tone?: AnswerSurfaceTone;
};

type ChartProps = {
  kind: "bar" | "line" | "area" | "pie";
  data: ChartPoint[];
  series: AnswerSurfaceChartSeries[];
  unit?: string;
  prefix?: string;
  format?: "number" | "compact" | "percent";
  stacked: boolean;
  horizontal: boolean;
  height: "sm" | "md" | "lg";
};

/** Palette slots come from the surface theme (`--as-c1`…`--as-c5`), so charts follow it. */
function paletteColor(index: number): string {
  return `var(--as-c${(index % 5) + 1})`;
}

/** Muted series are context (a baseline, "keeping it as cash") and stay grey and quiet. */
function seriesColors(series: AnswerSurfaceChartSeries[]): string[] {
  let next = 0;
  return series.map((entry) => {
    if (entry.style === "muted") return "var(--as-series-muted)";
    if (entry.tone) return `var(--as-tone-${entry.tone})`;
    const color = paletteColor(next);
    next += 1;
    return color;
  });
}

const AXIS = {
  axisLine: false,
  tickLine: false,
  tick: { fill: "var(--color-text-muted)", fontSize: 11.5 },
} as const;

const ANIMATION = { isAnimationActive: true, animationDuration: 600 } as const;

function estimateTextWidth(text: string, fontSize = 11.5): number {
  return Math.ceil(text.length * fontSize * 0.6);
}

function ChartTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: unknown; color?: string; payload?: ChartPoint }>;
  label?: string | number;
  format: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const title = label ?? payload[0]?.payload?.label;
  return (
    <div className="as-chart-tooltip">
      {title !== undefined && <div className="as-chart-tooltip-title">{String(title)}</div>}
      {payload.map((entry, index) => (
        <div key={`${entry.name}-${index}`} className="as-chart-tooltip-row">
          <span className="as-chart-swatch" style={{ background: entry.color }} />
          <span className="as-chart-tooltip-name">{entry.name}</span>
          <span className="as-chart-tooltip-value">
            {typeof entry.value === "number" ? format(entry.value) : String(entry.value ?? "—")}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({
  series,
  colors,
  kind,
}: {
  series: AnswerSurfaceChartSeries[];
  colors: string[];
  kind: ChartProps["kind"];
}) {
  return (
    <ul className="as-chart-legend">
      {series.map((entry, index) => (
        <li key={entry.name}>
          <span
            className={`as-chart-key as-chart-key-${kind === "bar" ? "box" : entry.style === "dashed" || entry.style === "muted" ? "dashed" : "line"}`}
            style={{ color: colors[index] }}
          />
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

export function AnswerSurfaceChart({
  kind,
  data,
  series,
  unit,
  prefix,
  format,
  stacked,
  horizontal,
  height,
}: ChartProps) {
  const gradientBase = useId().replace(/:/g, "");
  const colors = seriesColors(series);
  const formatValue = (value: number) => formatChartNumber(value, { prefix, unit, format });
  // Long units ("people", "kg CO2") crowd the axis; the tooltip and labels still carry them.
  const axisUnit = unit && unit.length <= 2 ? unit : undefined;
  const formatTick = (value: number) =>
    formatChartNumber(value, { prefix, unit: axisUnit, format: format ?? "compact" });
  const tooltip = (
    <Tooltip
      content={<ChartTooltip format={formatValue} />}
      cursor={
        kind === "bar"
          ? { fill: "var(--color-bg-hover)", radius: 8 }
          : { stroke: "var(--color-border)", strokeDasharray: "4 4" }
      }
    />
  );

  if (kind === "pie") {
    const name = series[0]?.name ?? "";
    const values = data.map((point) => (typeof point[name] === "number" ? point[name] : 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    return (
      <div className={`as-chart-pie as-chart-${height}`}>
        <div className="as-chart-pie-canvas">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey={name}
                nameKey="label"
                innerRadius="64%"
                outerRadius="94%"
                paddingAngle={2}
                cornerRadius={6}
                stroke="none"
                {...ANIMATION}
              >
                {data.map((_point, index) => (
                  <Cell key={index} fill={paletteColor(index)} />
                ))}
              </Pie>
              {tooltip}
            </PieChart>
          </ResponsiveContainer>
          <div className="as-chart-center" aria-hidden="true">
            <span className="as-chart-center-value">{formatValue(total)}</span>
            <span className="as-chart-center-label">Total</span>
          </div>
        </div>
        <ul className="as-chart-pie-legend">
          {data.map((point, index) => (
            <li key={index}>
              <span className="as-chart-swatch" style={{ background: paletteColor(index) }} />
              <span className="as-chart-pie-name">{String(point.label)}</span>
              <span className="as-chart-pie-value">{formatValue(values[index])}</span>
              <span className="as-chart-pie-share">
                {total > 0 ? `${Math.round((values[index] / total) * 100)}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const numbers = data.flatMap((point) =>
    series.map((entry) => point[entry.name]).filter((value) => typeof value === "number"),
  ) as number[];
  const peak = numbers.length > 0 ? Math.max(...numbers.map(Math.abs)) : 0;
  const yWidth = Math.min(84, Math.max(32, estimateTextWidth(formatTick(peak)) + 10));
  const showEndLabels =
    (kind === "line" || kind === "area") && !stacked && series.length <= 3 && data.length > 1;
  const endLabelWidth = showEndLabels
    ? Math.max(
        ...series.map((entry) => {
          const last = data[data.length - 1]?.[entry.name];
          return typeof last === "number" ? estimateTextWidth(formatValue(last), 12) : 0;
        }),
      ) + 14
    : 16;
  const margin = { top: 12, right: endLabelWidth, bottom: 0, left: 0 };

  const endLabel =
    (color: string) =>
    (props: { x?: number | string; y?: number | string; index?: number; value?: unknown }) => {
      const { x, y, index, value } = props;
      if (index !== data.length - 1 || typeof value !== "number") return <g />;
      return (
        <text x={Number(x) + 8} y={Number(y)} dy={4} fill={color} className="as-chart-end-label">
          {formatValue(value)}
        </text>
      );
    };

  const defs = (
    <defs>
      {series.map((entry, index) => (
        <linearGradient
          key={entry.name}
          id={`${gradientBase}-${index}`}
          x1="0"
          y1="0"
          x2={kind === "bar" && horizontal ? "1" : "0"}
          y2={kind === "bar" && horizontal ? "0" : "1"}
        >
          <stop
            offset="0%"
            stopColor={colors[index]}
            stopOpacity={kind === "area" ? (entry.style === "muted" ? 0.12 : 0.38) : 1}
          />
          <stop
            offset="100%"
            stopColor={colors[index]}
            stopOpacity={kind === "area" ? 0.02 : 0.72}
          />
        </linearGradient>
      ))}
    </defs>
  );
  const grid = (
    <CartesianGrid
      stroke="var(--color-border-subtle)"
      strokeDasharray="3 5"
      vertical={horizontal}
      horizontal={!horizontal}
    />
  );
  const legend = series.length > 1 && <ChartLegend series={series} colors={colors} kind={kind} />;
  const dash = (entry: AnswerSurfaceChartSeries) =>
    entry.style === "dashed" || entry.style === "muted" ? "6 5" : undefined;

  let chart: ReactNode;
  if (kind === "line") {
    chart = (
      <LineChart data={data} margin={margin}>
        {defs}
        {grid}
        <XAxis dataKey="label" {...AXIS} minTickGap={16} dy={6} />
        <YAxis {...AXIS} width={yWidth} tickFormatter={formatTick} />
        {tooltip}
        {series.map((entry, index) => (
          <Line
            key={entry.name}
            type="monotone"
            dataKey={entry.name}
            stroke={colors[index]}
            strokeWidth={entry.style === "muted" ? 2 : 3}
            strokeDasharray={dash(entry)}
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--as-card-bg)" }}
            label={showEndLabels ? endLabel(colors[index]) : undefined}
            {...ANIMATION}
          />
        ))}
      </LineChart>
    );
  } else if (kind === "area") {
    chart = (
      <AreaChart data={data} margin={margin}>
        {defs}
        {grid}
        <XAxis dataKey="label" {...AXIS} minTickGap={16} dy={6} />
        <YAxis {...AXIS} width={yWidth} tickFormatter={formatTick} />
        {tooltip}
        {series.map((entry, index) => (
          <Area
            key={entry.name}
            type="monotone"
            dataKey={entry.name}
            stackId={stacked ? "stack" : undefined}
            stroke={colors[index]}
            strokeWidth={entry.style === "muted" ? 2 : 2.5}
            strokeDasharray={dash(entry)}
            fill={`url(#${gradientBase}-${index})`}
            activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--as-card-bg)" }}
            label={showEndLabels ? endLabel(colors[index]) : undefined}
            {...ANIMATION}
          />
        ))}
      </AreaChart>
    );
  } else {
    const labelWidth = Math.min(
      140,
      Math.max(48, ...data.map((point) => estimateTextWidth(String(point.label ?? "")) + 10)),
    );
    chart = (
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 12, right: 16, bottom: 0, left: 0 }}
        barCategoryGap={horizontal ? "24%" : "28%"}
      >
        {defs}
        {grid}
        {horizontal ? (
          <>
            <XAxis type="number" {...AXIS} tickFormatter={formatTick} />
            <YAxis type="category" dataKey="label" {...AXIS} width={labelWidth} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" {...AXIS} minTickGap={8} dy={6} />
            <YAxis {...AXIS} width={yWidth} tickFormatter={formatTick} />
          </>
        )}
        {tooltip}
        {series.map((entry, index) => (
          <Bar
            key={entry.name}
            dataKey={entry.name}
            stackId={stacked ? "stack" : undefined}
            fill={`url(#${gradientBase}-${index})`}
            radius={horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]}
            maxBarSize={horizontal ? 22 : 44}
            {...ANIMATION}
          />
        ))}
      </BarChart>
    );
  }

  return (
    <div className="as-chart-body">
      {legend}
      <div className={`as-chart-canvas as-chart-${height}`}>
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
