import { useCallback, useEffect, useState } from 'react';
import { FunctionSquare, Plus, RefreshCw, X, Play } from 'lucide-react';
import { toast } from 'sonner';
import { listFunctions, upsertFunction, deleteFunction, callRpc } from '@/lib/engine/api.js';
import { formatCell } from '@/lib/engine/format.js';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// Stored functions & RPC (engine item 147). A stored function is a named,
// parameterized list of SQL statements the engine runs in ONE transaction.
// Admin surface (list/create/delete) is superuser-only; the call route
// POST /rest/v1/rpc/{fn} runs under invoker or run_as identity. This panel is a
// thin, engine-truthful client of those routes — no fabricated data.

interface StoredFunction {
  name: string;
  params: string[];
  body: string[];
  run_as: string | null;
}

// A per-statement result, matching the shape POST /sql returns per entry.
interface RpcResult {
  type?: string;
  columns?: string[];
  rows?: unknown[][];
  count?: number;
}

export function FunctionsPanel() {
  const [supported, setSupported] = useState(true);
  const [fns, setFns] = useState<StoredFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await listFunctions();
      setSupported(out.supported);
      setFns((out.functions as StoredFunction[]) ?? []);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── create ────────────────────────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState('');
  const [fParams, setFParams] = useState('');
  const [fBody, setFBody] = useState('');
  const [fRunAs, setFRunAs] = useState('');
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  function openCreate() {
    setFName('');
    setFParams('');
    setFBody('SELECT 1');
    setFRunAs('');
    setFError(null);
    setFormOpen(true);
  }

  // params: comma-separated names. body: one SQL statement per non-empty line.
  function parseParams(s: string): string[] {
    return s.split(',').map((p) => p.trim()).filter(Boolean);
  }
  function parseBody(s: string): string[] {
    return s.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async function submitForm() {
    setFError(null);
    const name = fName.trim();
    const body = parseBody(fBody);
    if (!name) return setFError('name is required.');
    if (!body.length) return setFError('body needs at least one SQL statement (one per line).');
    setFBusy(true);
    try {
      const payload: Record<string, unknown> = { name, params: parseParams(fParams), body };
      if (fRunAs.trim()) payload.run_as = fRunAs.trim();
      await upsertFunction(payload);
      toast.success('Function saved');
      setFormOpen(false);
      await load();
    } catch (e: any) {
      setFError(e?.message ?? String(e));
    } finally {
      setFBusy(false);
    }
  }

  // ── delete ────────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteFunction(deleteTarget);
      toast.success('Function deleted');
      setDeleteTarget(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  // ── call (RPC) ──────────────────────────────────────────────────────────
  const [callTarget, setCallTarget] = useState<StoredFunction | null>(null);
  const [callArgs, setCallArgs] = useState('{}');
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callResult, setCallResult] = useState<RpcResult | null>(null);

  function openCall(f: StoredFunction) {
    setCallTarget(f);
    // Scaffold a named-args object from the declared params (engine-truthful —
    // only the args the function actually declares).
    const scaffold = f.params.length ? `{\n${f.params.map((p) => `  "${p}": ""`).join(',\n')}\n}` : '{}';
    setCallArgs(scaffold);
    setCallError(null);
    setCallResult(null);
  }

  async function runCall() {
    if (!callTarget) return;
    setCallError(null);
    setCallResult(null);
    let args: unknown;
    try {
      args = JSON.parse(callArgs || '{}');
    } catch {
      setCallError('Arguments must be valid JSON — an object of named args or an array of positional args.');
      return;
    }
    setCallBusy(true);
    try {
      const out = await callRpc(callTarget.name, args);
      setCallResult(out as RpcResult);
    } catch (e: any) {
      setCallError(e?.message ?? String(e));
    } finally {
      setCallBusy(false);
    }
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  if (!loading && !supported) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">Stored functions not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 147 (<code>/functions</code> + <code>/rest/v1/rpc</code>). No fabricated data shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <FunctionSquare className="size-4" /> Functions
        </h3>
        <div className="flex items-center gap-2">
          <button className={ghostBtnCls} onClick={load} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
          <button className={cn(btnCls, 'flex items-center gap-1')} onClick={openCreate}>
            <Plus className="size-3.5" /> New function
          </button>
        </div>
      </div>

      <PanelHelp
        summary="Stored SQL functions callable over RPC — Supabase pg_proc / rpc() parity, one transaction per call."
        what={
          <>
            A function is <code>(name, params[], body[])</code> — a named, parameterized list of SQL statements the engine runs
            in <strong>one transaction</strong>, with <code>$1..$n</code> bound in declared-<code>params</code> order. Call it at{' '}
            <code>POST /rest/v1/rpc/{'{fn}'}</code> with a JSON object of named args or a JSON array of positional args; the response
            is the <strong>last</strong> statement's rows. Registration is superuser-only; the call route is open to any
            authenticated principal, running under the caller's own grants/RLS unless <code>run_as</code> pins an identity.
          </>
        }
        actions={[
          'New function → name, comma-separated params, and one SQL statement per line',
          'Call ▶ a function with named or positional args and see the last statement\'s result',
          'RLS still applies — an invoker-run function sees only what that principal is allowed to',
        ]}
        routes={['GET /functions', 'POST /functions', 'DELETE /functions/{name}', 'POST /rest/v1/rpc/{fn}']}
      />

      {error && <ErrorBox error={error} />}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="m-0 text-sm text-text-light">Loading…</p>
        ) : fns.length === 0 ? (
          <p className="m-0 text-sm text-text-light">
            No stored functions yet. Create one, or seed the demo set with <code>python3 demo/seed_functions.py</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {fns.map((f) => (
              <div key={f.name} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-md font-semibold">{f.name}</span>
                  <span className="font-mono text-sm text-text-muted">
                    ({f.params.length ? f.params.join(', ') : 'no args'})
                  </span>
                  {f.run_as ? (
                    <Badge variant="outline">run_as: {f.run_as}</Badge>
                  ) : (
                    <Badge variant="default">invoker</Badge>
                  )}
                  <div className="flex-1" />
                  <button className={cn(btnCls, 'flex items-center gap-1')} onClick={() => openCall(f)}>
                    <Play className="size-3" /> Call
                  </button>
                  <button className="text-text-muted hover:text-error" onClick={() => setDeleteTarget(f.name)} title="Delete function">
                    <X className="size-3.5" />
                  </button>
                </div>
                <pre className="m-0 overflow-x-auto rounded-sm bg-secondary px-2 py-1 font-mono text-sm text-text-light">
                  {f.body.join(';\n')}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => !open && setFormOpen(false)}>
        <DialogContent className="max-w-[560px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New function</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              name
              <input value={fName} onChange={(e) => setFName(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} placeholder="orders_by_status" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              params (comma-separated — bind as $1, $2, … in order)
              <input value={fParams} onChange={(e) => setFParams(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} placeholder="status" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              body (one SQL statement per line — runs in one transaction, last statement's rows are returned)
              <Textarea value={fBody} onChange={(e) => setFBody(e.target.value)} spellCheck={false} className="min-h-28 font-mono" placeholder="SELECT id, total_amount FROM orders WHERE status = $1" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              run_as (optional — blank = invoker: the caller's own grants/RLS)
              <input value={fRunAs} onChange={(e) => setFRunAs(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} />
            </label>
            {fError && <p className="m-0 text-sm text-error">{fError}</p>}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button className={btnCls} onClick={submitForm} disabled={fBusy}>
              {fBusy ? 'Saving…' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Call (RPC) dialog */}
      <Dialog open={!!callTarget} onOpenChange={(open) => !open && setCallTarget(null)}>
        <DialogContent className="max-w-[640px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="font-mono">
              {callTarget?.name}({callTarget?.params.join(', ')})
            </DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[74vh] flex-col gap-3 overflow-y-auto p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              arguments — JSON object of named args, or JSON array of positional args
              <Textarea value={callArgs} onChange={(e) => setCallArgs(e.target.value)} spellCheck={false} className="min-h-20 font-mono" />
            </label>
            <div>
              <button className={cn(btnCls, 'flex items-center gap-1.5')} onClick={runCall} disabled={callBusy}>
                <Play className="size-3.5" /> {callBusy ? 'Running…' : 'Run'}
              </button>
            </div>
            {callError && <p className="m-0 rounded-md bg-error-subtle px-3 py-2 text-sm text-error">{callError}</p>}
            {callResult && <RpcResultView result={callResult} />}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setCallTarget(null)}>
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete function</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Delete stored function <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget}</code>?
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={confirmDelete}
              disabled={deleteBusy}
            >
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Render one RPC result — the last statement's shape, exactly as POST /sql
// returns it: a rows table, or a mutation count, or raw JSON as a fallback.
function RpcResultView({ result }: { result: RpcResult }) {
  if (result.type === 'rows' && result.columns) {
    const rows = result.rows ?? [];
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-secondary">
                {result.columns.map((c) => (
                  <th key={c} className="border-b border-border px-2 py-1 text-left font-mono font-semibold text-text-light">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="odd:bg-secondary/30">
                  {r.map((v, ci) => (
                    <td key={ci} className="border-b border-border px-2 py-1 font-mono text-text-light">
                      {formatCell(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (typeof result.count === 'number' && result.type) {
    return (
      <p className="m-0 text-sm text-text-light">
        <span className="font-semibold">{result.count}</span> {result.type}
      </p>
    );
  }
  return <pre className="m-0 overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-sm text-text-light">{JSON.stringify(result, null, 2)}</pre>;
}
