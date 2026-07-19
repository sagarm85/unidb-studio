<script>
  import { tick } from 'svelte';
  import {
    runSql, explain, explainAnalyze, isSingleSelect,
    txnBegin, txnCommit, txnRollback,
    runSqlCursor, cursorPage, cursorClose,
  } from './api.js';
  import { embed, vectorToSql } from './embed.js';
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
  let planLines = $state(null); // EXPLAIN plan (array of strings) | null

  // ---- transaction session ------------------------------------------------
  let session = $state(null); // { txnId, isolation } | null
  let isoChoice = $state('read_committed');
  let sessionMsg = $state(null);

  async function startSession() {
    error = null;
    sessionMsg = null;
    try {
      const s = await txnBegin(isoChoice);
      session = { txnId: s.txnId, isolation: s.isolation };
      sessionMsg = `Session #${s.txnId} started (${s.isolation}). DDL must run outside a session.`;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    }
  }
  async function endSession(commit) {
    if (!session) return;
    const id = session.txnId;
    try {
      const r = commit ? await txnCommit(id) : await txnRollback(id);
      sessionMsg = `Session #${id} ${r.state}.`;
    } catch (e) {
      sessionMsg = `Session #${id} ${commit ? 'commit' : 'rollback'} failed: ${e.message}`;
    } finally {
      session = null;
    }
  }

  let textarea; // bound element — needed for Tab-to-indent caret handling

  // ---- query history (persisted) ------------------------------------------
  const HISTORY_KEY = 'unidb-studio.sqlHistory';
  const HISTORY_MAX = 20;
  let history = $state(loadHistory());
  let showHistory = $state(false);
  let showExamples = $state(false);

  // ---- vector embed helper ------------------------------------------------
  let showEmbed = $state(false);
  let embedText = $state('');
  let embedCopied = $state(false);
  const embedVec = $derived(embedText.trim() ? embed(embedText) : null);

  async function copyVector() {
    if (!embedVec) return;
    await navigator.clipboard.writeText(vectorToSql(embedVec));
    embedCopied = true;
    setTimeout(() => (embedCopied = false), 1200);
  }

  async function insertVector() {
    if (!embedVec || !textarea) return;
    const vecStr = vectorToSql(embedVec);
    const start = textarea.selectionStart ?? sql.length;
    const end   = textarea.selectionEnd   ?? sql.length;
    sql = sql.slice(0, start) + vecStr + sql.slice(end);
    await tick();
    textarea.selectionStart = textarea.selectionEnd = start + vecStr.length;
    textarea.focus();
  }

  // ---- saved queries (pinned, persisted) ----------------------------------
  const SAVED_KEY = 'unidb-studio.savedQueries';
  let saved = $state(loadSaved());
  let showSaved = $state(false);

  function loadSaved() {
    try {
      const arr = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function persistSaved() {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch {
      /* best-effort */
    }
  }
  function saveCurrent() {
    const q = sql.trim();
    if (!q || saved.includes(q)) return;
    saved = [q, ...saved].slice(0, 50);
    persistSaved();
  }
  function unsave(q) {
    saved = saved.filter((s) => s !== q);
    persistSaved();
  }
  function recallSaved(q) {
    sql = q;
    showSaved = false;
    textarea?.focus();
  }
  const isSaved = $derived(saved.includes(sql.trim()));

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, HISTORY_MAX) : [];
    } catch {
      return [];
    }
  }
  function pushHistory(q) {
    const trimmed = q.trim();
    if (!trimmed) return;
    // De-dupe: drop any existing identical entry, put this one on top.
    const next = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, HISTORY_MAX);
    history = next;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* storage full / unavailable — history is best-effort */
    }
  }
  function recall(q) {
    sql = q;
    showHistory = false;
    textarea?.focus();
  }
  function clearHistory() {
    history = [];
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }

  // ---- example snippets ----------------------------------------------------
  const EXAMPLES = [
    { label: 'Select rows', sql: 'SELECT * FROM <table> LIMIT 50;' },
    { label: 'Filter (param)', sql: 'SELECT * FROM <table> WHERE id = $1;' },
    { label: 'Aggregate', sql: 'SELECT status, COUNT(*) FROM <table> GROUP BY status;' },
    { label: 'Join', sql: 'SELECT a.*, b.name\nFROM <table> a\nJOIN <other> b ON b.id = a.<other>_id;' },
    { label: 'Vector search (NEAR)', sql: 'SELECT * FROM <table>\nWHERE NEAR(<vector_col>, [0.1, 0.2, 0.3, 0.4], 5);' },
    { label: 'Create vector index', sql: 'CREATE INDEX idx_<table>_<col> ON <table> USING HNSW (<col>);' },
    { label: 'Explain analyze', sql: 'EXPLAIN ANALYZE SELECT * FROM <table> WHERE id = $1;' },
  ];
  function useExample(s) {
    sql = s;
    showExamples = false;
    textarea?.focus();
  }

  function clearEditor() {
    sql = '';
    paramsText = '';
    results = null;
    error = null;
    roundTripMs = null;
    serverMs = null;
    ranSelect = false;
    planLines = null;
    stopStream();
    textarea?.focus();
  }

  // ---- cursor streaming ---------------------------------------------------
  let stream = $state(null); // { cursorId, columns, rows, done, remaining } | null

  async function startStream() {
    error = null;
    results = null;
    planLines = null;
    stream = null;
    let params;
    try {
      params = parseParams();
    } catch (e) {
      error = { code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 };
      return;
    }
    loading = true;
    try {
      const c = await runSqlCursor(sql, params);
      stream = { cursorId: c.cursorId, columns: c.columns, rows: [], done: false, remaining: c.rowCount ?? 0 };
      await loadMore();
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
      stream = null;
    } finally {
      loading = false;
    }
  }
  async function loadMore() {
    if (!stream || stream.done) return;
    loading = true;
    try {
      const p = await cursorPage(stream.cursorId, 200);
      stream = {
        ...stream,
        columns: p.columns.length ? p.columns : stream.columns,
        rows: [...stream.rows, ...p.rows],
        done: p.done,
        remaining: p.remaining,
      };
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
      stream = null;
    } finally {
      loading = false;
    }
  }
  async function stopStream() {
    if (stream && !stream.done) await cursorClose(stream.cursorId);
    stream = null;
  }

  async function runExplain() {
    error = null;
    results = null;
    planLines = null;
    let params;
    try {
      params = parseParams();
    } catch (e) {
      error = { code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 };
      return;
    }
    loading = true;
    try {
      planLines = await explain(sql, params);
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

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
    planLines = null;
    stream = null;

    let params;
    try {
      params = parseParams();
    } catch (e) {
      error = { code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 };
      loading = false;
      return;
    }

    try {
      const out = await runSql(sql, params, { txnId: session?.txnId });
      results = out.results;
      roundTripMs = out.roundTripMs;
      pushHistory(sql);

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
      // A failed mutating statement aborts + destroys the session server-side
      // (Postgres-without-savepoints); reflect that so the UI doesn't keep
      // sending a dead X-Txn-Id. Pure-read failures leave the session open.
      if (session && (e.code === 'TXN_NOT_FOUND' || !isSingleSelect(sql))) {
        sessionMsg = `Session #${session.txnId} aborted by the failed statement — re-begin to continue.`;
        session = null;
      }
    } finally {
      loading = false;
    }
  }

  function onKeydown(e) {
    // Cmd/Ctrl+Enter to run.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!loading) run();
      return;
    }
    // Tab / Shift+Tab indent instead of moving focus out of the editor.
    if (e.key === 'Tab') {
      e.preventDefault();
      indentSelection(e.shiftKey);
    }
  }

  // Insert/remove two spaces at the caret (or across selected lines). Caret is
  // restored after `tick()` so it lands correctly once Svelte flushes the new
  // textarea value.
  const INDENT = '  ';
  async function indentSelection(outdent) {
    const el = textarea;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const multiline = value.slice(lineStart, end).includes('\n') || start !== end;

    let selStart;
    let selEnd;
    if (multiline) {
      const lines = value.slice(lineStart, end).split('\n');
      const block = lines.map((ln) => (outdent ? ln.replace(/^ {1,2}/, '') : INDENT + ln)).join('\n');
      sql = value.slice(0, lineStart) + block + value.slice(end);
      selStart = lineStart;
      selEnd = lineStart + block.length;
    } else if (outdent) {
      const removed = value.slice(lineStart, start).match(/ {1,2}$/)?.[0].length ?? 0;
      sql = value.slice(0, start - removed) + value.slice(start);
      selStart = selEnd = start - removed;
    } else {
      sql = value.slice(0, start) + INDENT + value.slice(end);
      selStart = selEnd = start + INDENT.length;
    }

    await tick();
    el.selectionStart = selStart;
    el.selectionEnd = selEnd;
  }

  const fmt = (ms) => (ms == null ? '—' : `${ms.toFixed(2)} ms`);
  const preview = (q) => q.replace(/\s+/g, ' ').trim().slice(0, 80);
