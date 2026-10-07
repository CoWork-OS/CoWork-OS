import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/** Series colors from the app's tokens, so charts follow the theme. */
const SERIES_COLORS = [
  "var(--color-accent)",
  "var(--color-purple)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-info)",
  "var(--color-error)",
];

type ChartPoint = Record<string, string | number | null>;

export function AnswerSurfaceChart({
  kind,
  data,
  series,
  unit,
}: {
  kind: "bar" | "line" | "area" | "pie";
  data: ChartPoint[];
  series: string[];
  unit?: string;
}) {
  const formatValue = (value: unknown) =>
    typeof value === "number"
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ""}`
      : String(value ?? "");
  const axis = {
    stroke: "var(--color-text-muted)",
    tick: { fill: "var(--color-text-secondary)", fontSize: 12 },
    tickLine: false,
  };
  const tooltip = (
    <Tooltip
      formatter={formatValue}
      contentStyle={{
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        color: "var(--color-text-primary)",
      }}
    />
  );
  const legend = series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null;

  return (
    <div className="as-chart-canvas">
      <ResponsiveContainer width="100%" height="100%">
        {kind === "pie" ? (
          <PieChart>
            <Pie
              data={data}
              dataKey={series[0]}
              nameKey="label"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
            >
              {data.map((_point, index) => (
                <Cell key={index} fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
              ))}
            </Pie>
            {tooltip}
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        ) : kind === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={48} tickFormatter={(value: number) => formatValue(value)} />
            {tooltip}
            {legend}
            {series.map((name, index) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        ) : kind === "area" ? (
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={48} tickFormatter={(value: number) => formatValue(value)} />
            {tooltip}
            {legend}
            {series.map((name, index) => (
              <Area
                key={name}
                type="monotone"
                dataKey={name}
                stackId="stack"
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                fillOpacity={0.25}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={48} tickFormatter={(value: number) => formatValue(value)} />
            {tooltip}
            {legend}
            {series.map((name, index) => (
              <Bar
                key={name}
                dataKey={name}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                radius={[6, 6, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
