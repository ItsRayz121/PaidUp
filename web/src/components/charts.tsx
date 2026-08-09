"use client";

// The chart primitives the admin dashboard is built from.
//
// No chart library, deliberately: these are three shapes over small arrays, and
// a charting dependency on an internal page is a bundle and a migration for no
// benefit. Everything is inline SVG.
//
// DESIGN DECISIONS THAT ARE NOT TASTE
// -----------------------------------
// 1. ONE SERIES PER PANEL, ONE COLOR. The dashboard shows five different
//    measures over time. Putting two on one plot would need two y-scales, and a
//    dual-axis chart invents a correlation that is not in the data — the
//    single most common way a dashboard misleads. So: small multiples, each
//    with its own axis, each with exactly one series. With one series per panel
//    the colour is not encoding anything (the panel title does), so all panels
//    share one hue rather than being rainbow-coded by metric.
//
// 2. THE SERIES COLOUR WAS VALIDATED, NOT PICKED. The obvious choice was the
//    brand teal (#0d5c63) — it FAILS the chroma floor for a data mark: at that
//    saturation a thin 2px line reads as grey rather than as a colour. #0a9aa8
//    is the nearest step in the same family that passes lightness band, chroma
//    floor and 3:1 contrast against the white card.
//
// 3. LIGHT ONLY, ON PURPOSE. This app defines no dark tokens (globals.css is
//    `color-scheme: light`), and a dark chart inside a light panel would be
//    worse than no dark mode at all.
//
// 4. HOVER IS NOT OPTIONAL. An SVG chart on a web page is interactive whether
//    or not you plan for it; a reader who cannot get the number for a specific
//    day has to squint at a line. Every time series here carries a crosshair
//    and a tooltip.

import { useState } from "react";

// The one validated series colour. See note 2 above before changing it.
export const SERIES = "#0a9aa8";
// Recessive: grid and axes must sit behind the data, never compete with it.
const GRID = "#e3ebec";
const AXIS_TEXT = "#566467";

// A fixed viewBox with non-scaling strokes. This is what makes the charts
// responsive without a ResizeObserver: the SVG scales to its container, and
// `vector-effect` keeps the 2px line exactly 2px at any width instead of
// stretching it into a wedge.
const W = 600;
const H = 150;
const PAD = { top: 10, right: 8, bottom: 20, left: 36 };

export type Point = { label: string; value: number };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const compact = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n * 100) / 100);
};

/**
 * A single measure over time. Area + line, one series, crosshair on hover.
 */
export function TimeChart(
  { title, points, format = compact, note }:
  { title: string; points: Point[]; format?: (n: number) => string; note?: string },
) {
  const [hover, setHover] = useState<number | null>(null);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const x = (i: number) =>
    PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const area = points.length
    ? `${line} L${x(points.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`
    : "";

  // Map a pointer position to the nearest data point. The SVG is scaled, so the
  // client x has to be converted back through the element's own width.
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0 || points.length === 0) return;
    const vx = ((e.clientX - box.left) / box.width) * W;
    const t = (vx - PAD.left) / (plotW || 1);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(t * (points.length - 1)))));
  }

  const hi = hover !== null ? points[hover] : null;
  // Only three x labels: first, middle, last. A tick under every day at this
  // width is an unreadable smear, and the tooltip gives the exact date anyway.
  const ticks = points.length
    ? [0, Math.floor((points.length - 1) / 2), points.length - 1]
      .filter((v, i, a) => a.indexOf(v) === i)
    : [];

  return (
    <figure className="relative m-0 rounded-lg border border-line bg-card p-3">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-brand-ink">{title}</span>
        <span className="num text-sm font-bold text-brand-ink">
          {format(points.reduce((s, p) => s + p.value, 0))}
        </span>
      </figcaption>
      {note && <p className="mb-1 text-xs text-muted">{note}</p>}

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="auto"
        className="block touch-none"
        role="img" aria-label={`${title} over the last ${points.length} days`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {/* Grid: three lines, recessive. Enough to read a level, not a lattice. */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right}
              y1={PAD.top + plotH * f} y2={PAD.top + plotH * f}
              stroke={GRID} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={PAD.left - 6} y={PAD.top + plotH * f + 3} textAnchor="end"
              fontSize={9} fill={AXIS_TEXT}>{compact(max * (1 - f))}</text>
          </g>
        ))}

        {area && <path d={area} fill={SERIES} opacity={0.12} />}
        {line && (
          <path d={line} fill="none" stroke={SERIES} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}

        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} fontSize={9} fill={AXIS_TEXT}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
            {points[i].label.slice(5)}
          </text>
        ))}

        {hover !== null && hi && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH}
              stroke={AXIS_TEXT} strokeWidth={1} strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke" />
            {/* A 2px surface ring so the marker stays legible wherever it lands
                on the area fill. */}
            <circle cx={x(hover)} cy={y(hi.value)} r={4.5}
              fill={SERIES} stroke="#ffffff" strokeWidth={2}
              vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {/* Tooltip in HTML, not SVG: text wraps and inherits the page's font. */}
      {hi && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-line bg-card px-2 py-1 text-xs shadow-sm">
          <span className="text-muted">{hi.label}</span>{" "}
          <span className="num font-semibold text-brand-ink">{format(hi.value)}</span>
        </div>
      )}
    </figure>
  );
}

/**
 * A funnel: a few ordered stages, each a bar, all one colour.
 *
 * One colour on purpose — shading each bar darker-where-bigger would encode the
 * value twice (length AND hue) and spend the only free channel on information
 * the bar length already carries.
 */
export function FunnelBars(
  { title, stages }: { title: string; stages: { label: string; value: number }[] },
) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <figure className="m-0 rounded-lg border border-line bg-card p-3">
      <figcaption className="mb-2 text-sm font-semibold text-brand-ink">{title}</figcaption>
      <div className="space-y-2">
        {stages.map((s, i) => (
          <div key={s.label}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">{s.label}</span>
              <span className="num font-semibold text-brand-ink">
                {compact(s.value)}
                {/* The drop-off between stages is the point of a funnel, so it
                    is stated rather than left to be measured off the bars. */}
                {i > 0 && stages[i - 1].value > 0 && (
                  <span className="ms-1 font-normal text-muted">
                    ({Math.round((s.value / stages[i - 1].value) * 100)}%)
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 h-2 rounded-full bg-brand-tint">
              <div className="h-2 rounded-full" style={{
                width: `${(s.value / max) * 100}%`, background: SERIES,
              }} />
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}

/** A labelled number. Not a chart — a single value's job is to be read. */
export function StatTile(
  { label, value, sub, tone = "normal" }:
  { label: string; value: string; sub?: string; tone?: "normal" | "warn" | "bad" },
) {
  const toneCls =
    tone === "bad" ? "text-danger" : tone === "warn" ? "text-pending" : "text-brand-ink";
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      {/* Proportional figures, not tabular: tabular-nums gives every digit the
          width of a zero, which makes a large standalone number look gappy. */}
      <p className={`num text-xl font-bold ${toneCls}`}>{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

export { compact };
