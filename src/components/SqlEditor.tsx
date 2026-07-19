import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  runSql,
  explain,
  explainAnalyze,
  isSingleSelect,
  txnBegin,
  txnCommit,
  txnRollback,
  runSqlCursor,
  cursorPage,
  cursorClose,
} from '@/lib/engine/api.js';
import { embed, vectorToSql } from '@/lib/engine/embed.js';
import { DataGrid, type DataGridResult } from './DataGrid';
import { ErrorBox } from './ErrorBox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import type { CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

// Heuristic, not a real parser (matches the same pragmatic style as
// isSingleSelect in api.js) — good enough to catch the common "SELECT * FROM
// big_table" case with no LIMIT, where Run would fetch the entire result set
// in one response and could hang the tab. Stream (server-side cursor paging)
// is the existing mitigation for that; this just surfaces the choice instead
// of silently fetching everything.
function looksUnbounded(sqlText: string) {
  return isSingleSelect(sqlText) && !/\blimit\s+\d+/i.test(sqlText);
}

interface Session {
  txnId: number | string;
  isolation: string;
}
interface StreamState {
  cursorId: string;
  columns: string[];
  rows: unknown[][];
  done: boolean;
  remaining: number;
}

const HISTORY_KEY = 'unidb-studio.sqlHistory';
const HISTORY_MAX = 20;
const SAVED_KEY = 'unidb-studio.savedQueries';

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function loadSaved(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const EXAMPLES = [
  { label: 'Select rows', sql: 'SELECT * FROM <table> LIMIT 50;' },
  { label: 'Filter (param)', sql: 'SELECT * FROM <table> WHERE id = $1;' },
  { label: 'Aggregate', sql: 'SELECT status, COUNT(*) FROM <table> GROUP BY status;' },
  { label: 'Join', sql: 'SELECT a.*, b.name\nFROM <table> a\nJOIN <other> b ON b.id = a.<other>_id;' },
  { label: 'Vector search (NEAR)', sql: 'SELECT * FROM <table>\nWHERE NEAR(<vector_col>, [0.1, 0.2, 0.3, 0.4], 5);' },
  { label: 'Create vector index', sql: 'CREATE INDEX idx_<table>_<col> ON <table> USING HNSW (<col>);' },
  { label: 'Explain analyze', sql: 'EXPLAIN ANALYZE SELECT * FROM <table> WHERE id = $1;' },
];

const INDENT = '  ';
const fmt = (ms: number | null) => (ms == null ? '—' : `${ms.toFixed(2)} ms`);
const preview = (q: string) => q.replace(/\s+/g, ' ').trim().slice(0, 80);

export function SqlEditor({
  sql,
  onSqlChange,
  paramsText,
  onParamsTextChange,
}: {
  sql: string;
  onSqlChange: (s: string) => void;
  paramsText: string;
  onParamsTextChange: (s: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);
  const [results, setResults] = useState<DataGridResult[] | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [serverMs, setServerMs] = useState<number | null>(null);
  const [ranSelect, setRanSelect] = useState(false);
  const [planLines, setPlanLines] = useState<string[] | null>(null);

  // ---- transaction session ------------------------------------------------
  const [session, setSession] = useState<Session | null>(null);
  const [isoChoice, setIsoChoice] = useState('read_committed');
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);

  async function startSession() {
    setError(null);
    setSessionMsg(null);
    try {
      const s = await txnBegin(isoChoice);
      setSession({ txnId: s.txnId, isolation: s.isolation });
      setSessionMsg(`Session #${s.txnId} started (${s.isolation}). DDL must run outside a session.`);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    }
  }
  async function endSession(commit: boolean) {
    if (!session) return;
    const id = session.txnId;
    try {
      const r = commit ? await txnCommit(id) : await txnRollback(id);
      setSessionMsg(`Session #${id} ${r.state}.`);
    } catch (e: any) {
      setSessionMsg(`Session #${id} ${commit ? 'commit' : 'rollback'} failed: ${e?.message}`);
    } finally {
      setSession(null);
    }
  }

  // ---- query history (persisted) ------------------------------------------
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showExamples, setShowExamples] = useState(false);

  function pushHistory(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const next = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, HISTORY_MAX);
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* storage full / unavailable — history is best-effort */
    }
  }
  function recall(q: string) {
    onSqlChange(q);
    setShowHistory(false);
    textareaRef.current?.focus();
  }
  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }

  // ---- vector embed helper --------------------------------------------------
  const [showEmbed, setShowEmbed] = useState(false);
  const [embedText, setEmbedText] = useState('');
  const [embedCopied, setEmbedCopied] = useState(false);
  const embedVec = useMemo(() => (embedText.trim() ? embed(embedText) : null), [embedText]);

  async function copyVector() {
    if (!embedVec) return;
    await navigator.clipboard.writeText(vectorToSql(embedVec));
    setEmbedCopied(true);
    setTimeout(() => setEmbedCopied(false), 1200);
  }
  function insertVector() {
    const el = textareaRef.current;
    if (!embedVec || !el) return;
    const vecStr = vectorToSql(embedVec);
    const start = el.selectionStart ?? sql.length;
    const end = el.selectionEnd ?? sql.length;
    const next = sql.slice(0, start) + vecStr + sql.slice(end);
    flushSync(() => onSqlChange(next));
    el.selectionStart = el.selectionEnd = start + vecStr.length;
    el.focus();
  }

  // ---- saved queries (pinned, persisted) ------------------------------------
  const [saved, setSaved] = useState<string[]>(loadSaved);
  function persistSaved(next: string[]) {
    setSaved(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
  }
  function saveCurrent() {
    const q = sql.trim();
    if (!q || saved.includes(q)) return;
    persistSaved([q, ...saved].slice(0, 50));
  }
  function unsave(q: string) {
    persistSaved(saved.filter((s) => s !== q));
  }
  function recallSaved(q: string) {
    onSqlChange(q);
    setShowSaved(false);
    textareaRef.current?.focus();
  }
  const isSaved = saved.includes(sql.trim());

  function useExample(s: string) {
    onSqlChange(s);
    setShowExamples(false);
    textareaRef.current?.focus();
  }

  function parseParams(): unknown[] {
    const t = paramsText.trim();
    if (!t) return [];
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) throw new Error('params must be a JSON array');
    return parsed;
  }

  // ---- cursor streaming -----------------------------------------------------
  const [stream, setStream] = useState<StreamState | null>(null);

  async function stopStream(current = stream) {
    if (current && !current.done) await cursorClose(current.cursorId);
    setStream(null);
  }

  async function loadMore(current: StreamState) {
    setLoading(true);
    try {
      const p = await cursorPage(current.cursorId, 200);
      setStream({
        ...current,
        columns: p.columns.length ? p.columns : current.columns,
        rows: [...current.rows, ...p.rows],
        done: p.done,
        remaining: p.remaining,
      });
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
      setStream(null);
    } finally {
      setLoading(false);
    }
  }

  async function startStream() {
    setError(null);
    setResults(null);
    setPlanLines(null);
    setStream(null);
    let params: unknown[];
    try {
      params = parseParams();
    } catch (e: any) {
      setError({ code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 });
      return;
    }
    setLoading(true);
    try {
      const c = await runSqlCursor(sql, params);
      const initial: StreamState = { cursorId: c.cursorId, columns: c.columns, rows: [], done: false, remaining: c.rowCount ?? 0 };
      setStream(initial);
      setLoading(false);
      await loadMore(initial);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
      setStream(null);
      setLoading(false);
    }
  }

  async function runExplain() {
    setError(null);
    setResults(null);
    setPlanLines(null);
    let params: unknown[];
    try {
      params = parseParams();
    } catch (e: any) {
      setError({ code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 });
      return;
    }
    setLoading(true);
    try {
      setPlanLines(await explain(sql, params));
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  const [confirmRunOpen, setConfirmRunOpen] = useState(false);

  function handleRunClick() {
    if (looksUnbounded(sql)) {
      setConfirmRunOpen(true);
      return;
    }
    run();
  }

  async function run() {
    setLoading(true);
    setError(null);
    setResults(null);
    setRoundTripMs(null);
    setServerMs(null);
    setRanSelect(false);
    setPlanLines(null);
    setStream(null);

    let params: unknown[];
    try {
      params = parseParams();
    } catch (e: any) {
      setError({ code: 'BAD_PARAMS', message: `params: ${e.message}`, status: 0 });
      setLoading(false);
      return;
    }

    try {
      const out = await runSql(sql, params, { txnId: (session?.txnId ?? null) as any });
      setResults(out.results);
      setRoundTripMs(out.roundTripMs);
      pushHistory(sql);

      // Server-exec timing is meaningful only for a single read query, and is
      // gathered by a COMPANION EXPLAIN ANALYZE call — never conflated with the
      // round-trip above. Failure here is non-fatal (query already succeeded).
      if (isSingleSelect(sql)) {
        setRanSelect(true);
        try {
          const ea = await explainAnalyze(sql, params);
          setServerMs(ea.serverMs);
        } catch {
          setServerMs(null);
        }
      }
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
      // A failed mutating statement aborts + destroys the session server-side
      // (Postgres-without-savepoints); reflect that so the UI doesn't keep
      // sending a dead X-Txn-Id. Pure-read failures leave the session open.
      if (session && (e?.code === 'TXN_NOT_FOUND' || !isSingleSelect(sql))) {
        setSessionMsg(`Session #${session.txnId} aborted by the failed statement — re-begin to continue.`);
        setSession(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function clearEditor() {
    onSqlChange('');
    onParamsTextChange('');
    setResults(null);
    setError(null);
    setRoundTripMs(null);
    setServerMs(null);
    setRanSelect(false);
    setPlanLines(null);
    stopStream();
    textareaRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!loading) handleRunClick();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      indentSelection(e.shiftKey);
    }
  }

  // Insert/remove two spaces at the caret (or across selected lines). Caret is
  // restored synchronously via flushSync so it lands correctly on the updated
  // textarea value (mirrors v1's `await tick()`).
  function indentSelection(outdent: boolean) {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const multiline = value.slice(lineStart, end).includes('\n') || start !== end;

    let selStart: number;
    let selEnd: number;
    let next: string;
    if (multiline) {
      const lines = value.slice(lineStart, end).split('\n');
      const block = lines.map((ln) => (outdent ? ln.replace(/^ {1,2}/, '') : INDENT + ln)).join('\n');
      next = value.slice(0, lineStart) + block + value.slice(end);
      selStart = lineStart;
      selEnd = lineStart + block.length;
    } else if (outdent) {
      const removed = value.slice(lineStart, start).match(/ {1,2}$/)?.[0].length ?? 0;
      next = value.slice(0, start - removed) + value.slice(start);
      selStart = selEnd = start - removed;
    } else {
      next = value.slice(0, start) + INDENT + value.slice(end);
      selStart = selEnd = start + INDENT.length;
    }

    flushSync(() => onSqlChange(next));
    el.selectionStart = selStart;
    el.selectionEnd = selEnd;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Session bar */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
        {session ? (
          <>
            <span className="font-semibold text-brand">● session #{session.txnId}</span>
            <span className="font-mono text-xs text-text-light">{session.isolation}</span>
            <span className="flex-1" />
            <button
              className="h-[26px] rounded-md border border-transparent bg-brand px-3 text-sm text-brand-text-on disabled:opacity-45"
              onClick={() => endSession(true)}
              disabled={loading}
            >
              Commit
            </button>
            <button
              className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-error hover:text-error disabled:opacity-45"
              onClick={() => endSession(false)}
              disabled={loading}
            >
              Rollback
            </button>
          </>
        ) : (
          <>
            <span className="text-text-light">Auto-commit</span>
            <select
              className="h-8 rounded-md border border-border bg-secondary px-2 text-sm"
              value={isoChoice}
              onChange={(e) => setIsoChoice(e.target.value)}
              title="Isolation level for the session"
            >
              <option value="read_committed">read committed</option>
              <option value="repeatable_read">repeatable read</option>
              <option value="serializable">serializable</option>
            </select>
            <span className="flex-1" />
            <button
              className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
              onClick={startSession}
              disabled={loading}
            >
              Begin session
            </button>
          </>
        )}
      </div>
      {sessionMsg && <p className="m-0 text-sm text-text-light">{sessionMsg}</p>}

      {/* Toolbar */}
      <div className="flex gap-2">
        <div className="relative">
          <button
            className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong disabled:opacity-45"
            onClick={() => {
              setShowHistory((v) => !v);
              setShowExamples(false);
              setShowSaved(false);
            }}
            disabled={history.length === 0}
            title="Recent queries"
          >
            History ▾
          </button>
          {showHistory && (
            <div
              className="absolute top-[calc(100%+4px)] left-0 z-50 max-h-80 min-w-[260px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-[var(--shadow-overlay)]"
              onMouseLeave={() => setShowHistory(false)}
            >
              {history.map((h, i) => (
                <button
                  key={i}
                  className="block w-full truncate rounded-md px-2 py-2 text-left font-mono text-sm hover:bg-accent"
                  onClick={() => recall(h)}
                  title={h}
                >
                  {preview(h)}
                </button>
              ))}
              <div className="mt-1 border-t border-border-muted pt-1 text-right">
                <button className="text-xs text-text-muted hover:text-error" onClick={clearHistory}>
                  Clear history
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong disabled:opacity-45"
            onClick={() => {
              setShowSaved((v) => !v);
              setShowHistory(false);
              setShowExamples(false);
            }}
            disabled={saved.length === 0}
            title="Saved queries"
          >
            Saved ▾
          </button>
          {showSaved && (
            <div
              className="absolute top-[calc(100%+4px)] left-0 z-50 max-h-80 min-w-[260px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-[var(--shadow-overlay)]"
              onMouseLeave={() => setShowSaved(false)}
            >
              {saved.map((q) => (
                <div key={q} className="flex items-center">
                  <button
                    className="flex-1 truncate rounded-md px-2 py-2 text-left font-mono text-sm hover:bg-accent"
                    onClick={() => recallSaved(q)}
                    title={q}
                  >
                    {preview(q)}
                  </button>
                  <button className="px-2 py-1 text-xs text-text-muted hover:text-error" title="Remove" onClick={() => unsave(q)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong disabled:opacity-45"
          onClick={saveCurrent}
          disabled={!sql.trim() || isSaved}
          title="Pin this query"
        >
          {isSaved ? '★ Saved' : '☆ Save'}
        </button>

        <div className="relative">
          <button
            className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong"
            onClick={() => {
              setShowExamples((v) => !v);
              setShowHistory(false);
              setShowSaved(false);
            }}
            title="Insert an example query"
          >
            Examples ▾
          </button>
          {showExamples && (
            <div
              className="absolute top-[calc(100%+4px)] left-0 z-50 max-h-80 min-w-[260px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-[var(--shadow-overlay)]"
              onMouseLeave={() => setShowExamples(false)}
            >
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  className="block w-full truncate rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => useExample(ex.sql)}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className={cn(
            'h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong',
            showEmbed && 'border-brand text-brand',
          )}
          onClick={() => {
            setShowEmbed((v) => !v);
            setShowHistory(false);
            setShowExamples(false);
            setShowSaved(false);
          }}
          title="Generate a NEAR() vector from plain text"
        >
          Embed
        </button>
      </div>

      {/* Embed panel */}
      {showEmbed && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <input
            className="h-7 min-w-[180px] flex-1 rounded-md border border-border bg-secondary px-2 font-mono text-sm outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
            value={embedText}
            onChange={(e) => setEmbedText(e.target.value)}
            placeholder="Type text to embed — e.g. wireless headphones noise cancellation…"
            spellCheck={false}
          />
          {embedVec ? (
            (() => {
              const nonZero = embedVec.filter((v: number) => v > 0).length;
              return (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span
                      className={cn('text-xs font-semibold whitespace-nowrap', nonZero <= 2 ? 'text-warn' : 'text-brand')}
                      title="More non-zero dimensions = better discrimination between results"
                    >
                      {nonZero} dim{nonZero === 1 ? '' : 's'} active
                      {nonZero <= 2 ? ' ⚠ add more words for better results' : ''}
                    </span>
                    <code className="min-w-0 flex-1 truncate text-xs text-text-muted">
                      [{embedVec.slice(0, 6).map((v: number) => v.toFixed(2)).join(', ')}, …]
                    </code>
                    <button
                      className="h-6 rounded-md border border-border px-2 text-xs whitespace-nowrap hover:border-border-strong hover:text-brand"
                      onClick={copyVector}
                    >
                      {embedCopied ? '✓ Copied' : 'Copy'}
                    </button>
                    <button
                      className="h-6 rounded-md border border-brand bg-brand px-2 text-xs whitespace-nowrap text-brand-text-on hover:bg-brand-hover"
                      onClick={insertVector}
                      title="Insert vector at cursor position in the editor"
                    >
                      Insert
                    </button>
                  </div>
                  <div className="w-full text-xs text-text-muted">
                    {nonZero <= 2 ? (
                      'Use more descriptive words to activate more dimensions and improve match accuracy.'
                    ) : (
                      <>
                        Ready — click Insert. Add <code className="text-foreground">vec_distance</code> to SELECT to see match scores
                        (below 1.3 = relevant, above = noise). Never put it in WHERE — the engine only exposes it in SELECT. Use 5+
                        words for tighter distances.
                      </>
                    )}
                  </div>
                </>
              );
            })()
          ) : (
            <span className="text-xs text-text-muted">
              word-hash → 64-dim vector · more words = better results · matches demo/vector_demo.py
            </span>
          )}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={sql}
        onChange={(e) => onSqlChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        placeholder="SELECT * FROM ..."
        rows={6}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-md leading-normal outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
        style={{ tabSize: 2 }}
      />

      <div className="flex items-center gap-3">
        <button
          className="h-8 rounded-md bg-brand px-3 text-md font-medium text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
          onClick={handleRunClick}
          disabled={loading}
        >
          {loading ? 'Running…' : 'Run'}
        </button>
        <button
          className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45"
          onClick={runExplain}
          disabled={loading || !sql.trim()}
        >
          Explain
        </button>
        <button
          className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45"
          onClick={startStream}
          disabled={loading || !isSingleSelect(sql)}
          title="Page a large read server-side via a cursor"
        >
          Stream
        </button>
        <button
          className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45"
          onClick={clearEditor}
          disabled={loading || (!sql && !paramsText)}
        >
          Clear
        </button>
        <span className="text-sm text-text-muted">⌘/Ctrl + Enter · Tab to indent</span>
        <input
          className="h-8 flex-1 rounded-md border border-border bg-secondary px-3 font-mono text-sm outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
          value={paramsText}
          onChange={(e) => onParamsTextChange(e.target.value)}
          placeholder='params (JSON array, e.g. [1, "alice"])'
          spellCheck={false}
        />
      </div>

      {roundTripMs != null && (
        <div className="flex gap-5 text-sm">
          <span className="font-mono text-text-light">
            round-trip: <b className="text-foreground">{fmt(roundTripMs)}</b>
          </span>
          {ranSelect && (
            <span className="font-mono text-text-light">
              server exec: <b className="text-foreground">{serverMs == null ? 'n/a' : fmt(serverMs)}</b>{' '}
              <span className="text-text-muted">(EXPLAIN ANALYZE)</span>
            </span>
          )}
        </div>
      )}

      <ErrorBox error={error} />

      {planLines && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-3 py-1.5 text-sm font-semibold">
            Query plan <span className="font-normal text-text-muted">(EXPLAIN)</span>
          </div>
          <pre className="m-0 overflow-auto p-3 font-mono text-sm leading-normal">{planLines.join('\n')}</pre>
        </div>
      )}

      {stream && (
        <>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-sm text-text-light">
              streaming · {stream.rows.length} rows loaded{stream.done ? ' · done' : ` · ~${stream.remaining} remaining`}
            </span>
            <span className="flex-1" />
            {!stream.done && (
              <button
                className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45"
                onClick={() => loadMore(stream)}
                disabled={loading}
              >
                Load more
              </button>
            )}
            <button
              className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong"
              onClick={() => stopStream()}
            >
              Close
            </button>
          </div>
          <DataGrid result={{ type: 'rows', columns: stream.columns, rows: stream.rows }} />
        </>
      )}

      {results &&
        results.map((result, i) => (
          <div key={i}>
            {results.length > 1 && <p className="mt-2 mb-0.5 text-sm font-semibold text-text-light">statement {i + 1}</p>}
            <DataGrid result={result} />
          </div>
        ))}

      <Dialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
        <DialogContent className="max-w-[440px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>No LIMIT on this query</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              This looks like an unbounded <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">SELECT</code> — Run fetches the
              entire result set in one response, which can hang the tab on a large table. <b>Stream</b> pages it server-side via a
              cursor instead.
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button
              className="mr-auto h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong"
              onClick={() => setConfirmRunOpen(false)}
            >
              Cancel
            </button>
            <button
              className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong"
              onClick={() => {
                setConfirmRunOpen(false);
                run();
              }}
            >
              Run anyway
            </button>
            <button
              className="h-8 rounded-md bg-brand px-3 text-md font-medium text-brand-text-on hover:bg-brand-hover"
              onClick={() => {
                setConfirmRunOpen(false);
                startStream();
              }}
            >
              Use Stream instead
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
