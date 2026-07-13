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
    if (valid.length < 2) return null;

    const rawMax = Math.max(...valid.map(p => p.v));
    const yMax   = niceMax(rawMax);
    const yTicks = [0, yMax / 2, yMax];

    function yCo(v) { return MT + PH - (v / yMax) * PH; }
    function xCo(i) { return ML + (i / (points.length - 1)) * PW; }

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

    const cur = valid[valid.length - 1].v;

    return { d, yTicks, yMax, xLabels, yCo, cur };
  });
</script>

<div class="chart-card">
  <div class="chart-head">
    <span class="chart-title">{label}</span>
    {#if chart}
      <span class="chart-cur">{fmt(chart.cur)}</span>
    {/if}
  </div>

  {#if chart}
    <svg viewBox="0 0 {VW} {VH}" preserveAspectRatio="none" class="chart-svg">
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

      <!-- line -->
      <path d={chart.d} fill="none" stroke={color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>

      <!-- X-axis time labels -->
      {#each chart.xLabels as lbl}
        <text x={lbl.x} y={VH - MB + 14} text-anchor="middle" class="tick-label">{lbl.label}</text>
      {/each}

      <!-- baseline axis line -->
      <line x1={ML} x2={VW - MR} y1={MT + PH} y2={MT + PH} stroke="var(--border)" stroke-width="1"/>
      <!-- Y axis line -->
      <line x1={ML} x2={ML} y1={MT} y2={MT + PH} stroke="var(--border)" stroke-width="1"/>
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
