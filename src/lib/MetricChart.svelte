<script>
  // CW-style metric chart. Props:
  //   points  — array of { t: epoch_ms, v: number|null }
  //   color   — stroke color (CSS color string)
  //   label   — chart title
  //   unit    — Y-axis unit label (shown top-left)
  //   fmt     — (v) => string  for current-value display
  let { points = [], color = '#2563eb', label = '', unit = '', fmt = (v) => v?.toFixed(1) ?? '—' } = $props();

  // Layout constants (SVG user units)
  const VW = 420, VH = 160;
  const ML = 54, MR = 10, MT = 10, MB = 26;
  const PW = VW - ML - MR;
  const PH = VH - MT - MB;

  function niceMax(v) {
    if (!v || v === 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    for (const n of [1, 2, 2.5, 5, 10]) {
      if (n * mag >= v) return n * mag;
    }
    return 10 * mag;
  }

  function fmtTick(v, yMax) {
    if (v === 0) return '0';
    if (yMax >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
    if (yMax >= 1000)      return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
    if (yMax < 1)          return v.toFixed(2);
    if (yMax < 10)         return v.toFixed(1);
    return Math.round(v).toString();
  }

  const chart = $derived.by(() => {
    const valid = points.filter(p => p.v != null);
    if (valid.length < 1) return null;

    const cur    = valid[valid.length - 1].v;
    const rawMax = Math.max(...valid.map(p => p.v));
    const yMax   = niceMax(rawMax);
    const yTicks = [0, yMax / 2, yMax];

    function yCo(v) { return MT + PH - (v / yMax) * PH; }
    function xCo(i) { return ML + (points.length < 2 ? 0.5 : i / (points.length - 1)) * PW; }

    // Single point: draw a horizontal reference line at the current value
    if (valid.length < 2) {
      const y = yCo(cur).toFixed(1);
      const d = `M${ML},${y} L${VW - MR},${y}`;
      return { d, yTicks, yMax, xLabels: [], yCo, cur, single: true };
    }

    // Line path — handles null gaps
    let d = '';
    let pen = false;
    for (let i = 0; i < points.length; i++) {
      const v = points[i].v;
      if (v == null) { pen = false; continue; }
      const x = xCo(i).toFixed(1), y = yCo(v).toFixed(1);
      d += pen ? `L${x},${y} ` : `M${x},${y} `;
      pen = true;
    }

    // X-axis time labels (up to 5, avoid overlap)
    const step = Math.max(1, Math.floor((points.length - 1) / 4));
    const idxs = new Set([0]);
    for (let i = step; i < points.length - 1; i += step) idxs.add(i);
    idxs.add(points.length - 1);
    const xLabels = [...idxs].map(i => ({
      x: xCo(i),
      label: new Date(points[i].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));

    return { d, yTicks, yMax, xLabels, yCo, cur, single: false };
  });

  // Hover tooltip
  let hover = $state(null); // { x, y, value, time } in SVG coords

  function onMouseMove(e) {
    if (!chart || chart.single) return;
    const svg   = e.currentTarget;
    const rect  = svg.getBoundingClientRect();
    // Convert mouse X to SVG user units
    const svgX  = ((e.clientX - rect.left) / rect.width) * VW;
    if (svgX < ML || svgX > VW - MR) { hover = null; return; }
    // Find nearest point index
    const ratio = (svgX - ML) / PW;
    const idx   = Math.round(ratio * (points.length - 1));
    const pt    = points[Math.max(0, Math.min(idx, points.length - 1))];
    if (pt.v == null) { hover = null; return; }
    const xCo  = (i) => ML + (i / (points.length - 1)) * PW;
    const hx   = xCo(idx);
    const hy   = chart.yCo(pt.v);
    hover = {
      x:     hx,
      y:     hy,
      value: fmt(pt.v),
      time:  new Date(pt.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      flip:  hx > VW * 0.65, // flip tooltip to left when near right edge
    };
  }
</script>

<div class="chart-card">
  <div class="chart-head">
    <span class="chart-title">{label}</span>
    <span class="chart-cur">{chart ? fmt(chart.cur) : '—'}</span>
  </div>

  {#if chart}
    <svg viewBox="0 0 {VW} {VH}" preserveAspectRatio="none" class="chart-svg"
         onmousemove={onMouseMove} onmouseleave={() => (hover = null)}>
      <!-- horizontal grid lines + Y labels -->
      {#each chart.yTicks as tick}
        {@const y = chart.yCo(tick).toFixed(1)}
        <line x1={ML} x2={VW - MR} y1={y} y2={y}
              stroke="var(--border)" stroke-width="0.8"
              stroke-dasharray={tick === 0 ? 'none' : '3 3'} />
        <text x={ML - 5} y={y} dy="0.35em" text-anchor="end" class="tick-label">
          {fmtTick(tick, chart.yMax)}
        </text>
      {/each}

      <!-- unit label (top-left inside axis) -->
      {#if unit}
        <text x={ML + 4} y={MT + 2} dominant-baseline="hanging" class="unit-label">{unit}</text>
      {/if}

      <!-- line (dashed when only one point) -->
      <path d={chart.d} fill="none" stroke={color} stroke-width="1.8"
            stroke-linejoin="round" stroke-linecap="round"
            stroke-dasharray={chart.single ? '4 4' : 'none'} opacity={chart.single ? 0.5 : 1}/>

      <!-- X-axis time labels -->
      {#each chart.xLabels as lbl}
        <text x={lbl.x} y={VH - MB + 14} text-anchor="middle" class="tick-label">{lbl.label}</text>
      {/each}

      <!-- baseline axis line -->
      <line x1={ML} x2={VW - MR} y1={MT + PH} y2={MT + PH} stroke="var(--border)" stroke-width="1"/>
      <!-- Y axis line -->
      <line x1={ML} x2={ML} y1={MT} y2={MT + PH} stroke="var(--border)" stroke-width="1"/>

      <!-- Hover crosshair + tooltip -->
      {#if hover}
        <line x1={hover.x} x2={hover.x} y1={MT} y2={MT + PH}
              stroke={color} stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
        <circle cx={hover.x} cy={hover.y} r="4" fill={color} stroke="var(--panel)" stroke-width="1.5"/>
        {@const tx = hover.flip ? hover.x - 8 : hover.x + 8}
        {@const anchor = hover.flip ? 'end' : 'start'}
        <rect x={hover.flip ? tx - 92 : tx} y={hover.y - 22}
              width="92" height="36" rx="4"
              fill="var(--panel)" stroke="var(--border)" stroke-width="1"/>
        <text x={tx} y={hover.y - 6} text-anchor={anchor} class="tip-val">{hover.value}</text>
        <text x={tx} y={hover.y + 10} text-anchor={anchor} class="tip-time">{hover.time}</text>
      {/if}
    </svg>
  {:else}
    <div class="chart-empty">Collecting data…</div>
  {/if}
</div>

<style>
  .chart-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px 10px;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chart-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .chart-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .chart-cur {
    font-size: 20px;
    font-weight: 700;
    font-family: var(--mono);
    line-height: 1;
  }
  .chart-svg {
    width: 100%;
    height: 160px;
    display: block;
    overflow: visible;
  }
  .tick-label {
    font-size: 10px;
    fill: var(--muted);
    font-family: ui-monospace, monospace;
  }
  .unit-label {
    font-size: 9px;
    fill: var(--muted);
    font-family: ui-monospace, monospace;
  }
  .tip-val {
    font-size: 11px;
    font-weight: 700;
    fill: var(--text);
    font-family: ui-monospace, monospace;
  }
  .tip-time {
    font-size: 10px;
    fill: var(--muted);
    font-family: ui-monospace, monospace;
  }
  .chart-svg { cursor: crosshair; }
  .chart-empty {
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--muted);
    font-style: italic;
  }
</style>
