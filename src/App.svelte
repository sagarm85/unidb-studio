<script>
  import { getTables, BASE_URL, IS_CONFIGURED } from './lib/api.js';
  import TokenStatus from './lib/TokenStatus.svelte';
  import TablesSidebar from './lib/TablesSidebar.svelte';
  import SqlEditor from './lib/SqlEditor.svelte';
  import RecordBrowser from './lib/RecordBrowser.svelte';
  import CsvUpload from './lib/CsvUpload.svelte';
  import SchemaVisualizer from './lib/SchemaVisualizer.svelte';
  import { quoteIdent } from './lib/format.js';

  let tab = $state('sql'); // 'sql' | 'records' | 'schema' | 'csv'
  let selectedTable = $state(null);
  let sql = $state('SELECT 1;');
  let paramsText = $state('');

  // Shared catalog state (owned here, passed to sidebar + csv importer).
  let tables = $state([]);
  let tablesLoading = $state(true);
  let tablesError = $state(null);
  let tablesSupported = $state(true);

  async function loadTables() {
    tablesLoading = true;
    tablesError = null;
    try {
      const out = await getTables();
      tablesSupported = out.supported;
      tables = out.tables.filter((t) => !/^__/.test(t.name));
    } catch (e) {
      tablesError = { code: e.code, message: e.message, status: e.status };
      tables = [];
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
      onSelect={selectTable}
      onRefresh={loadTables}
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
            <RecordBrowser table={selectedTable} />
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
