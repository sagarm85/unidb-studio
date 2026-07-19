<script>
  let { onApply, defaultPreset = 'Last 24 hours' } = $props();

  const PRESETS = [
    { label: 'Last 10 minutes', ms:       10 * 60 * 1000 },
    { label: 'Last 30 minutes', ms:       30 * 60 * 1000 },
    { label: 'Last 1 hour',     ms:            60 * 60 * 1000 },
    { label: 'Last 3 hours',    ms:        3 * 60 * 60 * 1000 },
    { label: 'Last 24 hours',   ms:       24 * 60 * 60 * 1000 },
    { label: 'Today',           calendar: 'today' },
    { label: 'Yesterday',       calendar: 'yesterday' },
    { label: 'Last 7 days',     ms:   7 * 24 * 60 * 60 * 1000 },
    { label: 'Last 14 days',    ms:  14 * 24 * 60 * 60 * 1000 },
    { label: 'Last 28 days',    ms:  28 * 24 * 60 * 60 * 1000 },
  ];

  const MO = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
  const DH = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function p2(n) { return String(Math.max(0, Math.min(99, Number(n) || 0))).padStart(2, '0'); }
  function dayOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  // Initialise from default preset
  const _pr  = PRESETS.find(p => p.label === defaultPreset) ?? PRESETS[4];
  const _now = new Date();
  let _from, _to;
  if (_pr.calendar === 'today') {
    _from = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate(), 0, 0, 0);
    _to   = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate(), 23, 59, 59);
  } else if (_pr.calendar === 'yesterday') {
    const _y = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - 1);
    _from = new Date(_y.getFullYear(), _y.getMonth(), _y.getDate(), 0, 0, 0);
    _to   = new Date(_y.getFullYear(), _y.getMonth(), _y.getDate(), 23, 59, 59);
  } else {
    _from = new Date(_now.getTime() - _pr.ms);
    _to   = _now;
  }

  let open         = $state(false);
  let triggerLabel = $state(_pr.label);
  let activePreset = $state(_pr.label);

  let viewYear  = $state(_from.getFullYear());
  let viewMonth = $state(_from.getMonth());

  let selStart = $state(dayOnly(_from));
  let selEnd   = $state(dayOnly(_to));
  let startHH  = $state(p2(_from.getHours()));
  let startMM  = $state(p2(_from.getMinutes()));
  let startSS  = $state(p2(_from.getSeconds()));
  let endHH    = $state(p2(_to.getHours()));
  let endMM    = $state(p2(_to.getMinutes()));
  let endSS    = $state(p2(_to.getSeconds()));

  let phase    = $state(0);   // 0 = awaiting start click, 1 = awaiting end click
  let hoverDay = $state(null);
  let container;

  // ---- preset / calendar helpers ----------------------------------------

  function setPreset(p) {
    activePreset = p.label;
    const now  = new Date();
    let from, to;
    if (p.calendar === 'today') {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    } else if (p.calendar === 'yesterday') {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      from = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
      to   = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
    } else {
      from = new Date(now.getTime() - p.ms);
      to   = now;
    }
    selStart = dayOnly(from); selEnd = dayOnly(to);
    startHH = p2(from.getHours()); startMM = p2(from.getMinutes()); startSS = p2(from.getSeconds());
    endHH   = p2(to.getHours());   endMM   = p2(to.getMinutes());   endSS   = p2(to.getSeconds());
    viewYear  = from.getFullYear();
    viewMonth = from.getMonth();
    phase = 0;
  }

  function goToday() {
    const now = new Date();
    selStart = dayOnly(now); selEnd = dayOnly(now);
    startHH = '00'; startMM = '00'; startSS = '00';
    endHH = p2(now.getHours()); endMM = p2(now.getMinutes()); endSS = p2(now.getSeconds());
    viewYear = now.getFullYear(); viewMonth = now.getMonth();
    activePreset = ''; phase = 0;
  }

  function prevMo() { if (viewMonth === 0) { viewMonth = 11; viewYear--; } else viewMonth--; }
  function nextMo() { if (viewMonth === 11) { viewMonth = 0; viewYear++; } else viewMonth++; }

  let cells = $derived(buildCal(viewYear, viewMonth));

  function buildCal(yr, mo) {
    const firstWd    = new Date(yr, mo, 1).getDay();
    const daysInMo   = new Date(yr, mo + 1, 0).getDate();
    const daysInPrev = new Date(yr, mo, 0).getDate();
    const out = [];
    const prevMoVal  = mo === 0 ? 11 : mo - 1;
    const prevYr     = mo === 0 ? yr - 1 : yr;
    for (let i = firstWd - 1; i >= 0; i--)
      out.push({ day: daysInPrev - i, date: new Date(prevYr, prevMoVal, daysInPrev - i), cur: false });
    for (let d = 1; d <= daysInMo; d++)
      out.push({ day: d, date: new Date(yr, mo, d), cur: true });
    const nextMoVal = mo === 11 ? 0 : mo + 1;
    const nextYr    = mo === 11 ? yr + 1 : yr;
    let nx = 1;
    while (out.length < 42)
      out.push({ day: nx, date: new Date(nextYr, nextMoVal, nx++), cur: false });
    return out;
  }

  function clickDay(cell) {
    if (!cell.cur) return;
    if (phase === 0) {
      selStart = cell.date; selEnd = null;
      startHH = '00'; startMM = '00'; startSS = '00';
      phase = 1; activePreset = '';
    } else {
      let s = selStart, e = cell.date;
      if (e < s) { [s, e] = [e, s]; }
      selStart = s; selEnd = e;
      endHH = '23'; endMM = '59'; endSS = '59';
      phase = 0;
    }
  }

  function cellCls(cell) {
    if (!cell.cur) return 'other';
    const t   = cell.date.getTime();
    const tod = dayOnly(new Date()).getTime();
    const s   = selStart ? selStart.getTime() : null;
    const rawE = selEnd ?? (phase === 1 && hoverDay ? hoverDay : null);
    const e   = rawE ? rawE.getTime() : null;
    const lo  = s !== null && e !== null ? Math.min(s, e) : null;
    const hi  = s !== null && e !== null ? Math.max(s, e) : null;
    let cls = '';
    if (t === tod) cls += ' today';
    if (s !== null && t === s) cls += ' sel-s';
    if (e !== null && t === e) cls += ' sel-e';
    if (lo !== null && hi !== null && t > lo && t < hi) cls += ' in-rng';
    return cls.trim();
  }

  // ---- apply / copy -------------------------------------------------------

  function buildIso(d, hh, mm, ss) {
    const r = new Date(d);
    r.setHours(Number(hh) || 0, Number(mm) || 0, Number(ss) || 0, 0);
    return r.toISOString();
  }

  function doApply() {
    if (!selStart) return;
    const end   = selEnd ?? selStart;
    const since = buildIso(selStart, startHH, startMM, startSS);
    const until  = buildIso(end,      endHH,   endMM,   endSS);
    triggerLabel = activePreset || fmtLabel(since, until);
    onApply?.({ since, until });
    open = false;
  }

  function fmtLabel(s, u) {
    const fmt = d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(s)} – ${fmt(u)}`;
  }

  async function copyRange() {
    if (!selStart) return;
    const end   = selEnd ?? selStart;
    const since = buildIso(selStart, startHH, startMM, startSS);
    const until  = buildIso(end,      endHH,   endMM,   endSS);
    await navigator.clipboard.writeText(`${since} / ${until}`).catch(() => {});
  }

  // ---- fixed-position dropdown (escapes sidebar overflow clip) -----------
  let triggerEl = $state(null);
  let dropStyle = $state('');

  function openToggle() {
    if (!open && triggerEl) {
      const r = triggerEl.getBoundingClientRect();
      // prefer opening to the right of the sidebar; clamp so it doesn't leave viewport
      const left = Math.min(r.left, window.innerWidth - 544);
      dropStyle = `top:${r.bottom + 6}px;left:${left}px`;
    }
    open = !open;
  }

  // ---- close on outside click ---------------------------------------------
  $effect(() => {
    function onDown(e) {
      if (!open) return;
      const drop = document.querySelector('.trp-drop');
      if (triggerEl && !triggerEl.contains(e.target) && drop && !drop.contains(e.target))
        open = false;
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  });
</script>

<div class="trp" bind:this={container}>
  <!-- Trigger button -->
  <button class="trigger" bind:this={triggerEl} onclick={openToggle}>
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2" stroke-linecap="round"/>
    </svg>
    {triggerLabel}
    <svg class="caret" width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true">
      <path d="M0 0.5L5 5.5L10 0.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
    </svg>
  </button>

  {#if open}
    <div class="dropdown trp-drop" role="dialog" aria-label="Time range picker" style={dropStyle}>
      <!-- Left: presets -->
      <div class="presets-pane">
        {#each PRESETS as p}
          <button
            class="preset-item {activePreset === p.label ? 'active' : ''}"
            onclick={() => setPreset(p)}
          >{p.label}</button>
        {/each}
      </div>

      <!-- Right: times + calendar -->
      <div class="cal-pane">
        <!-- Two time inputs -->
        <div class="time-row">
          <div class="time-box">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2" stroke-linecap="round"/>
            </svg>
            <input class="tnum" type="number" min="0" max="23" bind:value={startHH} />
            <span class="sep">:</span>
            <input class="tnum" type="number" min="0" max="59" bind:value={startMM} />
            <span class="sep">:</span>
            <input class="tnum" type="number" min="0" max="59" bind:value={startSS} />
          </div>
          <div class="time-box">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2" stroke-linecap="round"/>
            </svg>
            <input class="tnum" type="number" min="0" max="23" bind:value={endHH} />
            <span class="sep">:</span>
            <input class="tnum" type="number" min="0" max="59" bind:value={endMM} />
            <span class="sep">:</span>
            <input class="tnum" type="number" min="0" max="59" bind:value={endSS} />
          </div>
        </div>

        <!-- Month navigation -->
        <div class="month-nav">
          <button class="nav-btn" onclick={prevMo} aria-label="Previous month">&#8249;</button>
          <span class="month-lbl">{MO[viewMonth]} {viewYear}</span>
          <button class="nav-btn" onclick={nextMo} aria-label="Next month">&#8250;</button>
        </div>

        <!-- Calendar grid -->
        <div class="day-grid" role="grid" aria-label="Calendar">
          {#each DH as d}
            <div class="day-hdr" role="columnheader">{d}</div>
          {/each}
          {#each cells as cell}
            <button
              class="day-cell {cellCls(cell)}"
              onclick={() => clickDay(cell)}
              onmouseenter={() => { if (cell.cur) hoverDay = cell.date; }}
              onmouseleave={() => { hoverDay = null; }}
              tabindex={cell.cur ? 0 : -1}
              aria-label="{MO[cell.date.getMonth()]} {cell.day}, {cell.date.getFullYear()}"
            >{cell.day}</button>
          {/each}
        </div>

        <!-- Footer actions -->
        <div class="cal-footer">
          <button class="foot-btn" onclick={copyRange}>Copy range</button>
          <button class="foot-btn" onclick={goToday}>Today</button>
          <button class="foot-btn apply" onclick={doApply} disabled={!selStart}>Apply</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .trp { position: relative; display: inline-block; }

  /* ---- trigger ---- */
  .trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  .trigger:hover { border-color: var(--accent); }
  .caret { opacity: 0.45; }

  /* ---- dropdown shell ---- */
  .dropdown {
    position: fixed;
    z-index: 300;
    display: flex;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0,0,0,.2);
    overflow: hidden;
  }

  /* ---- preset pane ---- */
  .presets-pane {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    border-right: 1px solid var(--border);
    min-width: 158px;
  }
  .preset-item {
    padding: 7px 16px;
    text-align: left;
    background: none;
    border: none;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  .preset-item:hover   { background: var(--panel-alt); }
  .preset-item.active  { background: var(--panel-alt); font-weight: 600; color: var(--accent); }

  /* ---- calendar pane ---- */
  .cal-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    min-width: 260px;
  }

  /* time boxes */
  .time-row { display: flex; gap: 8px; }
  .time-box {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 1;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel-alt);
  }
  .time-box svg { opacity: 0.45; flex-shrink: 0; }
  .sep { opacity: 0.35; user-select: none; }
  .tnum {
    width: 26px;
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: center;
    -moz-appearance: textfield;
  }
  .tnum::-webkit-inner-spin-button,
  .tnum::-webkit-outer-spin-button { display: none; }
  .tnum:focus { outline: none; background: color-mix(in srgb, var(--accent) 10%, transparent); border-radius: 2px; }

  /* month nav */
  .month-nav { display: flex; align-items: center; justify-content: space-between; }
  .month-lbl { font-size: 13px; font-weight: 600; }
  .nav-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 7px;
    cursor: pointer;
    font-size: 17px;
    line-height: 1.4;
    color: var(--text);
  }
  .nav-btn:hover { background: var(--panel-alt); }

  /* day grid */
  .day-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }
  .day-hdr {
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    padding: 1px 0 5px;
  }
  .day-cell {
    text-align: center;
    font-size: 12.5px;
    padding: 5px 2px;
    border: none;
    border-radius: 4px;
    background: none;
    cursor: pointer;
    color: var(--text);
    line-height: 1;
    transition: background 0.07s;
  }
  .day-cell.other         { color: var(--muted); opacity: 0.35; pointer-events: none; }
  .day-cell.today         { font-weight: 700; color: var(--accent); }
  .day-cell:hover:not(.other) { background: var(--panel-alt); }

  .day-cell.sel-s,
  .day-cell.sel-e         { background: var(--accent); color: #fff; border-radius: 4px; }
  .day-cell.sel-s.sel-e   { border-radius: 4px; }

  .day-cell.in-rng {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-radius: 0;
  }

  /* footer */
  .cal-footer {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    border-top: 1px solid var(--border);
    padding-top: 10px;
    margin-top: 2px;
  }
  .foot-btn {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    color: var(--text);
    font-size: 12.5px;
    cursor: pointer;
  }
  .foot-btn:hover { background: var(--panel-alt); }
  .foot-btn.apply {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .foot-btn.apply:hover    { opacity: 0.88; }
  .foot-btn.apply:disabled { opacity: 0.45; cursor: default; }
</style>
