<script>
  import { getRestOpenApi, restGet, BASE_URL } from './api.js';
  import ResultsGrid from './ResultsGrid.svelte';

  // API-docs panel (Workstream G4 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  // Live over engine item 123 (C1 resource routes + C3 OpenAPI doc, merged
  // via PR #223 on unidb main). Verified against src/server/rest_resource.rs
  // directly — docs/REST_API.md does not document /rest/v1 at all yet, even
  // though the route shipped (a real doc-staleness gap, not a Studio
  // workaround; flagged in the plan doc rather than guessed around).
  //
  // Two parts: (1) a schema + copy-paste curl viewer generated straight from
  // GET /rest/v1 (the engine's own OpenAPI doc — every value here is engine
  // data, never invented), and (2) a live GET explorer over
  // /rest/v1/<table> exercising the real select/filter/order/limit/offset
  // query surface, per the C1 operator allow-list
  // (eq/neq/gt/gte/lt/lte/like/ilike/in/is).

  let loading   = $state(true);
  let error     = $state(null);
  let supported = $state(true);
  let doc       = $state(null);

  let selectedTable = $state(null);

  const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'];

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const out = await getRestOpenApi();
      supported = out.supported;
      doc = out.doc;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  const tables = $derived.by(() => {
    if (!doc?.paths) return [];
    return Object.keys(doc.paths)
      .map((p) => p.replace(/^\/rest\/v1\//, ''))
      .sort();
  });

  function schemaFor(table) {
    return doc?.components?.schemas?.[table] ?? null;
  }
  function columnsFor(table) {
    const s = schemaFor(table);
    if (!s?.properties) return [];
    const required = new Set(s.required ?? []);
    // `x-primary-key` (table-level) is only populated from a table-level
    // `PRIMARY KEY (...)` constraint — verified against
    // src/server/rest_resource.rs::get_openapi on unidb main, it reads only
    // `def.constraints.primary_key`, not a column-level `PRIMARY KEY` marker
    // (e.g. `CREATE TABLE t (id BIGINT PRIMARY KEY, ...)`), so it misses that
    // common case. Each *column's* own `description: "primary key"` is set
    // from the column-level marker correctly, so union both signals rather
    // than trusting `x-primary-key` alone — otherwise a single-column PK
    // declared inline silently fails to highlight and the snippet builder
    // below picks the wrong "non-PK" example column.
    const pk = new Set(s['x-primary-key'] ?? []);
    return Object.entries(s.properties).map(([name, prop]) => ({
      name,
      type: prop.type ?? (prop.$ref ? 'object' : 'any'),
      format: prop.format ?? null,
      required: required.has(name),
      primaryKey: pk.has(name) || prop.description === 'primary key',
      description: prop.description ?? null,
    }));
  }

  function exampleValue(col) {
    if (col.type === 'integer') return 1;
    if (col.type === 'number') return 1.5;
    if (col.type === 'boolean') return true;
    if (col.type === 'array') return [];
    if (col.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
    if (col.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (col.format === 'date') return '2026-01-01';
    return 'example';
  }

  function selectTable(t) {
    selectedTable = t;
    resetExplorer();
  }

  // ── snippet builders ──────────────────────────────────────────────────────
  function snippetList(table) {
    return `curl -s "${BASE_URL}/rest/v1/${table}?limit=10" \\\n  -H "Authorization: Bearer $TOKEN"`;
  }
  function snippetFiltered(table) {
    const cols = columnsFor(table);
    const pk = cols.find((c) => c.primaryKey) ?? cols[0];
    if (!pk) return snippetList(table);
    return `curl -s "${BASE_URL}/rest/v1/${table}?${pk.name}=eq.${exampleValue(pk)}&select=${cols.map((c) => c.name).slice(0, 4).join(',')}" \\\n  -H "Authorization: Bearer $TOKEN"`;
  }
  function snippetInsert(table) {
    const cols = columnsFor(table).filter((c) => !c.primaryKey);
    const body = Object.fromEntries(cols.slice(0, 3).map((c) => [c.name, exampleValue(c)]));
    return `curl -s -X POST "${BASE_URL}/rest/v1/${table}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
  }
  function snippetUpdate(table) {
    const cols = columnsFor(table);
    const pk = cols.find((c) => c.primaryKey) ?? cols[0];
    const target = cols.find((c) => !c.primaryKey) ?? cols[0];
    if (!pk || !target) return '';
    const body = { [target.name]: exampleValue(target) };
    return `curl -s -X PATCH "${BASE_URL}/rest/v1/${table}?${pk.name}=eq.${exampleValue(pk)}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
  }
  function snippetDelete(table) {
    const cols = columnsFor(table);
    const pk = cols.find((c) => c.primaryKey) ?? cols[0];
    if (!pk) return '';
    return `curl -s -X DELETE "${BASE_URL}/rest/v1/${table}?${pk.name}=eq.${exampleValue(pk)}" \\\n  -H "Authorization: Bearer $TOKEN"`;
  }

  let copiedSnippet = $state(null);
  async function copySnippet(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      copiedSnippet = key;
      setTimeout(() => { if (copiedSnippet === key) copiedSnippet = null; }, 1500);
    } catch { /* clipboard unavailable */ }
  }

  // ── GET explorer ───────────────────────────────────────────────────────────
  let explorerOpen = $state(false);
  let selectCols   = $state('');
  let filters      = $state([]); // [{column, op, value}]
  let orderRows    = $state([]); // [{column, desc}]
  let limit        = $state(50);
  let offset       = $state(0);
  let explorerBusy   = $state(false);
  let explorerError  = $state(null);
  let explorerResult = $state(null); // {type,columns,rows}
  let explorerUrl    = $state(null);
  let explorerMs      = $state(null);

  function resetExplorer() {
    explorerOpen = false;
    selectCols = '';
    filters = [];
    orderRows = [];
    limit = 50;
    offset = 0;
    explorerBusy = false;
    explorerError = null;
    explorerResult = null;
    explorerUrl = null;
    explorerMs = null;
  }

  function addFilter() {
    const cols = columnsFor(selectedTable);
    filters = [...filters, { column: cols[0]?.name ?? '', op: 'eq', value: '' }];
  }
  function removeFilter(i) {
    filters = filters.filter((_, idx) => idx !== i);
  }
  function onOpChange(i, op) {
    filters = filters.map((f, idx) => (idx === i ? { ...f, op, value: op === 'is' ? 'null' : '' } : f));
  }

  function addOrder() {
    const cols = columnsFor(selectedTable);
    orderRows = [...orderRows, { column: cols[0]?.name ?? '', desc: false }];
  }
  function removeOrder(i) {
    orderRows = orderRows.filter((_, idx) => idx !== i);
  }

  function opValueSegment(f) {
    if (f.op === 'in') return `(${f.value})`;
    return f.value;
  }

  async function runExplorer() {
    explorerBusy = true;
    explorerError = null;
    explorerResult = null;
    try {
      const filterParams = filters
        .filter((f) => f.column && f.op)
        .map((f) => [f.column, `${f.op}.${opValueSegment(f)}`]);
      const order = orderRows
        .filter((o) => o.column)
        .map((o) => `${o.column}.${o.desc ? 'desc' : 'asc'}`)
        .join(',');
      const out = await restGet(selectedTable, {
        select: selectCols.trim() || undefined,
        filterParams,
        order: order || undefined,
        limit,
        offset,
      });
      explorerResult = out.result;
      explorerUrl = out.url;
      explorerMs = out.roundTripMs;
    } catch (e) {
      explorerError = e.message ?? String(e);
    } finally {
      explorerBusy = false;
    }
  }
</script>

<div class="apidocs">
  {#if error}
    <div class="unsupported">
      <h3>Couldn't load the API docs</h3>
      <p class="err">{error.code}: {error.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>
      </svg>
      <h3>API docs not available</h3>
      <p>This server doesn't expose <code>GET /rest/v1</code> yet (needs item-123 auto REST API support).</p>
    </div>
  {:else}
    <div class="layout">
      <!-- ── table sidebar ── -->
      <aside class="asidebar">
        <div class="sidebar-head">
          <span class="sidebar-title">Tables</span>
        </div>
        {#if loading}
          <p class="muted small">Loading…</p>
        {:else if tables.length === 0}
          <p class="muted small">No tables yet.</p>
        {:else}
          <ul class="entity-list">
            {#each tables as t}
              <li class:active={selectedTable === t}>
                <button class="entity-btn" onclick={() => selectTable(t)}>{t}</button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <!-- ── detail ── -->
      <div class="detail">
        {#if !selectedTable}
          <div class="empty-state">
            <p>Select a table to see its schema, request snippets, and a live query explorer —
              all generated from <code>GET /rest/v1</code>, the engine's own OpenAPI document.</p>
          </div>
        {:else}
          {@const cols = columnsFor(selectedTable)}
          <h2 class="table-title">{selectedTable}</h2>

          <section class="block">
            <h4>Schema</h4>
            <table class="schema-table">
              <thead>
                <tr><th>Column</th><th>Type</th><th>Required</th><th></th></tr>
              </thead>
              <tbody>
                {#each cols as c}
                  <tr>
                    <td class="mono">{c.name}</td>
                    <td class="mono">{c.type}{c.format ? `(${c.format})` : ''}</td>
                    <td>{c.required ? 'yes' : 'no'}</td>
                    <td>
                      {#if c.primaryKey}<span class="pill pk">PK</span>{/if}
                      {#if c.description && !c.primaryKey}<span class="desc">{c.description}</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>

          <section class="block">
            <h4>Request snippets</h4>
            <p class="hint">Set <code>$TOKEN</code> to a valid bearer token first — every
              <code>/rest/v1</code> route requires one, same as <code>/sql</code>.</p>
            {#each [
              ['List (first 10)', 'list', snippetList(selectedTable)],
              ['Filtered + column projection', 'filtered', snippetFiltered(selectedTable)],
              ['Insert', 'insert', snippetInsert(selectedTable)],
              ['Update (by primary key)', 'update', snippetUpdate(selectedTable)],
              ['Delete (by primary key)', 'delete', snippetDelete(selectedTable)],
            ] as [label, key, code]}
              {#if code}
                <div class="snippet">
                  <div class="snippet-head">
                    <span class="snippet-label">{label}</span>
                    <button class="copy-btn" onclick={() => copySnippet(key, code)}>
                      {copiedSnippet === key ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre class="snippet-code">{code}</pre>
                </div>
              {/if}
            {/each}
          </section>

          <section class="block">
            <div class="explorer-head">
              <h4>Try it — GET explorer</h4>
              <button class="ghost" onclick={() => (explorerOpen = !explorerOpen)}>
                {explorerOpen ? 'Hide' : 'Open'}
              </button>
            </div>
            {#if explorerOpen}
              <div class="explorer">
                <label class="field">
                  <span class="flabel">select (comma-separated columns, blank = *)</span>
                  <input bind:value={selectCols} placeholder={cols.map((c) => c.name).join(',')} class="mono-input" />
                </label>

                <div class="field">
                  <span class="flabel">Filters</span>
                  {#each filters as f, i}
                    <div class="filter-row">
                      <select bind:value={f.column}>
                        {#each cols as c}<option value={c.name}>{c.name}</option>{/each}
                      </select>
                      <select value={f.op} onchange={(e) => onOpChange(i, e.target.value)}>
                        {#each FILTER_OPS as op}<option value={op}>{op}</option>{/each}
                      </select>
                      {#if f.op === 'is'}
                        <select bind:value={f.value}>
                          <option value="null">null</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      {:else}
                        <input bind:value={f.value} placeholder={f.op === 'in' ? '1,2,3' : 'value'} class="mono-input" />
                      {/if}
                      <button class="del-btn" onclick={() => removeFilter(i)}>✕</button>
                    </div>
                  {/each}
                  <button class="ghost small-btn" onclick={addFilter}>+ Add filter</button>
                </div>

                <div class="field">
                  <span class="flabel">Order</span>
                  {#each orderRows as o, i}
                    <div class="filter-row">
                      <select bind:value={o.column}>
                        {#each cols as c}<option value={c.name}>{c.name}</option>{/each}
                      </select>
                      <select bind:value={o.desc}>
                        <option value={false}>asc</option>
                        <option value={true}>desc</option>
                      </select>
                      <button class="del-btn" onclick={() => removeOrder(i)}>✕</button>
                    </div>
                  {/each}
                  <button class="ghost small-btn" onclick={addOrder}>+ Add order</button>
                </div>

                <div class="limit-row">
                  <label class="field">
                    <span class="flabel">limit</span>
                    <input type="number" min="0" bind:value={limit} class="num-input" />
                  </label>
                  <label class="field">
                    <span class="flabel">offset</span>
                    <input type="number" min="0" bind:value={offset} class="num-input" />
                  </label>
                  <button onclick={runExplorer} disabled={explorerBusy}>{explorerBusy ? 'Running…' : 'Run'}</button>
                </div>

                {#if explorerUrl}<p class="explorer-url mono">{explorerUrl}{explorerMs != null ? ` · ${Math.round(explorerMs)} ms` : ''}</p>{/if}
                {#if explorerError}<p class="err">{explorerError}</p>{/if}
                {#if explorerResult}
                  <div class="explorer-result">
                    <ResultsGrid result={explorerResult} />
                  </div>
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .apidocs { display: flex; flex-direction: column; height: 100%; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .layout { display: flex; height: 100%; min-height: 0; }

  .asidebar {
    width: 220px; flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    background: var(--panel-alt);
    overflow-y: auto;
  }
  .sidebar-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--border); }
  .sidebar-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--muted);
  }
  .entity-list { list-style: none; margin: 0; padding: 4px 0; }
  .entity-list li { padding: 0 6px; border-radius: 6px; margin: 1px 4px; }
  .entity-list li.active { background: var(--accent); }
  .entity-list li.active .entity-btn { color: #fff; }
  .entity-btn {
    width: 100%; display: block; background: none; border: none; padding: 7px 4px; cursor: pointer;
    color: var(--text); font-size: 13px; text-align: left; font-family: var(--mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 18px; }
  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--muted); font-size: 13px; text-align: center; padding: 40px; max-width: 480px; margin: 0 auto;
  }
  .table-title { margin: 0; font-size: 18px; font-family: var(--mono); }

  .block h4 {
    margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--muted);
  }

  .schema-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .schema-table th, .schema-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .schema-table th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .schema-table tr:last-child td { border-bottom: none; }
  .pill.pk {
    font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 4px; padding: 1px 6px;
  }
  .desc { font-size: 11px; color: var(--muted); }

  .hint { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }

  .snippet { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
  .snippet-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 10px; background: var(--panel-alt); border-bottom: 1px solid var(--border);
  }
  .snippet-label { font-size: 11px; font-weight: 600; color: var(--muted); }
  .copy-btn {
    background: none; border: 1px solid var(--border); border-radius: 5px;
    color: var(--muted); font-size: 11px; padding: 2px 8px; cursor: pointer;
  }
  .copy-btn:hover { color: var(--text); border-color: var(--accent); }
  .snippet-code {
    margin: 0; padding: 10px; font-family: var(--mono); font-size: 12px;
    white-space: pre-wrap; word-break: break-all; background: var(--panel);
  }

  .explorer-head { display: flex; align-items: center; justify-content: space-between; }
  .explorer-head h4 { margin: 0; }
  .explorer { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; max-width: 700px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input, .field select {
    padding: 6px 9px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .mono-input { font-family: var(--mono); }
  .num-input { width: 90px; }
  .filter-row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .filter-row select, .filter-row input {
    padding: 5px 8px; font-size: 12px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .limit-row { display: flex; gap: 12px; align-items: flex-end; }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer; align-self: flex-start;
  }
  .small-btn { padding: 4px 10px; font-size: 12px; }
  .limit-row button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }

  .explorer-url { font-size: 11px; color: var(--muted); word-break: break-all; margin: 0; }
  .explorer-result { border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 360px; }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .mono { font-family: var(--mono); }
  .err { color: var(--err-fg); }
</style>
