import { useCallback, useEffect, useState } from 'react';
import { UserCog, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { adminListUsers, adminCreateUser, adminUpdateUser, adminDeleteUser } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// Superuser user-management panel (item 142) — /auth/admin/users CRUD.
// Distinct from AuthPanel's Roles/Grants (permission structure) and
// Sessions (per-session revoke) — this is bulk account administration:
// create/edit/ban/delete, with split app_metadata/user_metadata. Never
// renders a password hash or session token — the server never sends one on
// this route in the first place.

interface AdminUser {
  username: string;
  is_superuser: boolean;
  banned: boolean;
  roles: string[];
  created_at: number;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
}

const PAGE_SIZE = 50;

function fmtCreatedAt(secs: number) {
  if (!secs) return '(unknown — predates item 142)';
  return new Date(secs * 1000).toLocaleString();
}

function parseJsonField(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new Error(`${label} must be valid JSON object text`);
  }
}

export function UserAdminPanel() {
  const [supported, setSupported] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await adminListUsers({ limit: PAGE_SIZE, offset });
      setSupported(out.supported);
      setUsers(out.users as AdminUser[]);
      setTotal(out.total);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  function nextPage() {
    if (offset + PAGE_SIZE >= total) return;
    setOffset((o) => o + PAGE_SIZE);
  }
  function prevPage() {
    setOffset((o) => Math.max(0, o - PAGE_SIZE));
  }

  // ---- create ----
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newSuper, setNewSuper] = useState(false);
  const [newBanned, setNewBanned] = useState(false);
  const [newAppMeta, setNewAppMeta] = useState('{}');
  const [newUserMeta, setNewUserMeta] = useState('{}');
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);

  async function submitNew() {
    setNewError(null);
    let appMeta: Record<string, unknown>, userMeta: Record<string, unknown>;
    try {
      appMeta = parseJsonField(newAppMeta, 'app_metadata');
      userMeta = parseJsonField(newUserMeta, 'user_metadata');
    } catch (e: any) {
      setNewError(e.message);
      return;
    }
    setNewBusy(true);
    try {
      const payload: Record<string, unknown> = { username: newName.trim(), superuser: newSuper, banned: newBanned, app_metadata: appMeta, user_metadata: userMeta };
      if (newPass) payload.password = newPass;
      await adminCreateUser(payload);
      toast.success('User created');
      setNewOpen(false);
      setNewName('');
      setNewPass('');
      setNewSuper(false);
      setNewBanned(false);
      setNewAppMeta('{}');
      setNewUserMeta('{}');
      await load();
    } catch (e: any) {
      setNewError(e?.message ?? String(e));
    } finally {
      setNewBusy(false);
    }
  }

  // ---- edit ----
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [editPass, setEditPass] = useState('');
  const [editSuper, setEditSuper] = useState(false);
  const [editBanned, setEditBanned] = useState(false);
  const [editAppMeta, setEditAppMeta] = useState('{}');
  const [editUserMeta, setEditUserMeta] = useState('{}');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(u: AdminUser) {
    setEditing(u);
    setEditPass('');
    setEditSuper(u.is_superuser);
    setEditBanned(u.banned);
    setEditAppMeta(JSON.stringify(u.app_metadata ?? {}, null, 2));
    setEditUserMeta(JSON.stringify(u.user_metadata ?? {}, null, 2));
    setEditError(null);
  }

  async function submitEdit() {
    if (!editing) return;
    setEditError(null);
    let appMeta: Record<string, unknown>, userMeta: Record<string, unknown>;
    try {
      appMeta = parseJsonField(editAppMeta, 'app_metadata');
      userMeta = parseJsonField(editUserMeta, 'user_metadata');
    } catch (e: any) {
      setEditError(e.message);
      return;
    }
    setEditBusy(true);
    try {
      const payload: Record<string, unknown> = { superuser: editSuper, banned: editBanned, app_metadata: appMeta, user_metadata: userMeta };
      if (editPass) payload.password = editPass;
      await adminUpdateUser(editing.username, payload);
      toast.success('User updated');
      setEditing(null);
      await load();
    } catch (e: any) {
      // Surface the last-superuser lockout guard's 403 as-is.
      setEditError(e?.message ?? String(e));
    } finally {
      setEditBusy(false);
    }
  }

  async function quickToggleBan(u: AdminUser) {
    try {
      await adminUpdateUser(u.username, { banned: !u.banned });
      toast.success(u.banned ? 'Unbanned' : 'Banned');
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  }

  // ---- delete ----
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await adminDeleteUser(deleteTarget);
      toast.success('User deleted');
      setDeleteTarget(null);
      await load();
    } catch (e: any) {
      // Last-superuser-lockout 403 is real, surfaced verbatim — not reimplemented client-side.
      setDeleteError(e?.message ?? String(e));
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
        <h3 className="m-0 text-md font-semibold">User management not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 142 (<code>/auth/admin/users</code>). No fabricated data shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <UserCog className="size-4" /> Users
        </h3>
        <div className="flex items-center gap-2">
          <button className={ghostBtnCls} onClick={load} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
          <button className={cn(btnCls, 'flex items-center gap-1')} onClick={() => setNewOpen(true)}>
            <Plus className="size-3.5" /> New user
          </button>
        </div>
      </div>

      <PanelHelp
        summary="Superuser console to create and manage user accounts."
        what={
          <>
            Create users with or without a password (passwordless = OAuth/magic-link only), toggle <strong>Superuser</strong> and{' '}
            <strong>Banned</strong>, and edit two metadata blobs: <code>app_metadata</code> (admin-controlled, trusted — readable in RLS via{' '}
            <code>auth.jwt() -&gt;&gt; 'claim'</code>) vs <code>user_metadata</code> (user-editable profile). Banning blocks login/refresh
            (<code>403 USER_BANNED</code>) and revokes the user's sessions — disable without deleting. Superuser-only.
          </>
        }
        actions={[
          'New user → username, optional password, role/superuser/banned, metadata',
          'Ban / unban or flip superuser on an existing user',
        ]}
        routes={['GET /auth/admin/users', 'POST /auth/admin/users', 'PATCH /auth/admin/users/{id}', 'DELETE /auth/admin/users/{id}']}
      />

      {error && <ErrorBox error={error} />}

      <div className="flex-1 overflow-auto rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[1fr_120px_100px_140px_180px_170px] items-center gap-2 border-b border-border bg-secondary px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <span>Username</span>
          <span>Roles</span>
          <span>Status</span>
          <span>Metadata</span>
          <span>Created</span>
          <span />
        </div>
        {loading ? (
          <p className="m-0 p-3 text-sm text-text-light">Loading…</p>
        ) : users.length === 0 ? (
          <p className="m-0 p-3 text-sm text-text-light">No users.</p>
        ) : (
          users.map((u) => (
            <div key={u.username} className="grid grid-cols-[1fr_120px_100px_140px_180px_170px] items-center gap-2 border-b border-border-muted px-3 py-2 text-md last:border-b-0 hover:bg-accent">
              <span className="flex items-center gap-1.5 truncate font-mono" title={u.username}>
                {u.username}
                {u.is_superuser && <Badge variant="warn">SUPERUSER</Badge>}
              </span>
              <div className="flex flex-wrap gap-1">
                {u.roles.map((r) => (
                  <Badge key={r} variant="outline">
                    {r}
                  </Badge>
                ))}
              </div>
              <Badge variant={u.banned ? 'error' : 'ok'}>{u.banned ? 'banned' : 'active'}</Badge>
              <span className="text-sm text-text-light">
                app:{Object.keys(u.app_metadata ?? {}).length} user:{Object.keys(u.user_metadata ?? {}).length}
              </span>
              <span className="truncate text-sm text-text-light" title={fmtCreatedAt(u.created_at)}>
                {fmtCreatedAt(u.created_at)}
              </span>
              <div className="flex justify-end gap-2">
                <button className="text-sm text-text-muted hover:text-foreground" onClick={() => quickToggleBan(u)}>
                  {u.banned ? 'Unban' : 'Ban'}
                </button>
                <button className="text-sm text-text-muted hover:text-foreground" onClick={() => openEdit(u)}>
                  Edit
                </button>
                <button className="text-text-muted hover:text-error" onClick={() => setDeleteTarget(u.username)}>
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm text-text-muted">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button className={ghostBtnCls} onClick={prevPage} disabled={offset === 0}>
            ← Prev
          </button>
          <button className={ghostBtnCls} onClick={nextPage} disabled={offset + PAGE_SIZE >= total}>
            Next →
          </button>
        </div>
      )}

      {/* New user */}
      <Dialog open={newOpen} onOpenChange={(open) => !open && setNewOpen(false)}>
        <DialogContent className="max-w-[480px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New user</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Username
              <input value={newName} onChange={(e) => setNewName(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Password (optional — passwordless account reachable via OAuth/magic-link)
              <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} className={inputCls} />
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-md">
                <input type="checkbox" checked={newSuper} onChange={(e) => setNewSuper(e.target.checked)} /> Superuser
              </label>
              <label className="flex items-center gap-1.5 text-md">
                <input type="checkbox" checked={newBanned} onChange={(e) => setNewBanned(e.target.checked)} /> Banned
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              app_metadata (JSON)
              <Textarea value={newAppMeta} onChange={(e) => setNewAppMeta(e.target.value)} spellCheck={false} className="min-h-16 font-mono" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              user_metadata (JSON)
              <Textarea value={newUserMeta} onChange={(e) => setNewUserMeta(e.target.value)} spellCheck={false} className="min-h-16 font-mono" />
            </label>
            {newError && <p className="m-0 text-sm text-error">{newError}</p>}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setNewOpen(false)}>
              Cancel
            </button>
            <button className={btnCls} onClick={submitNew} disabled={newBusy || !newName.trim()}>
              {newBusy ? 'Creating…' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit user */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-[480px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Edit {editing?.username}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              New password (blank = unchanged)
              <input type="password" value={editPass} onChange={(e) => setEditPass(e.target.value)} className={inputCls} />
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-md">
                <input type="checkbox" checked={editSuper} onChange={(e) => setEditSuper(e.target.checked)} /> Superuser
              </label>
              <label className="flex items-center gap-1.5 text-md">
                <input type="checkbox" checked={editBanned} onChange={(e) => setEditBanned(e.target.checked)} /> Banned
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              app_metadata (JSON — whole-value replace)
              <Textarea value={editAppMeta} onChange={(e) => setEditAppMeta(e.target.value)} spellCheck={false} className="min-h-16 font-mono" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              user_metadata (JSON — whole-value replace)
              <Textarea value={editUserMeta} onChange={(e) => setEditUserMeta(e.target.value)} spellCheck={false} className="min-h-16 font-mono" />
            </label>
            {editError && <p className="m-0 text-sm text-error">{editError}</p>}
            <p className="m-0 text-xs text-text-muted">Demoting or deleting the last remaining superuser is rejected server-side (403).</p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className={ghostBtnCls} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className={btnCls} onClick={submitEdit} disabled={editBusy}>
              {editBusy ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete user</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              This will permanently delete <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteTarget}</code> and every
              associated membership/grant/credential/MFA/OAuth-link state. This cannot be undone.
            </p>
            {deleteError && <p className="mt-2 text-sm text-error">{deleteError}</p>}
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
