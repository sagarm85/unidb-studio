import { useCallback, useEffect, useState } from 'react';
import { Radio, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { listChannelPolicies, putChannelPolicy, deleteChannelPolicy, runSql, RESERVED_ROLES } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// Realtime channel authorization policies (item 140) — GET/PUT/DELETE
// /realtime/policies, in front of the Broadcast & Presence panel's four
// routes. (topic_pattern, operation, allowed_roles), most-specific-match
// precedence is engine-side — this panel lists policies as-is rather than
// trying to resolve/reorder them.

interface ChannelPolicy {
  topic_pattern: string;
  operation: 'publish' | 'subscribe' | 'presence' | 'all';
  allowed_roles: string[];
}

const OPERATIONS = ['publish', 'subscribe', 'presence', 'all'] as const;

export function RealtimeAuthzPanel() {
  const [supported, setSupported] = useState(true);
  const [policies, setPolicies] = useState<ChannelPolicy[]>([]);
  const [customRoles, setCustomRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);

  const roleChoices = [...RESERVED_ROLES, ...customRoles];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [out, roleRows] = await Promise.all([
        listChannelPolicies(),
        runSql('SELECT name FROM unidb_catalog.roles').catch(() => ({ results: [] as any[] })),
      ]);
      setSupported(out.supported);
      setPolicies(out.policies as ChannelPolicy[]);
      setCustomRoles((roleRows.results[0]?.rows ?? []).map((r: any[]) => String(r[0])));
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- create ----
  const [newOpen, setNewOpen] = useState(false);
  const [fTopic, setFTopic] = useState('');
  const [fOp, setFOp] = useState<(typeof OPERATIONS)[number]>('subscribe');
  const [fRoles, setFRoles] = useState<Set<string>>(new Set());
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  function openCreate() {
    setFTopic('');
    setFOp('subscribe');
    setFRoles(new Set());
    setFError(null);
    setNewOpen(true);
  }
  function toggleRole(r: string) {
    setFRoles((s) => {
      const next = new Set(s);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }

  async function submitNew() {
    setFError(null);
    if (!fTopic.trim() || fRoles.size === 0) {
      setFError('topic_pattern and at least one role are required.');
      return;
    }
    setFBusy(true);
    try {
      await putChannelPolicy(fTopic.trim(), fOp, Array.from(fRoles));
      toast.success('Policy saved');
      setNewOpen(false);
      await load();
    } catch (e: any) {
      setFError(e?.message ?? String(e));
    } finally {
      setFBusy(false);
    }
  }

  // ---- delete ----
  const [deleteTarget, setDeleteTarget] = useState<ChannelPolicy | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteChannelPolicy(deleteTarget.topic_pattern, deleteTarget.operation);
      toast.success('Policy deleted');
      setDeleteTarget(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  if (!loading && !supported) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">Channel authorization not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 140 (<code>/realtime/policies</code>). No fabricated data shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <Radio className="size-4" /> Channel Authz
        </h3>
        <div className="flex items-center gap-2">
          <button className={ghostBtnCls} onClick={load} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
          <button className={cn(btnCls, 'flex items-center gap-1')} onClick={openCreate}>
            <Plus className="size-3.5" /> New policy
          </button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs leading-relaxed text-text-light">
        Any authenticated caller may publish/subscribe/track on a topic with <strong>no matching policy</strong> — the default posture unless the server sets{' '}
        <code>UNIDB_REALTIME_REQUIRE_AUTHZ=1</code> (fail-closed instead). This is a server-process env var with no read API, so its live value isn't shown
        here — only documented. <code>service_role</code>/superuser bypass all policies (audited server-side).
      </div>

      {error && <ErrorBox error={error} />}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="m-0 text-sm text-text-light">Loading…</p>
        ) : policies.length === 0 ? (
          <p className="m-0 text-sm text-text-light">No channel policies — every topic is open to any authenticated caller.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {policies.map((p, i) => (
              <div key={`${p.topic_pattern}-${p.operation}-${i}`} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
                <span className="font-mono text-md" title={p.topic_pattern}>
                  {p.topic_pattern}
                </span>
                <Badge variant="info">{p.operation}</Badge>
                <div className="flex flex-1 flex-wrap gap-1">
                  {p.allowed_roles.map((r) => (
                    <Badge key={r} variant="outline">
                      {r}
                    </Badge>
                  ))}
                </div>
                <button className="text-text-muted hover:text-error" onClick={() => setDeleteTarget(p)}>
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={newOpen} onOpenChange={(open) => !open && setNewOpen(false)}>
        <DialogContent className="max-w-[460px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New channel policy</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              topic_pattern
              <input value={fTopic} onChange={(e) => setFTopic(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} placeholder="room:*" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              operation
              <select value={fOp} onChange={(e) => setFOp(e.target.value as typeof fOp)} className={inputCls}>
                {OPERATIONS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-text-light">allowed_roles</span>
              <div className="flex flex-wrap gap-3">
                {roleChoices.map((r) => (
                  <label key={r} className="flex items-center gap-1.5 text-md">
                    <input type="checkbox" checked={fRoles.has(r)} onChange={() => toggleRole(r)} /> {r}
                  </label>
                ))}
              </div>
            </div>
            {fError && <p className="m-0 text-sm text-error">{fError}</p>}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setNewOpen(false)}>
              Cancel
            </button>
            <button className={btnCls} onClick={submitNew} disabled={fBusy}>
              {fBusy ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete policy</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Delete the <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget?.operation}</code> policy on{' '}
              <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget?.topic_pattern}</code>?
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
