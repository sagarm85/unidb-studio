<script>
  import { getTables, getSchema, BASE_URL, IS_CONFIGURED } from './lib/api.js';
  import TokenStatus from './lib/TokenStatus.svelte';
  import TablesSidebar from './lib/TablesSidebar.svelte';
  import SqlEditor from './lib/SqlEditor.svelte';
  import RecordBrowser from './lib/RecordBrowser.svelte';
  import CsvUpload from './lib/CsvUpload.svelte';
  import SchemaVisualizer from './lib/SchemaVisualizer.svelte';
  import TableBuilder from './lib/TableBuilder.svelte';
  import TableActions from './lib/TableActions.svelte';
  import ObservabilityPanel from './lib/ObservabilityPanel.svelte';
  import LogsPanel from './lib/LogsPanel.svelte';
  import EventsPanel from './lib/EventsPanel.svelte';
  import StoragePanel from './lib/StoragePanel.svelte';
  import ComparePanel from './lib/ComparePanel.svelte';
  import { runSql } from './lib/api.js';
  import { quoteIdent } from './lib/format.js';

  // 'sql' | 'records' | 'schema' | 'csv' | 'storage' | 'events' | 'observability' | 'logs' | 'compare'
  let tab = $state('sql');
  let selectedTable = $state(null);
  let sql = $state('SELECT 1;');
  let paramsText = $state('');

  // Shared catalog state (owned here, passed to sidebar / record browser / csv).
  // Prefer the Milestone-18 catalog (real primary keys + types + FKs, which the
  // Table Editor and header badges need); fall back to the flat GET /tables on a
  // pre-M18 server — there PK is unknown, so row editing is disabled downstream.
  let tables = $state([]);
  let relationships = $state([]); // real FKs from the catalog (empty on fallback)
  let catalogSource = $state('catalog'); // 'catalog' | 'tables'
  let tablesLoading = $state(true);
  let tablesError = $state(null);
  let tablesSupported = $state(true);

  const notInternal = (t) => !/^__/.test(t.name);

  async function loadTables() {
    tablesLoading = true;
    tablesError = null;
    try {
      const s = await getSchema();
      if (s.supported) {
        tables = s.tables.filter(notInternal);
        relationships = s.relationships;
        catalogSource = 'catalog';
        tablesSupported = true;
      } else {
        const out = await getTables();
        tables = out.tables.filter(notInternal);
        relationships = [];
        catalogSource = 'tables';
        tablesSupported = out.supported;
      }
      // Re-point the current selection at the refreshed table object (after a
      // reload/DDL/edit) so the record browser sees fresh columns.
      if (selectedTable) {
        selectedTable = tables.find((t) => t.name === selectedTable.name) ?? null;
      }
    } catch (e) {
      tablesError = { code: e.code, message: e.message, status: e.status };
      tables = [];
      relationships = [];
    } finally {
      tablesLoading = false;
    }
  }

  $effect(() => {
    loadTables();
  });

  function selectTable(t) {
    selectedTable = t;
    tab = 'records';
  }

  function queryTableInEditor() {
    if (!selectedTable) return;
    sql = `SELECT * FROM ${quoteIdent(selectedTable.name)} LIMIT 50;`;
    paramsText = '';
    tab = 'sql';
  }

  // ---- DDL (schema management) --------------------------------------------
  const canDDL = $derived(catalogSource === 'catalog'); // needs a live catalog
  let newTableOpen = $state(false);
  let actionsTarget = $state(null); // table being managed, or null

  // Run a DDL statement, then refresh the catalog and re-point any open target.
  async function runDDL(sql) {
    await runSql(sql);
    await loadTables();
    if (actionsTarget) {
      actionsTarget = tables.find((t) => t.name === actionsTarget.name) ?? null;
    }
  }
  async function onNewTableSubmit(sqlText) {
    await runDDL(sqlText);
    newTableOpen = false;
  }
  function onTableDropped() {
    const dropped = actionsTarget?.name;
    actionsTarget = null;
    if (selectedTable?.name === dropped) {
      selectedTable = null;
      if (tab === 'records') tab = 'sql';
    }
  }
