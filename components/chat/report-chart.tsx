import type { ReportView } from "@/server/kernel/report/view";
import { currencySign, formatMoney, formatNumber, type Formats } from "@/lib/format";

// A report's chart (11c, 11e), drawn as SVG: bars to compare (a light comparison bar beside the measure),
// bars over time with a dashed target across, or a line. One axis, light gridlines, a legend above, each
// bar's value on hover. The table below it always carries every number.

const MEASURE = "#1E90FF";
const COMPARISON = "#BBDDFF";
const INK = "#62748E";
const GRID = "#E3E6EA";

const H = 250;
const PAD = { left: 52, right: 8, top: 10, bottom: 30 };
// About how wide a character of a 12.5px label is, to tell when labels would run into each other (#18).
const CHAR = 6.6;
const DRAWN = 5.8; // and how much room one takes once drawn, for the space a tilted label needs
const TILT = 35; // degrees, when they would
const LONGEST = 24; // characters a tilted label keeps; the table below has it in full

// Whole steps for counts (#18): 0, 2, 4, 6 jobs, never 1.333.
export function wholeSteps(max: number): number {
  const raw = Math.max(1, max / 3);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw)!;
  return step * 3;
}

function nice(max: number): number {
  if (max <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

// The axis in the company's currency: "$12k", "$1,200k"; in Indian grouping, lakhs and crores: "₹67k", "₹1.3L", "₹2.5Cr".
const one = (n: number) => String(Math.round(n * 10) / 10);
export function axisMoney(v: number, f: Formats): string {
  const a = Math.abs(v);
  if (f.grouping === "indian") {
    if (a >= 10_000_000) return `${currencySign(f)}${one(v / 10_000_000)}Cr`;
    if (a >= 100_000) return `${currencySign(f)}${one(v / 100_000)}L`;
  }
  return `${currencySign(f)}${a >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`;
}
const label = (v: number, format: string, f: Formats) => (format === "money" ? axisMoney(v, f) : format === "percent" ? `${Math.round(v)}%` : formatNumber(v, f));
const full = (v: number, format: string, f: Formats) => (format === "money" ? formatMoney(Math.round(v) * 100, f) : label(v, format, f));

// A bar with its top corners rounded (4px), standing on the baseline.
function bar(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ReportChart({ chart, compact }: { chart: ReportView["chart"]; compact?: boolean }) {
  if (chart.kind === "none" || !chart.series.length || !chart.labels.length) return null;
  // Drawn at the width it shows, so its text stays 12px: 800 in chat, 560 in the panel and the PDF (11d, 11h).
  const W = compact ? 560 : 800;
  const bars = chart.series.filter((s) => s.role !== "target");
  const targets = chart.series.filter((s) => s.role === "target");
  const format = chart.series[0]!.format;
  const values = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const whole = format === "number" && values.every((v) => Number.isInteger(v));
  const top = Math.max(0, ...values);
  const max = whole ? wholeSteps(top) : nice(top);
  const ticks = [0, 1, 2, 3].map((i) => (max * i) / 3);
  // Labels that don't fit under their bars are tilted, and the chart grows to hold them; the plot keeps its height,
  // and moves right when the first label would run off the left edge.
  const tilted = chart.labels.some((l) => l.length * CHAR > (W - PAD.left - PAD.right) / chart.labels.length - 8);
  const shown = (l: string) => (tilted && l.length > LONGEST ? `${l.slice(0, LONGEST - 1).trimEnd()}…` : l);
  const rad = (TILT * Math.PI) / 180;
  const across = (l: string) => shown(l).length * DRAWN * Math.cos(rad);
  const left = tilted ? Math.max(PAD.left, Math.ceil(across(chart.labels[0]!) - (W - PAD.left - PAD.right) / chart.labels.length / 2) + 20) : PAD.left;
  const plotW = W - left - PAD.right;
  const slot = plotW / chart.labels.length;
  const below = tilted ? Math.ceil(Math.max(...chart.labels.map((l) => shown(l).length)) * DRAWN * Math.sin(rad)) + 20 : PAD.bottom;
  const plotH = H - PAD.top - PAD.bottom;
  const height = PAD.top + plotH + below;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const barW = Math.min(34, (slot * 0.6) / Math.max(1, bars.length));
  const colour = (role: string) => (role === "comparison" ? COMPARISON : MEASURE);

  return (
    <figure className="m-0 flex flex-col gap-1.5" aria-label={`Chart: ${chart.series.map((s) => s.name).join(" and ")} by ${chart.labels.length} groups`}>
      {chart.series.length > 1 ? (
        <div className="flex items-center gap-4 pl-[50px] text-[13.5px] text-muted">
          {chart.series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              {s.role === "target" ? <span className="inline-block w-3.5 border-t-2 border-dashed border-ink" /> : <span className="inline-block size-2.5 rounded-[2px]" style={{ background: colour(s.role) }} />}
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${W} ${height}`} className={compact ? "w-full" : "w-full max-w-[800px]"} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={left - 10} y={y(t) + 4} textAnchor="end" fontSize={12} fill={INK}>
              {label(t, format, chart.formats)}
            </text>
          </g>
        ))}
        {chart.labels.map((name, i) => {
          const centre = left + slot * i + slot / 2;
          const groupW = bars.length * barW + (bars.length - 1) * 4;
          return (
            <g key={name}>
              {chart.kind === "bar"
                ? bars.map((s, j) => {
                    const v = s.values[i];
                    if (v === null || v === undefined) return null;
                    const x = centre - groupW / 2 + j * (barW + 4);
                    return (
                      <path key={s.name} d={bar(x, y(v), barW, Math.max(0, y(0) - y(v)))} fill={colour(s.role)}>
                        <title>{`${name} · ${s.name}: ${full(v, s.format, chart.formats)}`}</title>
                      </path>
                    );
                  })
                : null}
              {tilted ? (
                <text x={centre} y={PAD.top + plotH + 14} textAnchor="end" fontSize={12.5} fill="#314158" transform={`rotate(-${TILT} ${centre} ${PAD.top + plotH + 14})`}>
                  <title>{name}</title>
                  {shown(name)}
                </text>
              ) : (
                <text x={centre} y={PAD.top + plotH + 20} textAnchor="middle" fontSize={12.5} fill="#314158">
                  {name}
                </text>
              )}
            </g>
          );
        })}
        {chart.kind === "line"
          ? bars.map((s) => {
              const pts = s.values.map((v, i) => (v === null ? null : ([left + slot * i + slot / 2, y(v)] as const))).filter((p): p is readonly [number, number] => p !== null);
              return (
                <g key={s.name}>
                  <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={colour(s.role)} strokeWidth={2} />
                  {pts.map(([px, py], i) => (
                    <circle key={i} cx={px} cy={py} r={4} fill={colour(s.role)} stroke="#fff" strokeWidth={2}>
                      <title>{`${chart.labels[i]} · ${s.name}: ${full(s.values[i] ?? 0, s.format, chart.formats)}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })
          : null}
        {targets.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : ([left + slot * i + slot / 2, y(v)] as const))).filter((p): p is readonly [number, number] => p !== null);
          const flat = pts.every((p) => p[1] === pts[0]?.[1]);
          return flat && pts.length ? (
            <line key={s.name} x1={left} x2={W - PAD.right} y1={pts[0]![1]} y2={pts[0]![1]} stroke="#0F172B" strokeWidth={1.5} strokeDasharray="4 4">
              <title>{`${s.name}: ${full(s.values[0] ?? 0, s.format, chart.formats)}`}</title>
            </line>
          ) : (
            <polyline key={s.name} points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="#0F172B" strokeWidth={1.5} strokeDasharray="4 4" />
          );
        })}
      </svg>
    </figure>
  );
}
