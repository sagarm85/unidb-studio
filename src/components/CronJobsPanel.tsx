import { useCallback, useEffect, useState } from 'react';
import { Clock3, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { listCronJobs, upsertCronJob, deleteCronJob } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// Scheduled jobs — cron (item 144, net-new, no v1/Svelte precedent). Control-
// plane only: the scheduler is strictly a caller of the same execute_sql
// path every other statement uses. Superuser-only. No run *history* — only
// in-memory last-run status, reset on server restart, per REST_API.md.

interface CronJob {
  name: string;
  schedule: string;
  sql: string;
  enabled: boolean;
  run_as: string | null;
  last_run_at: number | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  run_count: number;
}

export function CronJobsPanel() {
  const [supported, setSupported] = useState(true);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await listCronJobs();
      setSupported(out.supported);
      setJobs(out.jobs as CronJob[]);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- create/edit ----
  const [formOpen, setFormOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [fName, setFName] = useState('');
  const [fSchedule, setFSchedule] = useState('0 3 * * *');
  const [fSql, setFSql] = useState('');
  const [fRunAs, setFRunAs] = useState('');
  const [fEnabled, setFEnabled] = useState(true);
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  function openCreate() {
    setEditingName(null);
    setFName('');
    setFSchedule('0 3 * * *');
    setFSql('');
    setFRunAs('');
    setFEnabled(true);
    setFError(null);
    setFormOpen(true);
  }
  function openEdit(j: CronJob) {
    setEditingName(j.name);
    setFName(j.name);
    setFSchedule(j.schedule);
    setFSql(j.sql);
    setFRunAs(j.run_as ?? '');
    setFEnabled(j.enabled);
    setFError(null);
    setFormOpen(true);
  }

  async function submitForm() {
    setFError(null);
    if (!fName.trim() || !fSql.trim() || !fSchedule.trim()) {
      setFError('name, schedule, and sql are all required.');
      return;
    }
    setFBusy(true);
    try {
      const payload: Record<string, unknown> = { name: fName.trim(), schedule: fSchedule.trim(), sql: fSql, enabled: fEnabled };
      if (fRunAs.trim()) payload.run_as = fRunAs.trim();
      await upsertCronJob(payload);
      toast.success(editingName ? 'Job updated' : 'Job created');
      setFormOpen(false);
      await load();
    } catch (e: any) {
      setFError(e?.message ?? String(e));
    } finally {
      setFBusy(false);
    }
  }

  async function quickToggleEnabled(j: CronJob) {
    try {
      await upsertCronJob({ name: j.name, schedule: j.schedule, sql: j.sql, enabled: !j.enabled, run_as: j.run_as ?? undefined });
      toast.success(j.enabled ? 'Disabled' : 'Enabled');
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  }

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteCronJob(deleteTarget);
      toast.success('Job deleted');
      setDeleteTarget(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  function fmtLastRun(j: CronJob) {
    if (!j.last_run_at) return 'never (this process)';
    return new Date(j.last_run_at).toLocaleString();
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  if (!loading && !supported) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">Scheduled jobs not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 144 (<code>/cron/jobs</code>). No fabricated data shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <Clock3 className="size-4" /> Scheduled jobs
        </h3>
        <div className="flex items-center gap-2">
          <button className={ghostBtnCls} onClick={load} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
          <button className={cn(btnCls, 'flex items-center gap-1')} onClick={openCreate}>
            <Plus className="size-3.5" /> New job
          </button>
        </div>
      </div>

      <PanelHelp
        summary="Run SQL on a cron schedule inside the database — pg_cron parity, no external scheduler."
        what={
          <>
            Register a job as <code>(name, schedule, sql, run_as?)</code>. Standard 5-field cron
            (<code>minute hour day-of-month month day-of-week</code>), evaluated in the server's local time at minute granularity.{' '}
            <code>run_as</code> narrows the job's SQL to that principal's own grants/RLS; blank = embedded/superuser identity. No run
            history is kept — only in-memory last-run status, reset on server restart. Superuser-only.
          </>
        }
        actions={[
          'New job → e.g. name "nightly-cleanup", schedule "0 3 * * *", SQL to run',
          'Toggle a job off/on or delete it; check the last-run status column',
        ]}
        routes={['GET /cron/jobs', 'POST /cron/jobs', 'DELETE /cron/jobs/{name}']}
      />

      {error && <ErrorBox error={error} />}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="m-0 text-sm text-text-light">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="m-0 text-sm text-text-light">No scheduled jobs.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((j) => (
              <div key={j.name} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-md font-semibold">{j.name}</span>
                  <Badge variant={j.enabled ? 'ok' : 'default'}>{j.enabled ? 'enabled' : 'disabled'}</Badge>
                  <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-xs">{j.schedule}</code>
                  {j.run_as && <Badge variant="outline">run_as: {j.run_as}</Badge>}
                  <div className="flex-1" />
                  <button className="text-sm text-text-muted hover:text-foreground" onClick={() => quickToggleEnabled(j)}>
                    {j.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="text-sm text-text-muted hover:text-foreground" onClick={() => openEdit(j)}>
                    Edit
                  </button>
                  <button className="text-text-muted hover:text-error" onClick={() => setDeleteTarget(j.name)}>
                    <X className="size-3.5" />
                  </button>
                </div>
                <pre className="m-0 truncate rounded-sm bg-secondary px-2 py-1 font-mono text-sm text-text-light">{j.sql}</pre>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span>last run: {fmtLastRun(j)}</span>
                  {j.last_status && <Badge variant={j.last_status === 'ok' ? 'ok' : 'error'}>{j.last_status}</Badge>}
                  <span>runs: {j.run_count}</span>
                  {j.last_error && <span className="text-error">{j.last_error}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => !open && setFormOpen(false)}>
        <DialogContent className="max-w-[560px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>{editingName ? `Edit ${editingName}` : 'New scheduled job'}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              name
              <input value={fName} onChange={(e) => setFName(e.target.value)} disabled={!!editingName} className={cn(inputCls, 'font-mono', editingName && 'opacity-60')} spellCheck={false} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              schedule (5-field cron)
              <input value={fSchedule} onChange={(e) => setFSchedule(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} placeholder="0 3 * * *" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              sql
              <Textarea value={fSql} onChange={(e) => setFSql(e.target.value)} spellCheck={false} className="min-h-24 font-mono" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              run_as (optional — blank = embedded/superuser identity)
              <input value={fRunAs} onChange={(e) => setFRunAs(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} />
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
              {fBusy ? 'Saving…' : editingName ? 'Save' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete job</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Delete scheduled job <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget}</code>?
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
