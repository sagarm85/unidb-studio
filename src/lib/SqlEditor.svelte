<script>
  import { runSql, explainAnalyze, isSingleSelect } from './api.js';
  import ResultsGrid from './ResultsGrid.svelte';
  import ErrorBox from './ErrorBox.svelte';

  // `sql` may be seeded from outside (e.g. clicking a table). Bindable so the
  // parent can push a new query in.
  let { sql = $bindable('SELECT 1;'), paramsText = $bindable('') } = $props();

  let loading = $state(false);
  let error = $state(null);
  let results = $state(null);
  let roundTripMs = $state(null);
  let serverMs = $state(null); // null = not applicable (non-SELECT)
  let ranSelect = $state(false);

  function parseParams() {
    const t = paramsText.trim();
    if (!t) return [];
    const parsed = JSON.parse(t); // may throw -> caught in run()
    if (!Array.isArray(parsed)) throw new Error('params must be a JSON array');
    return parsed;
  }

  async function run() {
    loading = true;
    error = null;
    results = null;
    roundTripMs = null;
    serverMs = null;
    ranSelect = false;

    let params;
    try {
      params = parseParams();
    } catch (e) {
      error = { code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 };
      loading = false;
      return;
    }

    try {
      const out = await runSql(sql, params);
      results = out.results;
      roundTripMs = out.roundTripMs;

      // Server-exec timing is meaningful only for a single read query, and is
      // gathered by a COMPANION EXPLAIN ANALYZE call — never conflated with the
      // round-trip above. Failure here is non-fatal (query already succeeded).
      if (isSingleSelect(sql)) {
        ranSelect = true;
        try {
          const ea = await explainAnalyze(sql, params);
          serverMs = ea.serverMs;
        } catch {
          serverMs = null;
        }
      }
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function onKeydown(e) {
    // Cmd/Ctrl+Enter to run.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!loading) run();
    }
  }

  const fmt = (ms) => (ms == null ? '—' : `${ms.toFixed(2)} ms`);
</script>

<div class="editor">
  <textarea
    bind:value={sql}
    onkeydown={onKeydown}
    spellcheck="false"
    placeholder="SELECT * FROM ..."
    rows="6"
  ></textarea>

  <div class="controls">
    <button onclick={run} disabled={loading}>
      {loading ? 'Running…' : 'Run'}
    </button>
    <span class="hint">⌘/Ctrl + Enter</span>
    <input
      class="params"
      bind:value={paramsText}
      placeholder='params (JSON array, e.g. [1, "alice"])'
      spellcheck="false"
    />
  </div>

  {#if roundTripMs != null}
    <div class="timings">
      <span class="timing">round-trip: <b>{fmt(roundTripMs)}</b></span>
      {#if ranSelect}
        <span class="timing"
          >server exec: <b>{serverMs == null ? 'n/a' : fmt(serverMs)}</b>
          <span class="via">(EXPLAIN ANALYZE)</span></span
        >
      {/if}
    </div>
  {/if}

  {#if error}
    <ErrorBox {error} />
  {/if}

  {#if results}
    {#each results as result, i}
      {#if results.length > 1}
        <p class="stmt">statement {i + 1}</p>
      {/if}
      <ResultsGrid {result} />
    {/each}
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    resize: vertical;
  }
  textarea:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .params {
    flex: 1;
    font-family: var(--mono);
    font-size: 12px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
  }
  .timings {
    display: flex;
    gap: 18px;
    font-size: 12px;
  }
  .timing {
    color: var(--muted);
    font-family: var(--mono);
  }
  .timing b {
    color: var(--text);
  }
  .via {
    color: var(--muted);
    opacity: 0.75;
  }
  .stmt {
    margin: 8px 0 2px;
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
  }
</style>