</script>

<div class="app">

  <!-- ── Left navigation ───────────────────────────────────────────────────── -->
  <nav class="leftnav">
    <div class="brand">
      <span class="logo">unidb</span><span class="sub">studio</span>
    </div>

    <div class="nav-group">
      <span class="nav-label">Data</span>
      <button class:active={tab === 'sql'} onclick={() => (tab = 'sql')} title="SQL Editor">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <polyline points="6,7 2,10 6,13"/><polyline points="14,7 18,10 14,13"/>
          <line x1="11" y1="4" x2="9" y2="16"/>
        </svg>
        SQL Editor
      </button>
      <button class:active={tab === 'records'} onclick={() => (tab = 'records')} title="Table Editor">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="2" y="4" width="16" height="13" rx="1"/>
          <line x1="2" y1="8" x2="18" y2="8"/>
          <line x1="7" y1="8" x2="7" y2="17"/>
        </svg>
        Table Editor
      </button>
      <button class:active={tab === 'schema'} onclick={() => (tab = 'schema')} title="Schema">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="7" y="2" width="6" height="4" rx="1"/>
          <rect x="1" y="14" width="6" height="4" rx="1"/>
          <rect x="13" y="14" width="6" height="4" rx="1"/>
          <line x1="10" y1="6" x2="10" y2="10"/><line x1="10" y1="10" x2="4" y2="14"/>
          <line x1="10" y1="10" x2="16" y2="14"/>
        </svg>
        Schema
      </button>
      <button class:active={tab === 'csv'} onclick={() => (tab = 'csv')} title="CSV Import">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M10 13V4M6 8l4-4 4 4"/>
          <path d="M3 15h14a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z"/>
        </svg>
        CSV Import
      </button>
    </div>

    <div class="nav-divider"></div>

    <div class="nav-group">
      <span class="nav-label">Platform</span>
      <button class:active={tab === 'storage'} onclick={() => (tab = 'storage')} title="Storage">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <ellipse cx="10" cy="6" rx="8" ry="3"/>
          <path d="M2 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/>
          <path d="M2 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4"/>
        </svg>
        Storage
      </button>
      <button class:active={tab === 'events'} onclick={() => (tab = 'events')} title="Events">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <polyline points="11,2 6,11 10,11 9,18 14,9 10,9"/>
        </svg>
        Events
      </button>
      <button class:active={tab === 'observability'} onclick={() => (tab = 'observability')} title="Observability">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <polyline points="2,15 6,9 9,12 13,6 18,10"/>
          <line x1="2" y1="18" x2="18" y2="18"/>
        </svg>
        Observability
      </button>
      <button class:active={tab === 'logs'} onclick={() => (tab = 'logs')} title="Logs">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="3" y="2" width="14" height="16" rx="1"/>
          <line x1="7" y1="7" x2="13" y2="7"/>
          <line x1="7" y1="10" x2="13" y2="10"/>
          <line x1="7" y1="13" x2="10" y2="13"/>
        </svg>
        Logs
      </button>
      <button class:active={tab === 'compare'} onclick={() => (tab = 'compare')} title="Compare">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="2" y="4" width="6" height="12" rx="1"/>
          <rect x="12" y="4" width="6" height="12" rx="1"/>
          <line x1="9" y1="10" x2="11" y2="10"/>
        </svg>
        Compare
      </button>
    </div>

    <div class="nav-bottom">
      {#if !IS_CONFIGURED}
        <span class="badge warn">not configured</span>
      {:else}
        <TokenStatus />
        <code class="url" title={BASE_URL}>{BASE_URL.replace(/^https?:\/\//, '')}</code>
      {/if}
    </div>
  </nav>

  <!-- ── Main body (row: optional sidebar + content) ──────────────────────── -->
  <div class="body">

    <!-- Tables sidebar — only for data tabs -->
    {#if tab === 'sql' || tab === 'records' || tab === 'schema' || tab === 'csv'}
      <TablesSidebar
        {tables}
        loading={tablesLoading}
        error={tablesError}
        supported={tablesSupported}
        selected={selectedTable?.name}
        canDDL={canDDL}
        onSelect={selectTable}
        onRefresh={loadTables}
        onNewTable={() => (newTableOpen = true)}
        onManageTable={(t) => (actionsTarget = t)}
      />
    {/if}

    <main>
      {#if !IS_CONFIGURED}
        <div class="setup" role="alert">
          <strong>Not configured.</strong> Copy <code>.env.example</code> to <code>.env.local</code>, set
          <code>VITE_UNIDB_URL</code> and <code>VITE_UNIDB_TOKEN</code>, then restart <code>npm run dev</code>.
        </div>
      {/if}
      <section class="panel" class:no-pad={tab === 'storage'}>
        {#if tab === 'sql'}
          <SqlEditor bind:sql bind:paramsText />
        {:else if tab === 'records'}
          {#if selectedTable}
            <div class="records-head">
              <button class="link" onclick={queryTableInEditor}>Open in SQL editor →</button>
            </div>
            <RecordBrowser
              table={selectedTable}
              {relationships}
              editable={catalogSource === 'catalog'}
              onChanged={loadTables}
            />
          {:else}
            <p class="muted">Pick a table from the sidebar.</p>
          {/if}
        {:else if tab === 'schema'}
          <SchemaVisualizer {tables} />
        {:else if tab === 'csv'}
          <CsvUpload {tables} />
        {:else if tab === 'storage'}
          <StoragePanel />
        {:else if tab === 'events'}
          <EventsPanel {tables} />
        {:else if tab === 'observability'}
          <ObservabilityPanel />
        {:else if tab === 'logs'}
          <LogsPanel />
        {:else if tab === 'compare'}
          <ComparePanel />
        {/if}
      </section>
    </main>
  </div>
</div>

{#if newTableOpen}
  <TableBuilder onSubmit={onNewTableSubmit} onClose={() => (newTableOpen = false)} />
{/if}
{#if actionsTarget}
  <TableActions
    table={actionsTarget}
    onRun={runDDL}
    onClose={() => (actionsTarget = null)}
    onDropped={onTableDropped}
  />
{/if}

<style>
  /* ── Root layout ─────────────────────────────────────────── */
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Left navigation ─────────────────────────────────────── */
  .leftnav {
    width: 168px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 0;
    overflow-y: auto;
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 3px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .logo {
    font-weight: 800;
    font-size: 15px;
    color: var(--accent);
    letter-spacing: -0.3px;
  }
  .sub {
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
  }

  .nav-group {
    display: flex;
    flex-direction: column;
    padding: 10px 8px 4px;
    gap: 1px;
  }
  .nav-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    padding: 4px 8px 6px;
  }
  .nav-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 12px;
  }

  .leftnav button {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background 0.1s, color 0.1s;
  }
  .leftnav button:hover {
    background: var(--panel-alt);
    color: var(--text);
  }
  .leftnav button.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .leftnav button svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    stroke: currentColor;
  }

  .nav-bottom {
    margin-top: auto;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .url {
    font-family: var(--mono);
    color: var(--muted);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.warn {
    background: rgba(210, 153, 34, 0.15);
    color: #b8860b;
  }

  /* ── Body (right of leftnav) — row: sidebar? + main ─────── */
  .body {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-width: 0;
    overflow: hidden;
  }
  .setup {
    padding: 8px 18px;
    background: var(--err-bg);
    border-bottom: 1px solid var(--err-border);
    font-size: 13px;
    flex-shrink: 0;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .panel {
    padding: 18px;
    overflow: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .panel.no-pad {
    padding: 0;
    overflow: hidden;
  }
  .records-head {
    margin-bottom: 10px;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
  }
  .muted { color: var(--muted); }
</style>
