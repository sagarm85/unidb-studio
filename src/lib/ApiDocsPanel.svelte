<script>
  import { getRestOpenApi, restRequest, BASE_URL } from './api.js';
  import ResultsGrid from './ResultsGrid.svelte';

  // API-docs panel (Workstream G4 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  // Live over engine item 123 (C1 resource routes + C3 OpenAPI doc, merged
  // via PR #223; C2 embedded-resource expansion merged via PR #227; item
  // 136 per-embed filter/order/limit/offset via PR #239; item 139 Prefer
  // count=exact / return=representation|minimal via PR #242) on unidb main.
  // Verified against src/server/rest_resource.rs directly — docs/REST_API.md
  // initially didn't document /rest/v1 at all despite the route shipping;
  // that gap has since been fixed upstream, so this panel is built against
  // the documented contract now.
  //
  // Three parts: (1) a schema + copy-paste curl viewer generated straight
  // from GET /rest/v1 (the engine's own OpenAPI doc — every value here is
  // engine data, never invented), (2) embedded-resource (C2) support layered
  // on top — forward/reverse FK embed options derived from the SAME real
  // catalog FK metadata the Schema tab's ERD uses (`relationships` prop,
  // owned by App.svelte's getSchema()), not guessed or hardcoded, now
  // including per-embed filter/order/limit/offset (item 136) — and (3) a
  // live GET/POST/PATCH/DELETE explorer over /rest/v1/<table> exercising the
  // real select/filter/order/limit/offset query surface (C1 operator
  // allow-list eq/neq/gt/gte/lt/lte/like/ilike/in/is) plus the item-139
  // `Prefer` response controls: `count=exact` on GET (reports the real,
  // RLS-scoped total via `Content-Range`) and `return=representation|
  // minimal` on a mutation.

  let { relationships = [] } = $props();

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

  // ── C2: embedded resource expansion ─────────────────────────────────────
  // Derives embeddable relation names from REAL foreign-key metadata
  // (`relationships`, the same catalog data the Schema ERD renders — see
  // App.svelte's getSchema()), per REST_API.md's C2 rules: forward
  // (many-to-one) embeds the referenced table under its own name; reverse
  // (one-to-many) embeds the child table under its own name. Composite
  // (multi-column) FKs are out of C2's v1 scope, so those relationships are
  // skipped here too. When two forward FKs on the same base table target
  // the same table, the bare table-name alias is ambiguous (`400
  // AMBIGUOUS_RELATIONSHIP` per the contract) — fall back to the FK
  // column's own name (or that column with a trailing `_id` stripped),
  // exactly the alternate form C2 documents.
  function embedOptionsFor(table) {
    const forward = relationships.filter((r) => r.fromTable === table && r.fromColumns.length === 1);
    const reverse = relationships.filter((r) => r.toTable === table && r.toColumns.length === 1);
    const opts = [];
    for (const r of forward) {
      const collides = forward.filter((r2) => r2.toTable === r.toTable).length > 1;
      const col = r.fromColumns[0];
      const name = collides ? (col.endsWith('_id') ? col.slice(0, -3) : col) : r.toTable;
      opts.push({ name, kind: 'forward', relTable: r.toTable });
    }
    for (const r of reverse) {
      opts.push({ name: r.fromTable, kind: 'reverse', relTable: r.fromTable });
    }
    return opts;
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
  // C2 — embedded resource expansion. Both the base table's and the embedded
  // table's column names below are real (pulled from GET /rest/v1's own
  // schema for each), never invented.
  function snippetEmbed(table) {
    const opt = embedOptionsFor(table)[0];
    if (!opt) return null;
    const baseCols = columnsFor(table).slice(0, 2).map((c) => c.name);
    const embedCols = columnsFor(opt.relTable).slice(0, 2).map((c) => c.name);
    const select = `${baseCols.join(',')},${opt.name}(${embedCols.join(',')})`;
    return `curl -s "${BASE_URL}/rest/v1/${table}?select=${select}&limit=10" \\\n  -H "Authorization: Bearer $TOKEN"`;
  }

  let copiedSnippet = $state(null);
  async function copySnippet(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      copiedSnippet = key;
      setTimeout(() => { if (copiedSnippet === key) copiedSnippet = null; }, 1500);
    } catch { /* clipboard unavailable */ }
  }

  // ── explorer (GET/POST/PATCH/DELETE) ────────────────────────────────────────
  let explorerOpen = $state(false);
  let method       = $state('GET'); // 'GET' | 'POST' | 'PATCH' | 'DELETE'
  let selectCols   = $state('');
  let filters      = $state([]); // [{column, op, value}]
  let orderRows    = $state([]); // [{column, desc}]
  // C2 embeds, each with its own item-136 per-embed filter/order/limit/offset:
  // [{name, cols, filters:[{column,op,value}], order:[{column,desc}], limitVal, offsetVal}]
  let embeds       = $state([]);
  let limit        = $state(50);
  let offset       = $state(0);
  let bodyText     = $state(''); // POST/PATCH JSON body
  let countExact   = $state(false); // Prefer: count=exact (GET only, item 139)
  let returnMode   = $state(''); // '' | 'representation' | 'minimal' (mutations only, item 139)
  let explorerBusy   = $state(false);
  let explorerError  = $state(null);
  let explorerResult = $state(null); // parsed body, shape depends on method/Prefer, or null (return=minimal)
  let explorerUrl    = $state(null);
  let explorerMs      = $state(null);
  let explorerStatus  = $state(null);
  let explorerContentRange = $state(null); // item 139: "<from>-<to>/<total>" when count=exact
  let explorerPreference   = $state(null); // item 139: echoed Preference-Applied header

  function resetExplorer() {
    explorerOpen = false;
    method = 'GET';
    selectCols = '';
    filters = [];
    orderRows = [];
    embeds = [];
    limit = 50;
    offset = 0;
    bodyText = '';
    countExact = false;
    returnMode = '';
    explorerBusy = false;
    explorerError = null;
    explorerResult = null;
    explorerUrl = null;
    explorerMs = null;
    explorerStatus = null;
    explorerContentRange = null;
    explorerPreference = null;
  }

  function relTableForEmbed(name) {
    return embedOptionsFor(selectedTable).find((o) => o.name === name)?.relTable ?? null;
  }

  function addEmbed() {
    const opts = embedOptionsFor(selectedTable);
    embeds = [...embeds, { name: opts[0]?.name ?? '', cols: '', filters: [], order: [], limitVal: '', offsetVal: '' }];
  }
  function removeEmbed(i) {
    embeds = embeds.filter((_, idx) => idx !== i);
  }
  function updateEmbed(i, patch) {
    embeds = embeds.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
  }
  function addEmbedFilter(i) {
    const relCols = columnsFor(relTableForEmbed(embeds[i].name) ?? '');
    updateEmbed(i, { filters: [...embeds[i].filters, { column: relCols[0]?.name ?? '', op: 'eq', value: '' }] });
  }
  function removeEmbedFilter(i, j) {
    updateEmbed(i, { filters: embeds[i].filters.filter((_, fj) => fj !== j) });
  }
  function onEmbedOpChange(i, j, op) {
    updateEmbed(i, {
      filters: embeds[i].filters.map((f, fj) => (fj === j ? { ...f, op, value: op === 'is' ? 'null' : '' } : f)),
    });
  }
  function addEmbedOrder(i) {
    const relCols = columnsFor(relTableForEmbed(embeds[i].name) ?? '');
    updateEmbed(i, { order: [...embeds[i].order, { column: relCols[0]?.name ?? '', desc: false }] });
  }
  function removeEmbedOrder(i, j) {
    updateEmbed(i, { order: embeds[i].order.filter((_, oj) => oj !== j) });
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
    explorerContentRange = null;
    explorerPreference = null;
    try {
      // POST has no filter concept (it's an insert); PATCH/DELETE target
      // rows by the same base filters GET uses.
      const filterParams = method !== 'POST'
        ? filters.filter((f) => f.column && f.op).map((f) => [f.column, `${f.op}.${opValueSegment(f)}`])
        : [];

      let selectParam, orderParam, limitParam, offsetParam, extraParams;
      if (method === 'GET') {
        const order = orderRows
          .filter((o) => o.column)
          .map((o) => `${o.column}.${o.desc ? 'desc' : 'asc'}`)
          .join(',');
        // C2: embed entries (`name(col,col,...)`) sit inside the same
        // select= param as plain columns, comma-joined alongside them.
        const embedParts = embeds.filter((e) => e.name).map((e) => `${e.name}(${e.cols.trim()})`);
        const selectParts = [selectCols.trim(), ...embedParts].filter(Boolean);
        selectParam = selectParts.length ? selectParts.join(',') : undefined;
        orderParam = order || undefined;
        limitParam = limit;
        offsetParam = offset;

        // item 136: dotted per-embed filter/order/limit/offset params.
        extraParams = [];
        for (const e of embeds) {
          if (!e.name) continue;
          for (const f of e.filters) {
            if (f.column && f.op) extraParams.push([`${e.name}.${f.column}`, `${f.op}.${opValueSegment(f)}`]);
          }
          const embOrder = e.order.filter((o) => o.column).map((o) => `${o.column}.${o.desc ? 'desc' : 'asc'}`).join(',');
          if (embOrder) extraParams.push([`${e.name}.order`, embOrder]);
          if (e.limitVal !== '') extraParams.push([`${e.name}.limit`, String(e.limitVal)]);
          if (e.offsetVal !== '') extraParams.push([`${e.name}.offset`, String(e.offsetVal)]);
        }
      }

      let body;
      if (method === 'POST' || method === 'PATCH') {
        if (bodyText.trim()) {
          try {
            body = JSON.parse(bodyText);
          } catch {
            explorerError = 'Body must be valid JSON.';
            explorerBusy = false;
            return;
          }
        }
      }

      const out = await restRequest(selectedTable, method, {
        select: selectParam,
        filterParams,
        order: orderParam,
        limit: limitParam,
        offset: offsetParam,
        extraParams,
        countExact: method === 'GET' && countExact,
        return: method !== 'GET' && returnMode ? returnMode : undefined,
        body,
      });
      explorerResult = out.result;
      explorerUrl = out.url;
      explorerMs = out.roundTripMs;
      explorerStatus = out.status;
      explorerContentRange = out.contentRange;
      explorerPreference = out.preferenceApplied;
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
              ['Embedded resource (C2)', 'embed', snippetEmbed(selectedTable)],
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
              <h4>Try it — explorer</h4>
              <button class="ghost" onclick={() => (explorerOpen = !explorerOpen)}>
                {explorerOpen ? 'Hide' : 'Open'}
              </button>
            </div>
            {#if explorerOpen}
              <div class="explorer">
                <div class="method-row">
                  <span class="flabel">Method</span>
                  <div class="method-tabs">
                    {#each ['GET', 'POST', 'PATCH', 'DELETE'] as m}
                      <button
                        type="button"
                        class="method-tab"
                        class:active={method === m}
                        onclick={() => (method = m)}
                      >{m}</button>
                    {/each}
                  </div>
                </div>

                {#if method === 'GET'}
                  <label class="field">
                    <span class="flabel">select (comma-separated columns, blank = *)</span>
                    <input bind:value={selectCols} placeholder={cols.map((c) => c.name).join(',')} class="mono-input" />
                  </label>
                {/if}

                {#if method !== 'POST'}
                  <div class="field">
                    <span class="flabel">Filters{method !== 'GET' ? ' (target which rows)' : ''}</span>
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
                {/if}

                {#if method === 'POST' || method === 'PATCH'}
                  <label class="field">
                    <span class="flabel">Body (JSON {method === 'POST' ? 'object or array of objects' : 'object of assignments'})</span>
                    <textarea bind:value={bodyText} rows="3" class="mono-input code-area"
                      placeholder={method === 'POST'
                        ? JSON.stringify(Object.fromEntries(cols.filter((c) => !c.primaryKey).slice(0, 2).map((c) => [c.name, exampleValue(c)])))
                        : JSON.stringify(Object.fromEntries(cols.filter((c) => !c.primaryKey).slice(0, 1).map((c) => [c.name, exampleValue(c)])))}
                      spellcheck="false"></textarea>
                  </label>
                {/if}

                {#if method === 'GET'}
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

                  {#if embedOptionsFor(selectedTable).length}
                    <div class="field">
                      <span class="flabel">Embedded resources (C2 — <code>name(col,...)</code>, blank = all columns)</span>
                      {#each embeds as e, i}
                        {@const relTable = relTableForEmbed(e.name)}
                        {@const relCols = relTable ? columnsFor(relTable) : []}
                        <div class="embed-card">
                          <div class="filter-row">
                            <select value={e.name} onchange={(ev) => updateEmbed(i, { name: ev.target.value })}>
                              {#each embedOptionsFor(selectedTable) as opt}<option value={opt.name}>{opt.name} ({opt.kind})</option>{/each}
                            </select>
                            <input value={e.cols} oninput={(ev) => updateEmbed(i, { cols: ev.target.value })} placeholder="e.g. id,name" class="mono-input" />
                            <button class="del-btn" onclick={() => removeEmbed(i)}>✕</button>
                          </div>
                          <!-- item 136: per-embed filter/order/limit/offset, dotted <embed>.<param> -->
                          <div class="embed-sub">
                            <span class="sub-label">filter</span>
                            {#each e.filters as f, j}
                              <div class="filter-row">
                                <select value={f.column} onchange={(ev) => updateEmbed(i, { filters: e.filters.map((ff, fj) => fj === j ? { ...ff, column: ev.target.value } : ff) })}>
                                  {#each relCols as c}<option value={c.name}>{c.name}</option>{/each}
                                </select>
                                <select value={f.op} onchange={(ev) => onEmbedOpChange(i, j, ev.target.value)}>
                                  {#each FILTER_OPS as op}<option value={op}>{op}</option>{/each}
                                </select>
                                {#if f.op === 'is'}
                                  <select value={f.value} onchange={(ev) => updateEmbed(i, { filters: e.filters.map((ff, fj) => fj === j ? { ...ff, value: ev.target.value } : ff) })}>
                                    <option value="null">null</option>
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                  </select>
                                {:else}
                                  <input value={f.value} oninput={(ev) => updateEmbed(i, { filters: e.filters.map((ff, fj) => fj === j ? { ...ff, value: ev.target.value } : ff) })} placeholder={f.op === 'in' ? '1,2,3' : 'value'} class="mono-input" />
                                {/if}
                                <button class="del-btn" onclick={() => removeEmbedFilter(i, j)}>✕</button>
                              </div>
                            {/each}
                            <button class="ghost small-btn" onclick={() => addEmbedFilter(i)} disabled={!e.name}>+ embed filter</button>
                          </div>
                          <div class="embed-sub">
                            <span class="sub-label">order</span>
                            {#each e.order as o, j}
                              <div class="filter-row">
                                <select value={o.column} onchange={(ev) => updateEmbed(i, { order: e.order.map((oo, oj) => oj === j ? { ...oo, column: ev.target.value } : oo) })}>
                                  {#each relCols as c}<option value={c.name}>{c.name}</option>{/each}
                                </select>
                                <select value={o.desc} onchange={(ev) => updateEmbed(i, { order: e.order.map((oo, oj) => oj === j ? { ...oo, desc: ev.target.value === 'true' } : oo) })}>
                                  <option value={false}>asc</option>
                                  <option value={true}>desc</option>
                                </select>
                                <button class="del-btn" onclick={() => removeEmbedOrder(i, j)}>✕</button>
                              </div>
                            {/each}
                            <button class="ghost small-btn" onclick={() => addEmbedOrder(i)} disabled={!e.name}>+ embed order</button>
                          </div>
                          <div class="embed-sub limit-row">
                            <label class="field">
                              <span class="flabel">embed limit</span>
                              <input type="number" min="0" value={e.limitVal} oninput={(ev) => updateEmbed(i, { limitVal: ev.target.value })} class="num-input" />
                            </label>
                            <label class="field">
                              <span class="flabel">embed offset</span>
                              <input type="number" min="0" value={e.offsetVal} oninput={(ev) => updateEmbed(i, { offsetVal: ev.target.value })} class="num-input" />
                            </label>
                          </div>
                          <p class="embed-hint">Per-parent — each parent's <code>{e.name || '…'}</code> array is sliced independently (lateral), not a global cap.</p>
                        </div>
                      {/each}
                      <button class="ghost small-btn" onclick={addEmbed}>+ Add embed</button>
                    </div>
                  {/if}

                  <div class="limit-row">
                    <label class="field">
                      <span class="flabel">limit</span>
                      <input type="number" min="0" bind:value={limit} class="num-input" />
                    </label>
                    <label class="field">
                      <span class="flabel">offset</span>
                      <input type="number" min="0" bind:value={offset} class="num-input" />
                    </label>
                    <label class="check-field">
                      <input type="checkbox" bind:checked={countExact} />
                      <code>Prefer: count=exact</code>
                    </label>
                  </div>
                {:else}
                  <label class="field prefer-field">
                    <span class="flabel"><code>Prefer: return=</code> (item 139)</span>
                    <select bind:value={returnMode}>
                      <option value="">(default — {'{'}type,count{'}'} body)</option>
                      <option value="representation">representation (affected rows back)</option>
                      <option value="minimal">minimal (empty body)</option>
                    </select>
                  </label>
                {/if}

                <div class="run-row">
                  <button onclick={runExplorer} disabled={explorerBusy}>{explorerBusy ? 'Running…' : 'Run'}</button>
                </div>

                {#if explorerUrl}
                  <p class="explorer-url mono">
                    {method} {explorerUrl}{explorerMs != null ? ` · ${Math.round(explorerMs)} ms` : ''}{explorerStatus != null ? ` · ${explorerStatus}` : ''}
                  </p>
                {/if}
                {#if explorerContentRange}<p class="explorer-meta mono">Content-Range: {explorerContentRange}</p>{/if}
                {#if explorerPreference}<p class="explorer-meta mono">Preference-Applied: {explorerPreference}</p>{/if}
                {#if explorerError}<p class="err">{explorerError}</p>{/if}
                {#if explorerResult === null && explorerStatus != null && !explorerError}
                  <p class="muted small">Empty body ({explorerStatus}) — matches <code>return=minimal</code> / a plain mutation's usual shape.</p>
                {:else if explorerResult?.type === 'rows'}
                  <div class="explorer-result">
                    <ResultsGrid result={explorerResult} />
                  </div>
                {:else if explorerResult}
                  <p class="mutate-summary mono">{JSON.stringify(explorerResult)}</p>
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
  .run-row button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }

  .field textarea {
    padding: 6px 9px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px; resize: vertical;
  }
  .code-area { font-size: 12px; }

  .method-row { display: flex; align-items: center; gap: 10px; }
  .method-tabs { display: flex; gap: 4px; }
  .method-tab {
    padding: 4px 12px; font-size: 12px; font-family: var(--mono); font-weight: 600;
    border: 1px solid var(--border); border-radius: 6px; background: var(--panel);
    color: var(--muted); cursor: pointer;
  }
  .method-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .embed-card {
    border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 6px;
    background: var(--panel-alt); display: flex; flex-direction: column; gap: 4px;
  }
  .embed-sub { padding-left: 10px; border-left: 2px solid var(--border); }
  .sub-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); display: block; margin-bottom: 2px;
  }
  .embed-hint { font-size: 11px; color: var(--muted); margin: 4px 0 0; }
  .embed-hint code { font-family: var(--mono); background: var(--panel); border-radius: 3px; padding: 0 3px; }

  .run-row { display: flex; align-items: center; gap: 10px; }
  .check-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
  .check-field code { font-family: var(--mono); background: var(--panel-alt); border-radius: 3px; padding: 0 3px; }
  .prefer-field { max-width: 320px; }

  .explorer-url { font-size: 11px; color: var(--muted); word-break: break-all; margin: 0; }
  .explorer-meta { font-size: 11px; color: var(--accent); margin: 0; }
  .explorer-result { border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 360px; }
  .mutate-summary {
    font-size: 12px; background: var(--panel-alt); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px; margin: 0;
  }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .mono { font-family: var(--mono); }
  .err { color: var(--err-fg); }
</style>