</script>

<div class="editor">
  <div class="session-bar">
    {#if session}
      <span class="sess-on">● session #{session.txnId}</span>
      <span class="sess-iso">{session.isolation}</span>
      <span class="grow"></span>
      <button class="sess-commit" onclick={() => endSession(true)} disabled={loading}>Commit</button>
      <button class="sess-rollback" onclick={() => endSession(false)} disabled={loading}>Rollback</button>
    {:else}
      <span class="sess-off">Auto-commit</span>
      <select class="iso" bind:value={isoChoice} title="Isolation level for the session">
        <option value="read_committed">read committed</option>
        <option value="repeatable_read">repeatable read</option>
        <option value="serializable">serializable</option>
      </select>
      <span class="grow"></span>
      <button class="sess-begin" onclick={startSession} disabled={loading}>Begin session</button>
    {/if}
  </div>
  {#if sessionMsg}<p class="sess-msg">{sessionMsg}</p>{/if}

  <div class="editor-tools">
    <div class="menu-wrap">
      <button
        class="tool"
        onclick={() => { showHistory = !showHistory; showExamples = false; showSaved = false; }}
        disabled={history.length === 0}
        title="Recent queries"
      >History ▾</button>
      {#if showHistory}
        <div class="dropdown" role="presentation" onmouseleave={() => (showHistory = false)}>
          {#each history as h}
            <button class="drop-item" onclick={() => recall(h)} title={h}>{preview(h)}</button>
          {/each}
          <div class="drop-foot">
            <button class="linkbtn" onclick={clearHistory}>Clear history</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="menu-wrap">
      <button
        class="tool"
        onclick={() => { showSaved = !showSaved; showHistory = false; showExamples = false; }}
        disabled={saved.length === 0}
        title="Saved queries"
      >Saved ▾</button>
      {#if showSaved}
        <div class="dropdown" role="presentation" onmouseleave={() => (showSaved = false)}>
          {#each saved as q}
            <div class="drop-line">
              <button class="drop-item" onclick={() => recallSaved(q)} title={q}>{preview(q)}</button>
              <button class="drop-x" title="Remove" onclick={() => unsave(q)}>✕</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <button class="tool" onclick={saveCurrent} disabled={!sql.trim() || isSaved} title="Pin this query">
      {isSaved ? '★ Saved' : '☆ Save'}
    </button>

    <div class="menu-wrap">
      <button
        class="tool"
        onclick={() => { showExamples = !showExamples; showHistory = false; showSaved = false; }}
        title="Insert an example query"
      >Examples ▾</button>
      {#if showExamples}
        <div class="dropdown" role="presentation" onmouseleave={() => (showExamples = false)}>
          {#each EXAMPLES as ex}
            <button class="drop-item" onclick={() => useExample(ex.sql)}>{ex.label}</button>
          {/each}
        </div>
      {/if}
    </div>

    <button
      class="tool"
      class:embed-active={showEmbed}
      onclick={() => { showEmbed = !showEmbed; showHistory = false; showExamples = false; showSaved = false; }}
      title="Generate a NEAR() vector from plain text"
    >Embed</button>
  </div>

  {#if showEmbed}
    <div class="embed-panel">
      <input
        class="embed-input"
        bind:value={embedText}
        placeholder="Type text to embed — e.g. wireless headphones noise cancellation…"
        spellcheck="false"
      />
      {#if embedVec}
        {@const nonZero = embedVec.filter(v => v > 0).length}
        <div class="embed-out">
          <span class="embed-dims" class:embed-dims-warn={nonZero <= 2} title="More non-zero dimensions = better discrimination between results">
            {nonZero} dim{nonZero === 1 ? '' : 's'} active
            {#if nonZero <= 2}⚠ add more words for better results{/if}
          </span>
          <code class="embed-preview">[{embedVec.slice(0, 6).map(v => v.toFixed(2)).join(', ')}, …]</code>
          <button class="embed-btn" onclick={copyVector}>{embedCopied ? '✓ Copied' : 'Copy'}</button>
          <button class="embed-btn primary" onclick={insertVector} title="Insert vector at cursor position in the editor">Insert</button>
        </div>
        <div class="embed-tip">
          {#if nonZero <= 2}Use more descriptive words to activate more dimensions and improve match accuracy.{:else}Ready — click Insert. Add <code>vec_distance</code> to SELECT to see match scores (below 1.3 = relevant, above = noise). Never put it in WHERE — the engine only exposes it in SELECT. Use 5+ words for tighter distances.{/if}
        </div>
      {:else}
        <span class="embed-hint">word-hash → 64-dim vector · more words = better results · matches demo/vector_demo.py</span>
      {/if}
    </div>
  {/if}

  <textarea
    bind:this={textarea}
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
    <button class="secondary" onclick={runExplain} disabled={loading || !sql.trim()}>Explain</button>
    <button class="secondary" onclick={startStream} disabled={loading || !isSingleSelect(sql)} title="Page a large read server-side via a cursor">Stream</button>
    <button class="secondary" onclick={clearEditor} disabled={loading || (!sql && !paramsText)}>Clear</button>
    <span class="hint">⌘/Ctrl + Enter · Tab to indent</span>
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

  {#if planLines}
    <div class="plan">
      <div class="plan-head">Query plan <span class="via">(EXPLAIN)</span></div>
      <pre>{planLines.join('\n')}</pre>
    </div>
  {/if}

  {#if stream}
    <div class="stream-bar">
      <span class="stream-info">
        streaming · {stream.rows.length} rows loaded{stream.done ? ' · done' : ` · ~${stream.remaining} remaining`}
      </span>
      <span class="grow"></span>
      {#if !stream.done}
        <button class="secondary" onclick={loadMore} disabled={loading}>Load more</button>
      {/if}
      <button class="secondary" onclick={stopStream}>Close</button>
    </div>
    <ResultsGrid result={{ type: 'rows', columns: stream.columns, rows: stream.rows }} />
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
  .session-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-alt);
    font-size: 12px;
  }
  .grow {
    flex: 1;
  }
  .sess-off {
    color: var(--muted);
  }
  .sess-on {
    color: var(--accent);
    font-weight: 600;
  }
  .sess-iso {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  .iso {
    padding: 3px 6px;
    font-size: 12px;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .session-bar button {
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .session-bar button:disabled {
    opacity: 0.5;
  }
  .sess-begin:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sess-commit {
    background: var(--accent) !important;
    color: #fff !important;
    border: none !important;
  }
  .sess-rollback:hover {
    border-color: var(--err-fg);
    color: var(--err-fg);
  }
  .sess-msg {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .editor-tools {
    display: flex;
    gap: 6px;
  }
  .menu-wrap {
    position: relative;
  }
  .tool {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
  }
  .tool:disabled {
    opacity: 0.5;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 15;
    min-width: 260px;
    max-height: 320px;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    padding: 4px;
  }
  .drop-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 7px 9px;
    font-size: 12px;
    font-family: var(--mono);
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .drop-item:hover {
    background: var(--panel-alt);
  }
  .drop-line {
    display: flex;
    align-items: center;
  }
  .drop-line .drop-item {
    flex: 1;
  }
  .drop-x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 11px;
    padding: 4px 8px;
  }
  .drop-x:hover {
    color: var(--err-fg);
  }
  .drop-foot {
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding-top: 4px;
    text-align: right;
  }
  .linkbtn {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }
  .linkbtn:hover {
    color: var(--err-fg);
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
    tab-size: 2;
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
  /* the Clear button is secondary — override the accent-filled default */
  .editor button.secondary {
    background: none;
    color: var(--text);
    border: 1px solid var(--border);
    font-weight: 500;
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
  .stream-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .stream-info {
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .plan {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-alt);
    overflow: hidden;
  }
  .plan-head {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  .plan pre {
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text);
  }

  /* ── vector embed helper ─────────────────────────────────── */
  .tool.embed-active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .embed-panel {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-alt);
    flex-wrap: wrap;
  }
  .embed-input {
    flex: 1;
    min-width: 180px;
    font-family: var(--mono);
    font-size: 12px;
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
  }
  .embed-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .embed-out {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }
  .embed-preview {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .embed-hint {
    font-size: 11px;
    color: var(--muted);
  }
  .embed-dims {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    white-space: nowrap;
  }
  .embed-dims-warn {
    color: #b45309;
  }
  .embed-tip {
    width: 100%;
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }
  .embed-tip code {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--text);
  }
  .embed-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .embed-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .embed-btn.primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .embed-btn.primary:hover {
    opacity: 0.88;
  }
</style>
