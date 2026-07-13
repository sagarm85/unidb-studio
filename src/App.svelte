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
  import { runSql } from './lib/api.js';
  import { quoteIdent } from './lib/format.js';

  let tab = $state('sql'); // 'sql' | 'records' | 'schema' | 'csv'
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
  <header>
    <div class="brand">
      <span class="logo">unidb</span><span class="sub">studio</span>
    </div>
    <div class="conn">
      {#if !IS_CONFIGURED}
        <span class="badge warn">not configured</span>
      {:else}
        <TokenStatus />
        <code class="url">{BASE_URL}</code>
      {/if}
    </div>
  </header>

  {#if !IS_CONFIGURED}
    <div class="setup" role="alert">
      <strong>Not configured.</strong> Copy <code>.env.example</code> to <code>.env.local</code>, set
      <code>VITE_UNIDB_URL</code> and <code>VITE_UNIDB_TOKEN</code>, then restart <code>npm run dev</code>.
    </div>
  {/if}

  <div class="body">
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

    <main>
      <nav class="tabs">
        <button class:active={tab === 'sql'} onclick={() => (tab = 'sql')}>SQL editor</button>
        <button class:active={tab === 'records'} onclick={() => (tab = 'records')} disabled={!selectedTable}>
          Record browser
        </button>
        <button class:active={tab === 'schema'} onclick={() => (tab = 'schema')}>Schema</button>
        <button class:active={tab === 'csv'} onclick={() => (tab = 'csv')}>CSV import</button>
      </nav>

      <section class="panel">
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
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .logo {
    font-weight: 700;
    font-size: 16px;
    color: var(--accent);
  }
  .sub {
    color: var(--muted);
    font-size: 14px;
  }
  .conn {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
  }
  .url {
    font-family: var(--mono);
    color: var(--muted);
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
  .setup {
    padding: 10px 18px;
    background: var(--err-bg);
    border-bottom: 1px solid var(--err-border);
    font-size: 13px;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 8px 18px 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 12px;
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .tabs button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .panel {
    padding: 18px;
    overflow: auto;
    flex: 1;
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
  .muted {
    color: var(--muted);
  }
</style>
