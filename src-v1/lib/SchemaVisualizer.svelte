<script>
  import { getSchema } from './api.js';
  import {
    DEMO_SCHEMA,
    inferRelationships,
    primaryKeyOf,
    tableDDL,
    gridLayout,
    columnAnchorY,
    nodeHeight,
    NODE_WIDTH,
  } from './schema.js';
  import { isVectorType } from './format.js';
  import ErrorBox from './ErrorBox.svelte';

  // App already fetched + filtered the catalog; reuse it as the fallback source
  // for inferred relationships so we don't re-fetch /tables here.
  let { tables = [] } = $props();

  let loading = $state(true);
  let error = $state(null);
  // { tables, relationships, source: 'server' | 'inferred' | 'demo' }
  let schema = $state({ tables: [], relationships: [], source: 'server' });

  let positions = $state({}); // { [tableName]: { x, y } }
  let zoom = $state(1);
  let pan = $state({ x: 0, y: 0 });

  // Kebab (⋮) menu + DDL modal. Menu is positioned in screen coords (fixed) so
  // the canvas transform/zoom doesn't distort it.
  let menu = $state(null); // { table, x, y }
  let ddlView = $state(null); // { table, sql }
  let copied = $state(false);
  let modalEl = $state(null); // DDL modal element, for focus on open

  async function load() {
    loading = true;
    error = null;
    try {
      const s = await getSchema();
      if (s.supported) {
        schema = { tables: s.tables, relationships: s.relationships, source: 'server' };
      } else if (tables.length) {
        schema = { tables, relationships: inferRelationships(tables), source: 'inferred' };
      } else {
        schema = { tables: DEMO_SCHEMA.tables, relationships: DEMO_SCHEMA.relationships, source: 'demo' };
      }
      positions = gridLayout(schema.tables);
      pan = { x: 0, y: 0 };
      zoom = 1;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    tables; // re-run when App reloads the catalog
    load();
  });

  const tableByName = $derived(new Map(schema.tables.map((t) => [t.name, t])));
  const pkByTable = $derived(new Map(schema.tables.map((t) => [t.name, primaryKeyOf(t)])));
  // "table.column" keys that are the source side of a relationship (FK badges).
  const fkCols = $derived(
    new Set(schema.relationships.flatMap((r) => r.fromColumns.map((c) => `${r.fromTable}.${c}`))),
  );

  const edges = $derived.by(() => {
    const out = [];
    for (const r of schema.relationships) {
      const from = tableByName.get(r.fromTable);
      const to = tableByName.get(r.toTable);
      const pf = positions[r.fromTable];
      const pt = positions[r.toTable];
      if (!from || !to || !pf || !pt) continue;

      const fy = pf.y + columnAnchorY(from, r.fromColumns[0]);
      const ty = pt.y + columnAnchorY(to, r.toColumns[0]);
      const fromLeft = pf.x + NODE_WIDTH / 2 <= pt.x + NODE_WIDTH / 2;
      const fx = fromLeft ? pf.x + NODE_WIDTH : pf.x;
      const tx = fromLeft ? pt.x : pt.x + NODE_WIDTH;
      const d = Math.max(40, Math.abs(tx - fx) / 2);
      const c1 = fromLeft ? fx + d : fx - d;
      const c2 = fromLeft ? tx - d : tx + d;
      out.push({
        key: r.name,
        path: `M ${fx} ${fy} C ${c1} ${fy}, ${c2} ${ty}, ${tx} ${ty}`,
        fx, fy, tx, ty,
        inferred: !!r.inferred,
      });
    }
    return out;
  });

  // Canvas content size (so the scroll area encompasses every node + edges).
  const bounds = $derived.by(() => {
    let w = 800, h = 500;
    for (const t of schema.tables) {
      const p = positions[t.name];
      if (!p) continue;
      w = Math.max(w, p.x + NODE_WIDTH + 80);
      h = Math.max(h, p.y + nodeHeight(t) + 80);
    }
    return { w, h };
  });

  // ---- drag (nodes) + pan (background) --------------------------------------
  let dragState = null;

  function onMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (dragState.type === 'node') {
      positions = {
        ...positions,
        [dragState.name]: { x: dragState.ox + dx / zoom, y: dragState.oy + dy / zoom },
      };
    } else {
      pan = { x: dragState.ox + dx, y: dragState.oy + dy };
    }
  }
  function onUp() {
    dragState = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }
  function beginDrag(state) {
    dragState = state;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function onNodeDown(e, name) {
    e.stopPropagation();
    const p = positions[name];
    beginDrag({ type: 'node', name, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y });
  }
  function onBgDown(e) {
    beginDrag({ type: 'pan', startX: e.clientX, startY: e.clientY, ox: pan.x, oy: pan.y });
  }
  function onWheel(e) {
    e.preventDefault();
    zoom = Math.min(2, Math.max(0.3, zoom - e.deltaY * 0.0015));
  }

  function zoomBy(f) {
    zoom = Math.min(2, Math.max(0.3, zoom * f));
  }
  function resetView() {
    positions = gridLayout(schema.tables);
    pan = { x: 0, y: 0 };
    zoom = 1;
  }

  // ---- kebab menu + DDL --------------------------------------------------
  // A table's DDL is always reconstructed from catalog metadata — the engine
  // stores no CREATE text (the `table.ddl` guard is vestigial; no source sets it).
  function ddlFor(table) {
    return table.ddl ?? tableDDL(table);
  }
  function toggleMenu(e, table) {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    menu = menu?.table === table.name ? null : { table: table.name, x: r.right, y: r.bottom + 4 };
  }
  function openDdl(name) {
    const t = tableByName.get(name);
    if (t) ddlView = { table: name, sql: ddlFor(t) };
    menu = null;
    copied = false;
  }
  async function copyDdl(sql) {
    try {
      await navigator.clipboard.writeText(sql);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
  function closeMenus() {
    menu = null;
  }

  // Esc closes whichever overlay is open (kebab menu or DDL modal). Only
  // listens while one is open, and is torn down when both close.
  $effect(() => {
    if (!menu && !ddlView) return;
    function onKey(e) {
      if (e.key === 'Escape') {
        menu = null;
        ddlView = null;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Move focus into the DDL modal when it opens (so Esc/Tab act on it).
  $effect(() => {
    if (ddlView && modalEl) modalEl.focus();
  });

  const banner = $derived(
    schema.source === 'demo'
      ? 'Demo schema — the server reported no tables. This is illustrative sample data.'
      : schema.source === 'inferred'
        ? 'Relationships inferred from column names (e.g. user_id → users.id) — the engine catalog (information_schema) isn’t available on this server. Real foreign keys replace these once it is.'
        : null,
  );
</script>

<div class="viz">
  <div class="toolbar">
    <div class="left">
      <strong>Schema</strong>
      <span class="muted">{schema.tables.length} tables · {schema.relationships.length} relationships</span>
      <span class="src src-{schema.source}">{schema.source}</span>
    </div>
    <div class="right">
      <button class="ctl" title="Zoom out" onclick={() => zoomBy(1 / 1.2)}>−</button>
      <span class="zoom">{Math.round(zoom * 100)}%</span>
      <button class="ctl" title="Zoom in" onclick={() => zoomBy(1.2)}>+</button>
      <button class="ctl" title="Reset layout" onclick={resetView}>Reset</button>
      <button class="ctl" title="Reload schema" onclick={load} disabled={loading}>↻</button>
    </div>
  </div>

  {#if banner}
    <p class="notice">{banner}</p>
  {/if}

  {#if loading}
    <p class="muted pad">Loading schema…</p>
  {:else if error}
    <div class="pad"><ErrorBox {error} /></div>
  {:else if schema.tables.length === 0}
    <p class="muted pad">No tables to visualize.</p>
  {:else}
    <div class="stage" onwheel={onWheel}>
      <div
        class="pan"
        role="presentation"
        onpointerdown={onBgDown}
        style="transform: translate({pan.x}px, {pan.y}px) scale({zoom});"
      >
        <div class="canvas" style="width:{bounds.w}px; height:{bounds.h}px;">
          <svg width={bounds.w} height={bounds.h} class="edges">
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
              </marker>
            </defs>
            {#each edges as e (e.key)}
              <path d={e.path} class="edge" class:inferred={e.inferred} marker-end="url(#arrow)" />
              <circle cx={e.fx} cy={e.fy} r="3" class="dot" />
            {/each}
          </svg>

          {#each schema.tables as t (t.name)}
            {@const p = positions[t.name]}
            <div
              class="node"
              role="presentation"
              onpointerdown={(e) => onNodeDown(e, t.name)}
              style="left:{p.x}px; top:{p.y}px; width:{NODE_WIDTH}px;"
            >
              <div class="node-head">
                <span class="tname">{t.name}</span>
                <span class="head-right">
                  <span class="ccount">{t.columns?.length ?? 0}</span>
                  <button
                    class="kebab"
                    title="Table actions"
                    aria-label="Table actions for {t.name}"
                    onpointerdown={(e) => e.stopPropagation()}
                    onclick={(e) => toggleMenu(e, t)}
                  >⋮</button>
                </span>
              </div>
              <div class="rows">
                {#each t.columns ?? [] as c}
                  {@const isPk = pkByTable.get(t.name) === c.name}
                  {@const isFk = fkCols.has(`${t.name}.${c.name}`)}
                  {@const isVec = isVectorType(c.type)}
                  {@const isAnn = c.index === 'hnsw'}
                  <div class="row" class:key={isPk || isFk}>
                    <span class="badge-slot">
                      {#if isPk}<span class="pk" title="primary key">PK</span>{/if}
                      {#if isFk}<span class="fk" title="foreign key">FK</span>{/if}
                      {#if isVec}<span class="vec" title="vector column">VEC</span>{/if}
                      {#if isAnn}<span class="ann" title="ANN (HNSW) index">ANN</span>{/if}
                    </span>
                    <span class="cname">{c.name}</span>
                    <span class="ctype">{c.type ?? ''}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if menu}
    <!-- click-away backdrop, then the fixed-position dropdown -->
    <div class="backdrop" role="presentation" onpointerdown={closeMenus}></div>
    <div class="menu" style="left:{menu.x}px; top:{menu.y}px;">
      <button onclick={() => openDdl(menu.table)}>View DDL</button>
      <button onclick={() => { const t = tableByName.get(menu.table); if (t) copyDdl(ddlFor(t)); menu = null; }}>
        Copy DDL
      </button>
    </div>
  {/if}

  {#if ddlView}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (ddlView = null)}>
      <div
        class="modal"
        role="dialog"
        aria-label="DDL for {ddlView.table}"
        tabindex="-1"
        bind:this={modalEl}
        onpointerdown={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          <strong>{ddlView.table}</strong>
          <div class="modal-actions">
            <button class="ctl" onclick={() => copyDdl(ddlView.sql)}>{copied ? 'Copied ✓' : 'Copy'}</button>
            <button class="ctl" onclick={() => (ddlView = null)}>Close</button>
          </div>
        </div>
        <pre class="ddl">{ddlView.sql}</pre>
        <p class="ddl-note">
          Reconstructed from catalog metadata — canonical, not the original CREATE text (unidb stores no DDL).
        </p>
      </div>
    </div>
  {/if}
</div>

<style>
  .viz {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .left {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .left strong {
    font-size: 15px;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .src {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 8px;
    font-weight: 700;
  }
  .src-server {
    background: rgba(37, 99, 235, 0.15);
    color: var(--accent);
  }
  .src-inferred {
    background: rgba(210, 153, 34, 0.18);
    color: #b8860b;
  }
  .src-demo {
    background: var(--panel-alt);
    color: var(--muted);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ctl {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 13px;
  }
  .ctl:disabled {
    opacity: 0.5;
  }
  .zoom {
    font-size: 12px;
    color: var(--muted);
    width: 40px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .notice {
    margin: 0 0 8px;
    padding: 7px 10px;
    font-size: 12px;
    background: rgba(210, 153, 34, 0.1);
    border: 1px solid var(--err-border);
    border-radius: 6px;
    color: var(--text);
  }
  .pad {
    padding: 8px 2px;
  }

  .stage {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background:
      radial-gradient(circle, var(--border) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--panel-alt);
    position: relative;
    cursor: grab;
  }
  .stage:active {
    cursor: grabbing;
  }
  .pan {
    transform-origin: 0 0;
    position: absolute;
    top: 0;
    left: 0;
  }
  .canvas {
    position: relative;
  }
  .edges {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }
  .edge {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.5;
  }
  .edge.inferred {
    stroke-dasharray: 5 4;
  }
  .dot {
    fill: var(--muted);
  }

  .node {
    position: absolute;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
    overflow: hidden;
    font-size: 12px;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .node:active {
    cursor: grabbing;
  }
  .node-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 10px;
    background: var(--panel-alt);
    border-bottom: 1px solid var(--border);
  }
  .tname {
    font-weight: 700;
  }
  .head-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ccount {
    font-size: 10px;
    color: var(--muted);
    background: var(--panel);
    border-radius: 8px;
    padding: 1px 6px;
  }
  .kebab {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 4px;
    cursor: pointer;
  }
  .kebab:hover {
    color: var(--text);
    background: var(--border);
  }
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child {
    border-bottom: none;
  }
  .row.key {
    background: rgba(37, 99, 235, 0.05);
  }
  .badge-slot {
    display: inline-flex;
    gap: 3px;
    width: 58px;
    flex-shrink: 0;
  }
  .pk,
  .fk,
  .vec,
  .ann {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 4px;
    line-height: 1.4;
  }
  .pk {
    background: rgba(210, 153, 34, 0.2);
    color: #b8860b;
  }
  .fk {
    background: rgba(37, 99, 235, 0.15);
    color: var(--accent);
  }
  .vec {
    background: rgba(147, 51, 234, 0.16);
    color: #9333ea;
  }
  .ann {
    background: rgba(147, 51, 234, 0.9);
    color: #fff;
  }
  .cname {
    flex: 1;
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctype {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    flex-shrink: 0;
  }

  /* kebab dropdown (fixed, above the zoom-transformed canvas) */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
  }
  .menu {
    position: fixed;
    z-index: 21;
    transform: translateX(-100%);
    min-width: 130px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    background: none;
    border: none;
    text-align: left;
    padding: 7px 10px;
    font-size: 13px;
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--panel-alt);
  }

  /* DDL modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .modal {
    width: min(640px, 100%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }
  .modal:focus {
    outline: none;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .modal-head strong {
    font-size: 14px;
    font-family: var(--mono);
  }
  .modal-actions {
    display: flex;
    gap: 6px;
  }
  .ddl {
    margin: 0;
    padding: 14px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre;
    color: var(--text);
  }
  .ddl-note {
    margin: 0;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
    background: var(--panel-alt);
  }
</style>
