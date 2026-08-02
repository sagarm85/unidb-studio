import { useCallback, useEffect, useState } from 'react';
import { Webhook, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { listWebhooks, upsertWebhook, deleteWebhook } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// Database webhooks panel (item 141) — POST/GET/DELETE /webhooks.
// GET always redacts the signing secret to has_signing_secret:bool — this
// panel never fabricates or attempts to display the value itself.

interface WebhookRow {
  id: string;
  target_url: string;
  table_pattern: string;
  events: string[];
  enabled: boolean;
  has_signing_secret: boolean;
  headers?: Record<string, string>;
}

const EVENTS = ['insert', 'update', 'delete'] as const;

export function WebhooksPanel({ tables }: { tables: { name: string }[] }) {
  const [supported, setSupported] = useState(true);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await listWebhooks();
      setSupported(out.supported);
      setWebhooks(out.webhooks as WebhookRow[]);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- create/edit (single upsert form) ----
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fId, setFId] = useState('');
  const [fUrl, setFUrl] = useState('');
  const [fPattern, setFPattern] = useState('');
  const [fEvents, setFEvents] = useState<Set<string>>(new Set(['insert', 'update', 'delete']));
  const [fSecret, setFSecret] = useState('');
  const [fHeaders, setFHeaders] = useState('{}');
  const [fEnabled, setFEnabled] = useState(true);
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  function openCreate() {
    setEditingId(null);
    setFId('');
    setFUrl('');
    setFPattern('');
    setFEvents(new Set(['insert', 'update', 'delete']));
    setFSecret('');
    setFHeaders('{}');
    setFEnabled(true);
    setFError(null);
    setFormOpen(true);
  }
  function openEdit(w: WebhookRow) {
    setEditingId(w.id);
    setFId(w.id);
    setFUrl(w.target_url);
    setFPattern(w.table_pattern);
    setFEvents(new Set(w.events));
    setFSecret('');
    setFHeaders(JSON.stringify(w.headers ?? {}, null, 2));
    setFEnabled(w.enabled);
    setFError(null);
    setFormOpen(true);
  }
  function toggleEvent(e: string) {
    setFEvents((s) => {
      const next = new Set(s);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }

  async function submitForm() {
    setFError(null);
    if (!fId.trim() || !fUrl.trim() || !fPattern.trim() || fEvents.size === 0) {
      setFError('id, target_url, table_pattern, and at least one event are required.');
      return;
    }
    let headers: Record<string, string> | undefined;
    if (fHeaders.trim()) {
      try {
        headers = JSON.parse(fHeaders);
      } catch {
        setFError('headers must be valid JSON.');
        return;
      }
    }
    setFBusy(true);
    try {
      const payload: Record<string, unknown> = {
        id: fId.trim(),
        target_url: fUrl.trim(),
        table_pattern: fPattern.trim(),
        events: Array.from(fEvents),
        enabled: fEnabled,
      };
      if (headers) payload.headers = headers;
      if (fSecret) payload.signing_secret = fSecret;
      await upsertWebhook(payload);
      toast.success(editingId ? 'Webhook updated' : 'Webhook created');
      setFormOpen(false);
      await load();
    } catch (e: any) {
      setFError(e?.message ?? String(e));
    } finally {
      setFBusy(false);
    }
  }

  async function quickToggleEnabled(w: WebhookRow) {
    try {
      await upsertWebhook({
        id: w.id,
        target_url: w.target_url,
        table_pattern: w.table_pattern,
        events: w.events,
        enabled: !w.enabled,
      });
      toast.success(w.enabled ? 'Disabled' : 'Enabled');
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  }

  // ---- delete ----
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteWebhook(deleteTarget);
      toast.success('Webhook deleted');
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
        <h3 className="m-0 text-md font-semibold">Webhooks not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 141 (<code>/webhooks</code>). No fabricated data shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <Webhook className="size-4" /> Webhooks
        </h3>
        <div className="flex items-center gap-2">
          <button className={ghostBtnCls} onClick={load} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
          <button className={cn(btnCls, 'flex items-center gap-1')} onClick={openCreate}>
            <Plus className="size-3.5" /> New webhook
          </button>
        </div>
      </div>

      <PanelHelp
        summary="Fire an outbound HTTP POST to your own endpoint every time a row changes — no Kafka, no polling worker."
        what={
          <>
            Register a hook and unidb calls your URL straight from the transaction log whenever a matching row is
            inserted/updated/deleted. Body is the CDC envelope <code>{'{table, op, row, ts}'}</code>. With a signing secret,
            deliveries carry <code>X-Unidb-Signature: sha256=&lt;HMAC-SHA256(secret, raw body)&gt;</code>. At-least-once with ≤5
            retries, so a dead endpoint can't wedge the stream. The secret is never returned by <code>GET /webhooks</code> — only{' '}
            <code>has_signing_secret</code>. Superuser-only.
          </>
        }
        actions={[
          'New webhook → set an id, target URL, a table pattern, and which events to fire on',
          'Toggle a hook off/on or delete it; verify deliveries against your own receiver',
        ]}
        routes={['POST /webhooks', 'GET /webhooks', 'DELETE /webhooks/{id}']}
      />

      {error && <ErrorBox error={error} />}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="m-0 text-sm text-text-light">Loading…</p>
        ) : webhooks.length === 0 ? (
          <p className="m-0 text-sm text-text-light">No webhooks registered.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {webhooks.map((w) => (
              <div key={w.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-md font-semibold">{w.id}</span>
                  <Badge variant={w.enabled ? 'ok' : 'default'}>{w.enabled ? 'enabled' : 'disabled'}</Badge>
                  {w.has_signing_secret && <Badge variant="info">signed</Badge>}
                  <div className="flex-1" />
                  <button className="text-sm text-text-muted hover:text-foreground" onClick={() => quickToggleEnabled(w)}>
                    {w.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="text-sm text-text-muted hover:text-foreground" onClick={() => openEdit(w)}>
                    Edit
                  </button>
                  <button className="text-text-muted hover:text-error" onClick={() => setDeleteTarget(w.id)}>
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="truncate font-mono text-sm text-text-light" title={w.target_url}>
                  {w.target_url}
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-text-muted">{w.table_pattern}</span>
                  <div className="flex gap-1">
                    {w.events.map((e) => (
                      <Badge key={e} variant="outline">
                        {e}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => !open && setFormOpen(false)}>
        <DialogContent className="max-w-[520px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>{editingId ? `Edit ${editingId}` : 'New webhook'}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              id
              <input value={fId} onChange={(e) => setFId(e.target.value)} disabled={!!editingId} className={cn(inputCls, 'font-mono', editingId && 'opacity-60')} spellCheck={false} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              target_url
              <input value={fUrl} onChange={(e) => setFUrl(e.target.value)} className={inputCls} spellCheck={false} placeholder="https://example.com/hook" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              table_pattern
              <input value={fPattern} onChange={(e) => setFPattern(e.target.value)} list="webhook-tables" className={cn(inputCls, 'font-mono')} spellCheck={false} placeholder="orders or *" />
              <datalist id="webhook-tables">
                <option value="*" />
                {tables.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-text-light">events</span>
              <div className="flex gap-3">
                {EVENTS.map((e) => (
                  <label key={e} className="flex items-center gap-1.5 text-md">
                    <input type="checkbox" checked={fEvents.has(e)} onChange={() => toggleEvent(e)} /> {e}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              signing_secret (write-only — blank on edit = unchanged)
              <input type="password" value={fSecret} onChange={(e) => setFSecret(e.target.value)} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              headers (JSON, optional)
              <Textarea value={fHeaders} onChange={(e) => setFHeaders(e.target.value)} spellCheck={false} className="min-h-16 font-mono" />
            </label>
            <label className="flex items-center gap-1.5 text-md">
              <input type="checkbox" checked={fEnabled} onChange={(e) => setFEnabled(e.target.checked)} /> Enabled
            </label>
            {fError && <p className="m-0 text-sm text-error">{fError}</p>}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button className={btnCls} onClick={submitForm} disabled={fBusy}>
              {fBusy ? 'Saving…' : editingId ? 'Save' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete webhook</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Delete webhook <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget}</code>?
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
