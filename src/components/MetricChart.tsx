import { useState } from 'react';

export interface MetricPoint {
  t: number; // epoch ms
  v: number | null;
}

// Hand-rolled SVG line chart — ported from src-v1/lib/MetricChart.svelte.
// No chart library per DESIGN_SPEC §8. Empty state ("Collecting data…") is
// honest — never seeded with sample numbers (see /CLAUDE.md).
const VW = 420;
const VH = 160;
const ML = 54;
const MR = 10;
const MT = 10;
const MB = 26;
const PW = VW - ML - MR;
const PH = VH - MT - MB;

function niceMax(v: number) {
  if (!v || v === 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const n of [1, 2, 2.5, 5, 10]) {
    if (n * mag >= v) return n * mag;
  }
  return 10 * mag;
}

function fmtTick(v: number, yMax: number) {
  if (v === 0) return '0';
  if (yMax >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (yMax >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  if (yMax < 1) return v.toFixed(2);
  if (yMax < 10) return v.toFixed(1);
  return Math.round(v).toString();
}

interface Hover {
  x: number;
  y: number;
  value: string;
  time: string;
  flip: boolean;
}

export function MetricChart({
  points = [],
  color = 'var(--chart-line)',
  label = '',
  unit = '',
  fmt = (v: number | null) => v?.toFixed(1) ?? '—',
}: {
  points?: MetricPoint[];
  color?: string;
  label?: string;
  unit?: string;
  fmt?: (v: number | null) => string;
}) {
  const [hover, setHover] = useState<Hover | null>(null);

  const valid = points.filter((p) => p.v != null);
  const chart = (() => {
    if (valid.length < 1) return null;
    const cur = valid[valid.length - 1].v!;
    const rawMax = Math.max(...valid.map((p) => p.v!));
    const yMax = niceMax(rawMax);
    const yTicks = [0, yMax / 2, yMax];

    const yCo = (v: number) => MT + PH - (v / yMax) * PH;
    const xCo = (i: number) => ML + (points.length < 2 ? 0.5 : i / (points.length - 1)) * PW;

    if (valid.length < 2) {
      const y = yCo(cur).toFixed(1);
      const d = `M${ML},${y} L${VW - MR},${y}`;
      return { d, yTicks, yMax, xLabels: [] as { x: number; label: string }[], yCo, cur, single: true };
    }

    let d = '';
    let pen = false;
    for (let i = 0; i < points.length; i++) {
      const v = points[i].v;
      if (v == null) {
        pen = false;
        continue;
      }
      const x = xCo(i).toFixed(1);
      const y = yCo(v).toFixed(1);
      d += pen ? `L${x},${y} ` : `M${x},${y} `;
      pen = true;
    }

    const step = Math.max(1, Math.floor((points.length - 1) / 4));
    const idxs = new Set([0]);
    for (let i = step; i < points.length - 1; i += step) idxs.add(i);
    idxs.add(points.length - 1);
    const xLabels = [...idxs].map((i) => ({
      x: xCo(i),
      label: new Date(points[i].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));

    return { d, yTicks, yMax, xLabels, yCo, cur, single: false };
  })();

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!chart || chart.single) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * VW;
    if (svgX < ML || svgX > VW - MR) {
      setHover(null);
      return;
    }
    const ratio = (svgX - ML) / PW;
    const idx = Math.round(ratio * (points.length - 1));
    const pt = points[Math.max(0, Math.min(idx, points.length - 1))];
    if (pt.v == null) {
      setHover(null);
      return;
    }
    const xCo = (i: number) => ML + (i / (points.length - 1)) * PW;
    const hx = xCo(idx);
    const hy = chart.yCo(pt.v);
    setHover({
      x: hx,
      y: hy,
      value: fmt(pt.v),
      time: new Date(pt.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      flip: hx > VW * 0.65,
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 pt-3.5 pb-2.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="text-md font-semibold text-foreground">{label}</span>
        <span className="font-mono text-lg leading-none font-bold">{chart ? fmt(chart.cur) : '—'}</span>
      </div>

      {chart ? (
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="none"
          className="block h-40 w-full cursor-crosshair"
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        >
          {chart.yTicks.map((tick, i) => {
            const y = chart.yCo(tick).toFixed(1);
            return (
              <g key={i}>
                <line x1={ML} x2={VW - MR} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={0.8} strokeDasharray={tick === 0 ? 'none' : '3 3'} />
                <text x={ML - 5} y={y} dy="0.35em" textAnchor="end" className="fill-text-muted font-mono text-[10px]">
                  {fmtTick(tick, chart.yMax)}
                </text>
              </g>
            );
          })}

          {unit && (
            <text x={ML + 4} y={MT + 2} dominantBaseline="hanging" className="fill-text-muted font-mono text-[9px]">
              {unit}
            </text>
          )}

          <path
            d={chart.d}
            fill="none"
            stroke={color}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={chart.single ? '4 4' : 'none'}
            opacity={chart.single ? 0.5 : 1}
          />

          {chart.xLabels.map((lbl, i) => (
            <text key={i} x={lbl.x} y={VH - MB + 14} textAnchor="middle" className="fill-text-muted font-mono text-[10px]">
              {lbl.label}
            </text>
          ))}

          <line x1={ML} x2={VW - MR} y1={MT + PH} y2={MT + PH} stroke="var(--chart-grid)" strokeWidth={1} />
          <line x1={ML} x2={ML} y1={MT} y2={MT + PH} stroke="var(--chart-grid)" strokeWidth={1} />

          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={MT} y2={MT + PH} stroke={color} strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <circle cx={hover.x} cy={hover.y} r={4} fill={color} stroke="var(--bg-panel)" strokeWidth={1.5} />
              {(() => {
                const tx = hover.flip ? hover.x - 8 : hover.x + 8;
                const anchor = hover.flip ? 'end' : 'start';
                return (
                  <>
                    <rect
                      x={hover.flip ? tx - 92 : tx}
                      y={hover.y - 22}
                      width={92}
                      height={36}
                      rx={4}
                      fill="var(--bg-panel)"
                      stroke="var(--border)"
                      strokeWidth={1}
                    />
                    <text x={tx} y={hover.y - 6} textAnchor={anchor} className="fill-foreground font-mono text-[11px] font-bold">
                      {hover.value}
                    </text>
                    <text x={tx} y={hover.y + 10} textAnchor={anchor} className="fill-text-muted font-mono text-[10px]">
                      {hover.time}
                    </text>
                  </>
                );
              })()}
            </>
          )}
        </svg>
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-text-muted italic">Collecting data…</div>
      )}
    </div>
  );
}
