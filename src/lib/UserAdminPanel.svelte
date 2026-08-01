<script>
  import { adminListUsers, adminCreateUser, adminUpdateUser, adminDeleteUser } from './api.js';

  // User management panel (item 142, PR #245) — Supabase-parity `auth.admin`
  // over the superuser-only /auth/admin/users/* surface. Every route is
  // superuser-gated server-side; a GET response never includes a password
  // hash or session detail (verified against REST_API.md's "Auth admin API"
  // section) — this panel never renders one because the server never sends
  // one. `banned`/`app_metadata`/`user_metadata` are new per-user state this
  // milestone adds on top of the existing users/roles/grants the Roles tab
  // (G3) already manages — user creation/deletion here is a genuine
  // alternative to that tab's CREATE/DROP USER path, not a duplicate: this
  // one additionally supports ban + metadata, which plain SQL DDL can't set.

  let loading   = $state(true);
  let error     = $state(null);
  let supported = $state(true);
  let users     = $state([]); // [{username, is_superuser, banned, roles, created_at, app_metadata, user_metadata}]
  let total     = $state(0);

  let limit  = $state(50);
  let offset = $state(0);

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const out = await adminListUsers({ limit, offset });
      supported = out.supported;
      users = out.users;
      total = out.total;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function nextPage() {
    if (offset + limit >= total) return;
    offset += limit;
    load();
  }
  function prevPage() {
    if (offset === 0) return;
    offset = Math.max(0, offset - limit);
    load();
  }

  function fmtCreatedAt(secs) {
    if (!secs) return '(unknown — predates item 142)';
    return new Date(secs * 1000).toLocaleString();
  }

  // ── new user modal ────────────────────────────────────────────────────────
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let newOpen   = $state(false);
  let newName   = $state('');
  let newPass   = $state('');
  let newSuper  = $state(false);
  let newBanned = $state(false);
  let newAppMeta  = $state('{}');
  let newUserMeta = $state('{}');
  let newBusy   = $state(false);
  let newError  = $state(null);

  function openNew() {
    newName = '';
    newPass = '';
    newSuper = false;
    newBanned = false;
    newAppMeta = '{}';
    newUserMeta = '{}';
    newError = null;
    newOpen = true;
  }

  function parseJsonField(text, label) {
    try {
      const v = JSON.parse(text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
      return v;
    } catch {
      throw new Error(`${label} must be a JSON object, e.g. {} or {"key":"value"}.`);
    }
  }

  async function submitNew() {
    newError = null;
    const username = newName.trim();
    if (!IDENT_RE.test(username)) { newError = 'Username must start with a letter/underscore and contain only letters, digits, underscore.'; return; }
    let appMeta, userMeta;
    try {
      appMeta = parseJsonField(newAppMeta, 'app_metadata');
      userMeta = parseJsonField(newUserMeta, 'user_metadata');
    } catch (e) { newError = e.message; return; }
    newBusy = true;
    try {
      const payload = { username, superuser: newSuper, banned: newBanned, app_metadata: appMeta, user_metadata: userMeta };
      if (newPass) payload.password = newPass;
      await adminCreateUser(payload);
      newOpen = false;
      await load();
    } catch (e) {
      newError = e.message ?? String(e);
    } finally {
      newBusy = false;
    }
  }

  // ── edit user modal ───────────────────────────────────────────────────────
  let editTarget   = $state(null); // user object, or null
  let editPass     = $state('');
  let editSuper    = $state(false);
  let editBanned   = $state(false);
  let editAppMeta  = $state('{}');
  let editUserMeta = $state('{}');
  let editBusy     = $state(false);
  let editError    = $state(null);

  function openEdit(u) {
    editTarget = u;
    editPass = '';
    editSuper = u.is_superuser;
    editBanned = u.banned;
    editAppMeta = JSON.stringify(u.app_metadata ?? {}, null, 2);
    editUserMeta = JSON.stringify(u.user_metadata ?? {}, null, 2);
    editError = null;
  }

  async function submitEdit() {
    editError = null;
    let appMeta, userMeta;
    try {
      appMeta = parseJsonField(editAppMeta, 'app_metadata');
      userMeta = parseJsonField(editUserMeta, 'user_metadata');
    } catch (e) { editError = e.message; return; }
    editBusy = true;
    try {
      const payload = {
        superuser: editSuper,
        banned: editBanned,
        app_metadata: appMeta,
        user_metadata: userMeta,
      };
      if (editPass) payload.password = editPass;
      await adminUpdateUser(editTarget.username, payload);
      editTarget = null;
      await load();
    } catch (e) {
      editError = e.message ?? String(e);
    } finally {
      editBusy = false;
    }
  }

  async function quickToggleBan(u) {
    try {
      await adminUpdateUser(u.username, { banned: !u.banned });
      await load();
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    }
  }

  // ── delete user ────────────────────────────────────────────────────────────
  let deleteTarget = $state(null); // username, or null
  let deleteBusy    = $state(false);
  let deleteError   = $state(null);

  async function confirmDelete() {
    deleteBusy = true;
    deleteError = null;
    try {
      await adminDeleteUser(deleteTarget);
      deleteTarget = null;
      await load();
    } catch (e) {
      // Surface the last-superuser lockout guard's 403 as-is — it's a real,
      // expected rejection, not a bug to swallow.
      deleteError = e.message ?? String(e);
    } finally {
      deleteBusy = false;
    }
  }
</script>

<div class="useradmin">
  {#if error}
    <div class="unsupported">
      <h3>Couldn't load users</h3>
      <p class="err">{error.code}: {error.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-5 6-6 8-6s6.5 1 8 6"/>
      </svg>
      <h3>User management not available</h3>
      <p>This server doesn't expose <code>GET /auth/admin/users</code> yet (needs item-142 support).</p>
    </div>
  {:else}
    <div class="toolbar">
      <strong class="toolbar-title">Users</strong>
      <span class="muted small">{total} total</span>
      <span class="grow"></span>
      <button onclick={openNew}>+ New user</button>
    </div>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if users.length === 0}
      <p class="muted">No users yet.</p>
    {:else}
      <table class="user-table">
        <thead>
          <tr>
            <th>Username</th><th>Roles</th><th>Status</th><th>Metadata</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each users as u}
            <tr class:banned-row={u.banned}>
              <td class="mono">
                {u.username}
                {#if u.is_superuser}<span class="pill super">superuser</span>{/if}
              </td>
              <td>
                {#if u.roles?.length}
                  <span class="chips">{#each u.roles as r}<span class="chip">{r}</span>{/each}</span>
                {:else}
                  <span class="muted small">none</span>
                {/if}
              </td>
              <td>
                {#if u.banned}<span class="pill warn">banned</span>{:else}<span class="pill ok">active</span>{/if}
              </td>
              <td>
                {#if Object.keys(u.app_metadata ?? {}).length || Object.keys(u.user_metadata ?? {}).length}
                  <span class="muted small" title="app_metadata: {JSON.stringify(u.app_metadata)}&#10;user_metadata: {JSON.stringify(u.user_metadata)}">
                    {Object.keys(u.app_metadata ?? {}).length} app / {Object.keys(u.user_metadata ?? {}).length} user
                  </span>
                {:else}
                  <span class="muted small">—</span>
                {/if}
              </td>
              <td class="small">{fmtCreatedAt(u.created_at)}</td>
              <td class="actions">
                <button class="link-btn" onclick={() => quickToggleBan(u)}>{u.banned ? 'Unban' : 'Ban'}</button>
                <button class="link-btn" onclick={() => openEdit(u)}>Edit</button>
                <button class="del-btn" title="Delete user" onclick={() => (deleteTarget = u.username)}>✕</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      <div class="pager">
        <button class="ghost" onclick={prevPage} disabled={offset === 0}>← Prev</button>
        <span class="muted small">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
        <button class="ghost" onclick={nextPage} disabled={offset + limit >= total}>Next →</button>
      </div>
    {/if}
  {/if}
</div>

<!-- ── New user modal ── -->
{#if newOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newOpen = false)}>
    <div class="modal" role="dialog" aria-label="New user" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New user</strong>
        <button class="x" onclick={() => (newOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Username</span>
          <input bind:value={newName} placeholder="e.g. alice" spellcheck="false" />
        </label>
        <label class="field">
          <span class="flabel">Password (optional)</span>
          <input type="password" bind:value={newPass} />
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={newSuper} />
          Superuser
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={newBanned} />
          Banned (created but immediately blocked from logging in)
        </label>
        <label class="field">
          <span class="flabel">app_metadata (JSON, admin-only)</span>
          <textarea bind:value={newAppMeta} rows="2" class="mono-input" spellcheck="false"></textarea>
        </label>
        <label class="field">
          <span class="flabel">user_metadata (JSON)</span>
          <textarea bind:value={newUserMeta} rows="2" class="mono-input" spellcheck="false"></textarea>
        </label>
        {#if newError}<p class="err">{newError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newOpen = false)}>Cancel</button>
        <button onclick={submitNew} disabled={newBusy}>{newBusy ? 'Creating…' : 'Create user'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Edit user modal ── -->
{#if editTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (editTarget = null)}>
    <div class="modal" role="dialog" aria-label="Edit user" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Edit · {editTarget.username}</strong>
        <button class="x" onclick={() => (editTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">New password (leave blank to keep current)</span>
          <input type="password" bind:value={editPass} />
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={editSuper} />
          Superuser
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={editBanned} />
          Banned
        </label>
        <label class="field">
          <span class="flabel">app_metadata (JSON, admin-only — replaces whole value)</span>
          <textarea bind:value={editAppMeta} rows="3" class="mono-input" spellcheck="false"></textarea>
        </label>
        <label class="field">
          <span class="flabel">user_metadata (JSON — replaces whole value)</span>
          <textarea bind:value={editUserMeta} rows="3" class="mono-input" spellcheck="false"></textarea>
        </label>
        <p class="hint">
          Demoting the last remaining superuser, or unchecking superuser on the only one, is
          rejected server-side (<code>403</code>) — same lockout guard as deleting that account.
        </p>
        {#if editError}<p class="err">{editError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (editTarget = null)}>Cancel</button>
        <button onclick={submitEdit} disabled={editBusy}>{editBusy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Delete confirm ── -->
{#if deleteTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (deleteTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Delete user</strong>
        <button class="x" onclick={() => (deleteTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">
          Delete <code>{deleteTarget}</code>? This revokes their credential, grants, role
          memberships, MFA enrollment, and OAuth identity links — same cleanup as
          <code>DROP USER</code>.
        </p>
        {#if deleteError}<p class="err">{deleteError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (deleteTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDelete} disabled={deleteBusy}>{deleteBusy ? 'Deleting…' : 'Delete user'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .useradmin { display: flex; flex-direction: column; gap: 14px; height: 100%; overflow-y: auto; padding: 16px 20px; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .toolbar { display: flex; align-items: center; gap: 10px; }
  .toolbar-title { font-size: 15px; }
  .grow { flex: 1; }
  .toolbar button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  }

  .user-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .user-table th, .user-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .user-table th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .user-table tr.banned-row { opacity: 0.65; }
  .mono { font-family: var(--mono); }

  .pill {
    display: inline-block; font-size: 10px; font-weight: 600; border-radius: 10px;
    padding: 1px 8px; margin-left: 6px;
  }
  .pill.ok   { background: rgba(22,163,74,0.14); color: #15803d; }
  .pill.warn { background: rgba(217,119,6,0.14); color: #b45309; }
  .pill.super { background: rgba(217,119,6,0.15); color: #b45309; text-transform: uppercase; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    font-family: var(--mono); font-size: 10px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px;
  }

  .actions { display: flex; gap: 8px; align-items: center; white-space: nowrap; }
  .link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 11px; padding: 0; }
  .link-btn:hover { text-decoration: underline; }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }

  .pager { display: flex; align-items: center; gap: 10px; }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  .ghost:disabled { opacity: 0.5; cursor: default; }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--err-fg); }

  /* ── modal (shared pattern) ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(440px, 100%); display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3); overflow: hidden; max-height: 90vh;
  }
  .del-modal { width: min(420px, 100%); }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .modal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input, .field textarea {
    padding: 7px 10px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .field textarea { resize: vertical; }
  .mono-input { font-family: var(--mono); }
  .field input:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .check-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
  .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }
  .del-msg { margin: 0; font-size: 13px; line-height: 1.6; }
  .del-msg code { font-family: var(--mono); background: var(--panel-alt); padding: 1px 5px; border-radius: 4px; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .x:hover { color: var(--err-fg); }
  .modal-foot button:not(.ghost):not(.del-btn) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .modal-foot .del-btn {
    background: var(--err-fg, #ef4444); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .modal-foot button:disabled { opacity: 0.5; cursor: default; }
</style>
