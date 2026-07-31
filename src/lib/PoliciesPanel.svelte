<script>
  import { listPolicies, previewAsRole, runSql } from './api.js';
  import ResultsGrid from './ResultsGrid.svelte';

  // Policies editor (Workstream G2 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  //
  // What's REAL today (item 24, already shipped): CREATE/DROP POLICY, the
  // USING/WITH CHECK predicate editors, `current_user` substitution, and
  // `POST /auth/preview` ("preview as role"). All of that talks to the live
  // engine — no mocking.
  //
  // What's SCAFFOLDED (blocked on engine item 122, RLS↔token binding — see
  // ../unidb/docs/backlog/122_rls_token_binding.md): role-scoped policies
  // (`... TO <role>`) and the `auth.uid()` / `auth.jwt()->>'claim'` helpers.
  // The engine's CREATE POLICY grammar has no `TO <role>` clause yet, so that
  // field stays disabled with an inline note rather than sending SQL the
  // engine can't parse — never invent a working control for an absent route.
  let { tables = [] } = $props();

  let supported  = $state(true);
  let loading    = $state(true);
  let loadError  = $state(null);
  let policies   = $state([]); // [{name, table, op, usingExpr, withCheckExpr, enforced}]

  let selectedTable = $state(null); // table name, or null = "all tables"

  // new-policy modal
  let newOpen      = $state(false);
  let newName       = $state('');
  let newTable       = $state('');
  let newOp          = $state('ALL');
  let newUsing        = $state('');
  let newWithCheck    = $state('');
  let newBusy         = $state(false);
  let newError         = $state(null);

  let dropTarget = $state(null); // { name, table } | null
  let dropBusy   = $state(false);
  let dropError  = $state(null);

  // "preview as role" tool
  let previewOpen   = $state(false);
  let previewRole   = $state('');
  let previewSql    = $state('');
  let previewBusy   = $state(false);
  let previewError  = $state(null);
  let previewResult = $state(null); // { columns, rows } | null

  const OPS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  $effect(() => { load(); });

  async function load() {
    loading = true;
    loadError = null;
    try {
      const out = await listPolicies();
      supported = out.supported;
      policies = out.policies;
    } catch (e) {
      loadError = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  const visiblePolicies = $derived(
    selectedTable ? policies.filter((p) => p.table === selectedTable) : policies,
  );
  const policyCountByTable = $derived.by(() => {
    const m = {};
    for (const p of policies) m[p.table] = (m[p.table] ?? 0) + 1;
    return m;
  });

  function openNew() {
    newError = null;
    newName = '';
    newTable = selectedTable ?? tables[0]?.name ?? '';
    newOp = 'ALL';
    newUsing = '';
    newWithCheck = '';
    newOpen = true;
  }

  async function submitNew() {
    newError = null;
    const name = newName.trim();
    if (!IDENT_RE.test(name)) { newError = 'Policy name must start with a letter/underscore and contain only letters, digits, underscore.'; return; }
    if (!newTable) { newError = 'Pick a table.'; return; }
    if (!newUsing.trim()) { newError = 'USING predicate is required.'; return; }
    newBusy = true;
    try {
      let sql = `CREATE POLICY ${name} ON ${newTable} FOR ${newOp} USING (${newUsing.trim()})`;
      if (newWithCheck.trim()) sql += ` WITH CHECK (${newWithCheck.trim()})`;
      await runSql(sql);
      newOpen = false;
      await load();
    } catch (e) {
      newError = e.message ?? String(e);
    } finally {
      newBusy = false;
    }
  }

  async function confirmDrop() {
    dropBusy = true;
    dropError = null;
    try {
      await runSql(`DROP POLICY ${dropTarget.name} ON ${dropTarget.table}`);
      dropTarget = null;
      await load();
    } catch (e) {
      dropError = e.message ?? String(e);
    } finally {
      dropBusy = false;
    }
  }

  async function runPreview() {
    previewError = null;
    previewResult = null;
    const role = previewRole.trim();
    const sql = previewSql.trim();
    if (!role) { previewError = 'Enter a username to preview as.'; return; }
    if (!sql) { previewError = 'Enter a SELECT to run under that identity.'; return; }
    previewBusy = true;
    try {
      previewResult = await previewAsRole(role, sql);
    } catch (e) {
      previewError = e.message ?? String(e);
    } finally {
      previewBusy = false;
    }
  }

  function openPreviewFor(table) {
    previewOpen = true;
    previewRole = previewRole || '';
    previewSql = `SELECT * FROM ${table} LIMIT 50`;
    previewResult = null;
    previewError = null;
  }
</script>

<div class="policies">
  {#if loadError}
    <div class="unsupported">
      <h3>Couldn't load policies</h3>
      <p class="err">{loadError.code}: {loadError.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>
      </svg>
      <h3>Policies not available</h3>
      <p>This server doesn't expose <code>unidb_catalog.policies</code> yet (needs item-24 authorization support).</p>
    </div>
  {:else}
    <div class="layout">
      <!-- ── table sidebar ── -->
      <aside class="psidebar">
        <div class="sidebar-head">
          <span class="sidebar-title">Tables</span>
        </div>
        <ul class="entity-list">
          <li class:active={selectedTable === null}>
            <button class="entity-btn" onclick={() => (selectedTable = null)}>
              <span class="ename">All tables</span>
              <span class="count">{policies.length}</span>
            </button>
          </li>
          {#each tables as t}
            <li class:active={selectedTable === t.name}>
              <button class="entity-btn" onclick={() => (selectedTable = t.name)}>
                <span class="ename">{t.name}</span>
                <span class="count">{policyCountByTable[t.name] ?? 0}</span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      <!-- ── policy list + tools ── -->
      <div class="detail">
        <div class="toolbar">
          <strong class="toolbar-title">{selectedTable ?? 'All tables'}</strong>
          <span class="grow"></span>
          <button class="ghost" onclick={() => openPreviewFor(selectedTable ?? tables[0]?.name ?? '')} disabled={tables.length === 0}>
            Preview as role
          </button>
          <button onclick={openNew} disabled={tables.length === 0}>+ New policy</button>
        </div>

        {#if loading}
          <p class="muted">Loading…</p>
        {:else if visiblePolicies.length === 0}
          <p class="muted">No policies{selectedTable ? ` on ${selectedTable}` : ''} yet.</p>
        {:else}
          <ul class="policy-list">
            {#each visiblePolicies as p}
              <li class="policy-card">
                <div class="pc-head">
                  <span class="pc-name">{p.name}</span>
                  <span class="pc-op">{p.op}</span>
                  {#if !selectedTable}<span class="pc-table">{p.table}</span>{/if}
                  {#if !p.enforced}<span class="pc-warn" title="No users exist yet — RLS is inactive in open/bootstrap mode">not enforced (open mode)</span>{/if}
                  <span class="grow"></span>
                  <button class="del-btn" title="Drop policy" onclick={() => (dropTarget = { name: p.name, table: p.table })}>✕</button>
                </div>
                <div class="pc-expr"><span class="pc-label">USING</span><code>{p.usingExpr}</code></div>
                {#if p.withCheckExpr}
                  <div class="pc-expr"><span class="pc-label">WITH CHECK</span><code>{p.withCheckExpr}</code></div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ── New policy modal ── -->
{#if newOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newOpen = false)}>
    <div class="modal" role="dialog" aria-label="New policy" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New policy</strong>
        <button class="x" onclick={() => (newOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Name</span>
          <input bind:value={newName} placeholder="e.g. tenant_isolation" spellcheck="false" />
        </label>
        <label class="field">
          <span class="flabel">Table</span>
          <select bind:value={newTable}>
            {#each tables as t}<option value={t.name}>{t.name}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span class="flabel">Applies to</span>
          <select bind:value={newOp}>
            {#each OPS as op}<option value={op}>{op}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span class="flabel">USING (row filter)</span>
          <textarea bind:value={newUsing} rows="2" placeholder="owner = current_user" spellcheck="false"></textarea>
        </label>
        <label class="field">
          <span class="flabel">WITH CHECK (optional — write-side check; defaults to USING)</span>
          <textarea bind:value={newWithCheck} rows="2" placeholder="" spellcheck="false"></textarea>
        </label>
        <p class="hint">
          Insert <code>current_user</code> to reference the caller's identity (bare keyword, no
          parentheses). Role-scoped policies (<code>TO &lt;role&gt;</code>) and
          <code>auth.uid()</code> / <code>auth.jwt()</code> land with engine item 122 — not yet
          available.
        </p>
        {#if newError}<p class="err">{newError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newOpen = false)}>Cancel</button>
        <button onclick={submitNew} disabled={newBusy}>{newBusy ? 'Creating…' : 'Create policy'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Drop policy confirm ── -->
{#if dropTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (dropTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Drop policy</strong>
        <button class="x" onclick={() => (dropTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">Drop policy <code>{dropTarget.name}</code> on <code>{dropTarget.table}</code>?</p>
        {#if dropError}<p class="err">{dropError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (dropTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDrop} disabled={dropBusy}>{dropBusy ? 'Dropping…' : 'Drop policy'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Preview as role ── -->
{#if previewOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (previewOpen = false)}>
    <div class="modal preview-modal" role="dialog" aria-label="Preview as role" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Preview as role</strong>
        <button class="x" onclick={() => (previewOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="hint">Runs a SELECT as though authenticated as the given user — exactly which
          rows their RLS policies let through. Requires a superuser token (<code>POST /auth/preview</code>).</p>
        <label class="field">
          <span class="flabel">Preview as user</span>
          <input bind:value={previewRole} placeholder="e.g. alice" spellcheck="false" />
        </label>
        <label class="field">
          <span class="flabel">SQL (SELECT only)</span>
          <textarea bind:value={previewSql} rows="3" spellcheck="false"></textarea>
        </label>
        {#if previewError}<p class="err">{previewError}</p>{/if}
        {#if previewResult}
          <div class="preview-result">
            <ResultsGrid result={{ type: 'rows', columns: previewResult.columns, rows: previewResult.rows }} />
          </div>
        {/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (previewOpen = false)}>Close</button>
        <button onclick={runPreview} disabled={previewBusy}>{previewBusy ? 'Running…' : 'Run preview'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .policies { display: flex; flex-direction: column; height: 100%; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .layout { display: flex; height: 100%; min-height: 0; }

  .psidebar {
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
  .entity-list li.active .count { color: rgba(255,255,255,0.8); }
  .entity-btn {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px;
    background: none; border: none; padding: 7px 4px; cursor: pointer;
    color: var(--text); font-size: 13px; text-align: left;
  }
  .ename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { color: var(--muted); font-size: 11px; font-family: var(--mono); flex-shrink: 0; }

  .detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
  .toolbar { display: flex; align-items: center; gap: 8px; }
  .toolbar-title { font-size: 15px; font-family: var(--mono); }
  .grow { flex: 1; }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .ghost:disabled { opacity: 0.5; cursor: default; }

  .muted { color: var(--muted); }
  .err { color: var(--err-fg); }

  .policy-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .policy-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 6px; background: var(--panel);
  }
  .pc-head { display: flex; align-items: center; gap: 8px; }
  .pc-name { font-weight: 600; font-size: 13px; font-family: var(--mono); }
  .pc-op {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 4px; padding: 1px 6px;
  }
  .pc-table { font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .pc-warn {
    font-size: 10px; font-weight: 600; color: #b45309;
    background: rgba(217,119,6,0.12); border-radius: 4px; padding: 1px 6px;
  }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }
  .pc-expr { display: flex; gap: 8px; font-size: 12px; align-items: baseline; }
  .pc-label { color: var(--muted); font-weight: 600; flex-shrink: 0; width: 84px; }
  .pc-expr code {
    font-family: var(--mono); background: var(--panel-alt); border-radius: 4px;
    padding: 2px 6px; word-break: break-word;
  }

  /* ── modals ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(480px, 100%); display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3); overflow: hidden; max-height: 90vh;
  }
  .preview-modal { width: min(640px, 100%); }
  .del-modal { width: min(400px, 100%); }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .modal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input, .field select, .field textarea {
    padding: 7px 10px; font-size: 13px; font-family: var(--mono);
    color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  }
  .field textarea { resize: vertical; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }
  .del-msg { margin: 0; font-size: 13px; line-height: 1.6; }
  .del-msg code { font-family: var(--mono); background: var(--panel-alt); padding: 1px 5px; border-radius: 4px; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .x:hover { color: var(--err-fg); }
  .modal-foot button:not(.ghost):not(.del-btn) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .del-btn {
    background: var(--err-fg, #ef4444); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .modal-foot button:disabled { opacity: 0.5; cursor: default; }
  .preview-result { border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 280px; }
</style>
