<script>
  import { getGraphqlSchema, graphqlRequest, BASE_URL } from './api.js';

  // GraphQL explorer (Workstream C4, item 130/133 — see
  // ../../docs/AUTH_POLICY_PANELS_PLAN.md). Live over the engine's
  // schema-derived, read + write `POST /graphql` (queries merged via PR
  // #232; mutations via PR #235 on unidb main). Three parts, extending the
  // API-docs panel (G4)'s split: (1) a schema browser generated straight
  // from a standard GraphQL introspection query (every value here is
  // engine data — nothing invented), (2) mutation support — insert_/
  // update_/delete_<table> root fields, each resolved through the exact
  // same enforced RLS/grant path as the query side, no parallel write path
  // — and (3) a query/mutation editor that POSTs `{query, variables}` and
  // renders the real `{data, errors}` response. JWT-gated like every other
  // data-plane route — not public.
  //
  // The two differentiators unidb has over a relational-only
  // Supabase/PostgREST + pg_graphql stack — graph edge traversal
  // (`edges(type, direction)` on any Int64-PK table) and vector similarity
  // (root `near_<table>(vector, k)`) — are surfaced explicitly below, not
  // buried in the generic field list.

  let loading   = $state(true);
  let error     = $state(null);
  let supported = $state(true);
  let schema    = $state(null); // raw __schema

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const out = await getGraphqlSchema();
      supported = out.supported;
      schema = out.schema;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  // ── schema shaping ────────────────────────────────────────────────────────
  const types = $derived(schema?.types ?? []);
  const queryTypeName = $derived(schema?.queryType?.name ?? null);
  const queryType = $derived(types.find((t) => t.name === queryTypeName) ?? null);
  const rootFields = $derived(queryType?.fields ?? []);
  // item 133: a Mutation root only exists when at least one table is
  // eligible (a GraphQL object type needs ≥1 field) — absent entirely on a
  // schema with zero tables, not an error.
  const mutationTypeName = $derived(schema?.mutationType?.name ?? null);
  const mutationType = $derived(types.find((t) => t.name === mutationTypeName) ?? null);
  const mutationFields = $derived(mutationType?.fields ?? []);
  const insertFields = $derived(mutationFields.filter((f) => f.name.startsWith('insert_')));
  const updateFields = $derived(mutationFields.filter((f) => f.name.startsWith('update_')));
  const deleteFields = $derived(mutationFields.filter((f) => f.name.startsWith('delete_')));

  // Print a TypeRef the way GraphQL SDL would: `[Table!]!`, `Int`, …
  function printTypeRef(t) {
    if (!t) return '?';
    if (t.kind === 'NON_NULL') return `${printTypeRef(t.ofType)}!`;
    if (t.kind === 'LIST') return `[${printTypeRef(t.ofType)}]`;
    return t.name ?? '?';
  }
  // Unwrap NON_NULL/LIST wrappers down to the named leaf type + whether a
  // list was involved anywhere in the chain.
  function unwrapType(t) {
    let list = false;
    let cur = t;
    while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
      if (cur.kind === 'LIST') list = true;
      cur = cur.ofType;
    }
    return { named: cur, list };
  }
  function isScalarish(t) {
    const { named } = unwrapType(t);
    return named?.kind === 'SCALAR' || named?.kind === 'ENUM';
  }

  const HIDDEN = new Set(['Query', 'JSON', 'Edge', 'EdgeDirection', 'String', 'Int', 'Float', 'Boolean', 'ID']);
  // Object types other than Query — one per table (item 130's schema-gen rule).
  const objectTypes = $derived(
    types
      .filter((t) => t.kind === 'OBJECT' && !t.name.startsWith('__') && !HIDDEN.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const vectorFields = $derived(rootFields.filter((f) => f.name.startsWith('near_')));
  const tableFields = $derived(rootFields.filter((f) => !f.name.startsWith('near_')));

  function scalarFieldNames(typeName) {
    const t = types.find((x) => x.name === typeName);
    return (t?.fields ?? []).filter((f) => isScalarish(f.type)).map((f) => f.name);
  }
  function hasEdges(typeName) {
    const t = types.find((x) => x.name === typeName);
    return (t?.fields ?? []).some((f) => f.name === 'edges');
  }
  function rootFieldForType(typeName) {
    return rootFields.find((f) => unwrapType(f.type).named?.name === typeName);
  }
  const edgeCapableTypes = $derived(objectTypes.filter((t) => hasEdges(t.name)));

  // ── selection (sidebar -> detail pane) ────────────────────────────────────
  let selected = $state(null); // { kind: 'field'|'type'|'mutation', name }

  function selectField(f) {
    selected = { kind: 'field', name: f.name };
  }
  function selectType(t) {
    selected = { kind: 'type', name: t.name };
  }
  function selectMutation(f) {
    selected = { kind: 'mutation', name: f.name };
  }
  const selectedField = $derived(selected?.kind === 'field' ? rootFields.find((f) => f.name === selected.name) : null);
  const selectedType = $derived(selected?.kind === 'type' ? types.find((t) => t.name === selected.name) : null);
  const selectedMutation = $derived(selected?.kind === 'mutation' ? mutationFields.find((f) => f.name === selected.name) : null);
  function starterForMutation(f) {
    if (f.name.startsWith('insert_')) return starterInsert(f);
    if (f.name.startsWith('update_')) return starterUpdate(f);
    if (f.name.startsWith('delete_')) return starterDelete(f);
    return null;
  }

  // ── starter queries ────────────────────────────────────────────────────────
  function starterForField(f) {
    const { named } = unwrapType(f.type);
    const cols = scalarFieldNames(named?.name).slice(0, 6);
    const body = cols.length ? cols.join('\n    ') : '__typename';
    const args = f.name.startsWith('near_') ? 'vector: [0, 0, 0], k: 5' : 'limit: 5';
    return `{\n  ${f.name}(${args}) {\n    ${body}\n  }\n}`;
  }
  function starterEdges(typeName) {
    const f = rootFieldForType(typeName);
    if (!f) return null;
    const cols = scalarFieldNames(typeName).slice(0, 3);
    const body = cols.length ? cols.join('\n    ') : '__typename';
    return `{\n  ${f.name}(limit: 3) {\n    ${body}\n    edges(direction: OUT) {\n      fromId\n      toId\n      edgeType\n      props\n    }\n  }\n}`;
  }

  // A JSON-typed placeholder value for a scalar field, using the field's
  // REAL GraphQL type (Int/Float/Boolean/String) from the introspected
  // schema — not a blind guess, though the value itself is a stand-in the
  // user is expected to edit before running (same spirit as ApiDocsPanel's
  // exampleValue for /rest/v1 curl snippets).
  function placeholderForField(f) {
    const { named } = unwrapType(f.type);
    if (named?.name === 'Int') return 1;
    if (named?.name === 'Float') return 1.5;
    if (named?.name === 'Boolean') return true;
    return 'value';
  }
  function tableForMutation(fieldName, prefix) {
    return types.find((t) => t.name === fieldName.slice(prefix.length));
  }
  function starterInsert(f) {
    const t = tableForMutation(f.name, 'insert_');
    const cols = (t?.fields ?? []).filter((c) => isScalarish(c.type)).slice(0, 4);
    const values = cols.map((c) => `${c.name}: ${JSON.stringify(placeholderForField(c))}`).join(', ');
    const body = cols.length ? cols.slice(0, 3).map((c) => c.name).join('\n    ') : '__typename';
    return `mutation {\n  ${f.name}(values: { ${values} }) {\n    ${body}\n  }\n}`;
  }
  function starterUpdate(f) {
    const t = tableForMutation(f.name, 'update_');
    const cols = (t?.fields ?? []).filter((c) => isScalarish(c.type));
    const pk = cols.find((c) => c.name === 'id') ?? cols[0];
    const other = cols.find((c) => c.name !== pk?.name) ?? cols[0];
    const filterArg = pk ? `${pk.name}: ${JSON.stringify(placeholderForField(pk))}` : '';
    const setObj = other ? `${other.name}: ${JSON.stringify(placeholderForField(other))}` : '';
    const body = cols.length ? cols.slice(0, 3).map((c) => c.name).join('\n    ') : '__typename';
    return `mutation {\n  ${f.name}(${filterArg}, set: { ${setObj} }) {\n    ${body}\n  }\n}`;
  }
  function starterDelete(f) {
    const t = tableForMutation(f.name, 'delete_');
    const cols = (t?.fields ?? []).filter((c) => isScalarish(c.type));
    const pk = cols.find((c) => c.name === 'id') ?? cols[0];
    const filterArg = pk ? `${pk.name}: ${JSON.stringify(placeholderForField(pk))}` : '';
    const body = cols.length ? cols.slice(0, 3).map((c) => c.name).join('\n    ') : '__typename';
    return `mutation {\n  ${f.name}(${filterArg}) {\n    ${body}\n  }\n}`;
  }

  function useStarter(text) {
    query = text;
    gqlResult = null;
    gqlError = null;
  }

  // ── query editor / runner ─────────────────────────────────────────────────
  let query = $state('{\n  __typename\n}');
  let variablesText = $state('');
  let gqlBusy   = $state(false);
  let gqlError  = $state(null);
  let gqlResult = $state(null); // { data, errors }
  let gqlMs     = $state(null);

  async function runQuery() {
    gqlBusy = true;
    gqlError = null;
    gqlResult = null;
    let variables = null;
    if (variablesText.trim()) {
      try {
        variables = JSON.parse(variablesText);
      } catch {
        gqlError = 'Variables must be valid JSON.';
        gqlBusy = false;
        return;
      }
    }
    try {
      const out = await graphqlRequest(query, variables);
      if (!out.supported) {
        gqlError = 'POST /graphql is not available on this server.';
      } else {
        gqlResult = { data: out.data, errors: out.errors };
        gqlMs = out.roundTripMs;
      }
    } catch (e) {
      gqlError = e.message ?? String(e);
    } finally {
      gqlBusy = false;
    }
  }
</script>

<div class="gqlpanel">
  {#if error}
    <div class="unsupported">
      <h3>Couldn't load the GraphQL schema</h3>
      <p class="err">{error.code}: {error.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>
      </svg>
      <h3>GraphQL not available</h3>
      <p>This server doesn't expose <code>POST /graphql</code> yet (needs item-130 GraphQL support).</p>
    </div>
  {:else}
    <div class="layout">
      <!-- ── schema sidebar ── -->
      <aside class="asidebar">
        {#if loading}
          <p class="muted small pad">Loading schema…</p>
        {:else}
          <div class="sidebar-head"><span class="sidebar-title">Root queries</span></div>
          <ul class="entity-list">
            {#each tableFields as f}
              <li class:active={selected?.kind === 'field' && selected.name === f.name}>
                <button class="entity-btn" onclick={() => selectField(f)}>{f.name}</button>
              </li>
            {/each}
          </ul>
          {#if vectorFields.length}
            <div class="sidebar-head"><span class="sidebar-title">Vector search</span></div>
            <ul class="entity-list">
              {#each vectorFields as f}
                <li class:active={selected?.kind === 'field' && selected.name === f.name}>
                  <button class="entity-btn" onclick={() => selectField(f)}>
                    {f.name} <span class="badge vec">vector</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if mutationFields.length}
            <div class="sidebar-head"><span class="sidebar-title">Mutations</span></div>
            <ul class="entity-list">
              {#each [...insertFields, ...updateFields, ...deleteFields] as f}
                <li class:active={selected?.kind === 'mutation' && selected.name === f.name}>
                  <button class="entity-btn" onclick={() => selectMutation(f)}>
                    {f.name} <span class="badge mut">write</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          <div class="sidebar-head"><span class="sidebar-title">Types</span></div>
          <ul class="entity-list">
            {#each objectTypes as t}
              <li class:active={selected?.kind === 'type' && selected.name === t.name}>
                <button class="entity-btn" onclick={() => selectType(t)}>
                  {t.name} {#if hasEdges(t.name)}<span class="badge edge">edges</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <!-- ── detail + editor ── -->
      <div class="detail">
        <section class="block callout">
          <h4>Differentiators</h4>
          <p class="hint">
            Every relational field here has a Supabase/pg_graphql analog. These two don't:
          </p>
          <ul class="diff-list">
            <li>
              <strong>Graph edge traversal</strong> — any table with a single <code>Int64</code>
              primary key gets an <code>edges(type: String, direction: EdgeDirection = OUT)</code>
              field over the same <code>__edges__</code> store <code>POST /edges</code> writes to.
              {#if edgeCapableTypes.length}
                <span class="muted small">({edgeCapableTypes.map((t) => t.name).join(', ')})</span>
              {/if}
            </li>
            <li>
              <strong>Vector similarity</strong> — any table with a <code>VECTOR</code> column gets
              a root <code>near_&lt;table&gt;(vector: [Float!]!, k: Int!)</code> field (requires an
              HNSW index on that column first).
              {#if vectorFields.length}
                <span class="muted small">({vectorFields.map((f) => f.name).join(', ')})</span>
              {:else}
                <span class="muted small">(none on this schema yet — no <code>VECTOR</code> columns)</span>
              {/if}
            </li>
          </ul>
        </section>

        {#if selectedField}
          <section class="block">
            <h4>Query field</h4>
            <p class="field-sig mono">
              {selectedField.name}({selectedField.args?.map((a) => `${a.name}: ${printTypeRef(a.type)}`).join(', ') ?? ''}): {printTypeRef(selectedField.type)}
            </p>
            <button class="ghost small-btn" onclick={() => useStarter(starterForField(selectedField))}>
              Use starter query →
            </button>
          </section>
        {/if}

        {#if selectedMutation}
          <section class="block">
            <h4>Mutation field</h4>
            <p class="field-sig mono">
              {selectedMutation.name}({selectedMutation.args?.map((a) => `${a.name}: ${printTypeRef(a.type)}`).join(', ') ?? ''}): {printTypeRef(selectedMutation.type)}
            </p>
            <p class="hint">
              Resolves through the exact same enforced <code>INSERT</code>/<code>UPDATE</code>/
              <code>DELETE … RETURNING</code> path as <code>/rest/v1</code> and <code>/sql</code> —
              <code>WITH CHECK</code>/RLS policies apply on write exactly as they do over SQL.
            </p>
            <button class="ghost small-btn" onclick={() => useStarter(starterForMutation(selectedMutation))}>
              Use starter mutation →
            </button>
          </section>
        {/if}

        {#if selectedType}
          <section class="block">
            <h4>{selectedType.name}</h4>
            <table class="schema-table">
              <thead><tr><th>Field</th><th>Type</th><th></th></tr></thead>
              <tbody>
                {#each selectedType.fields ?? [] as f}
                  {@const { named, list } = unwrapType(f.type)}
                  <tr>
                    <td class="mono">{f.name}</td>
                    <td class="mono">{printTypeRef(f.type)}</td>
                    <td>
                      {#if f.name === 'edges'}<span class="pill edge">graph edges</span>
                      {:else if named?.kind === 'OBJECT'}<span class="pill rel">{list ? 'reverse FK' : 'forward FK'}</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if hasEdges(selectedType.name)}
              <button class="ghost small-btn" onclick={() => useStarter(starterEdges(selectedType.name))}>
                Use edges starter query →
              </button>
            {/if}
          </section>
        {/if}

        <section class="block">
          <div class="explorer-head">
            <h4>Try it — query editor</h4>
          </div>
          <p class="hint">
            POSTs <code>{'{ query, variables }'}</code> to <code>{BASE_URL}/graphql</code> under
            your current bearer token — same RLS/grants as everywhere else in this Studio.
          </p>
          <div class="editor">
            <label class="field">
              <span class="flabel">Query</span>
              <textarea bind:value={query} rows="8" class="mono-input code-area" spellcheck="false"></textarea>
            </label>
            <label class="field">
              <span class="flabel">Variables (JSON, optional)</span>
              <textarea bind:value={variablesText} rows="3" class="mono-input code-area" placeholder="{'{}'}" spellcheck="false"></textarea>
            </label>
            <div class="run-row">
              <button onclick={runQuery} disabled={gqlBusy || !query.trim()}>{gqlBusy ? 'Running…' : 'Run'}</button>
              {#if gqlMs != null}<span class="muted small">{Math.round(gqlMs)} ms</span>{/if}
            </div>
            {#if gqlError}<p class="err">{gqlError}</p>{/if}
            {#if gqlResult}
              <div class="result">
                {#if gqlResult.errors?.length}
                  <div class="gql-errors">
                    {#each gqlResult.errors as e}
                      <p class="err small">{e.message}{e.extensions?.code ? ` (${e.extensions.code})` : ''}</p>
                    {/each}
                  </div>
                {/if}
                {#if gqlResult.data}
                  <pre class="gql-data">{JSON.stringify(gqlResult.data, null, 2)}</pre>
                {/if}
              </div>
            {/if}
          </div>
        </section>
      </div>
    </div>
  {/if}
</div>

<style>
  .gqlpanel { display: flex; flex-direction: column; height: 100%; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .layout { display: flex; height: 100%; min-height: 0; }

  .asidebar {
    width: 240px; flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    background: var(--panel-alt);
    overflow-y: auto;
  }
  .pad { padding: 10px 12px; }
  .sidebar-head { padding: 10px 12px 6px; }
  .sidebar-head:not(:first-child) { border-top: 1px solid var(--border); margin-top: 4px; }
  .sidebar-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--muted);
  }
  .entity-list { list-style: none; margin: 0; padding: 0 0 4px; }
  .entity-list li { padding: 0 6px; border-radius: 6px; margin: 1px 4px; }
  .entity-list li.active { background: var(--accent); }
  .entity-list li.active .entity-btn { color: #fff; }
  .entity-btn {
    width: 100%; display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 7px 4px; cursor: pointer;
    color: var(--text); font-size: 13px; text-align: left; font-family: var(--mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .badge {
    font-size: 9px; font-weight: 700; text-transform: uppercase; border-radius: 4px; padding: 1px 5px;
    font-family: var(--sans, inherit);
  }
  .badge.vec { background: rgba(124, 58, 237, 0.15); color: #7c3aed; }
  .badge.edge { background: rgba(8, 145, 178, 0.15); color: #0891b2; }
  .badge.mut { background: rgba(220, 38, 38, 0.12); color: #dc2626; }

  .detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 18px; }

  .block h4 {
    margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--muted);
  }
  .callout { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--panel); }
  .diff-list { margin: 8px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 1.5; }
  .diff-list code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }

  .field-sig { font-size: 13px; margin: 0 0 8px; word-break: break-all; }

  .schema-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
  .schema-table th, .schema-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .schema-table th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .schema-table tr:last-child td { border-bottom: none; }
  .pill {
    font-size: 9px; font-weight: 700; text-transform: uppercase; border-radius: 4px; padding: 1px 6px;
  }
  .pill.edge { color: #0891b2; background: rgba(8, 145, 178, 0.12); }
  .pill.rel  { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }

  .hint { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }

  .explorer-head h4 { margin: 0 0 4px; }
  .editor { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .code-area {
    padding: 8px 10px; font-size: 12px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px; resize: vertical;
  }
  .mono-input { font-family: var(--mono); }
  .run-row { display: flex; align-items: center; gap: 10px; }
  .run-row button {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer;
  }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer; align-self: flex-start;
  }
  .small-btn { padding: 4px 10px; font-size: 12px; }
  button:disabled { opacity: 0.5; cursor: default; }

  .result { display: flex; flex-direction: column; gap: 6px; }
  .gql-errors { display: flex; flex-direction: column; gap: 2px; }
  .gql-data {
    margin: 0; padding: 10px; font-family: var(--mono); font-size: 12px;
    white-space: pre-wrap; word-break: break-all; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 6px; max-height: 360px; overflow: auto;
  }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .mono { font-family: var(--mono); }
  .err { color: var(--err-fg); }
</style>
