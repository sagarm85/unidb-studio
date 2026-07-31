<script>
  import { getAuthMeta, getWhoami, getAuthzSnapshot, runSql, authLogin, authSignup, authRefresh, authLogout } from './api.js';

  // Authentication panel (Workstream G1 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  //
  // Live over the engine's real contract (item 121, merged via PR #222 on
  // unidb main): GET /auth/meta + GET /auth/whoami (item 100), user
  // create/delete with an optional password (`CREATE USER … PASSWORD '…'`
  // over /sql), and the full credentialed flow — POST /auth/{login,signup,
  // refresh,logout}. Per CLAUDE.md, nothing here is fabricated: what the
  // engine doesn't yet support is a clearly labeled "not available" card,
  // never a dead-looking form.
  //
  // Still NOT available (verified against unidb main's src/authz/mod.rs —
  // `Engine::set_password` exists but is Rust-only, no SQL/HTTP surface):
  // resetting an EXISTING user's password. Only set-at-creation works.
  // Also not available: listing a user's active sessions (only single-token
  // refresh/logout exist, no enumeration route), production issuer (A5),
  // and asymmetric JWT/JWKS (A6).
  //
  // Role/grant/membership editing (including the three built-in roles) is
  // the Roles tab's job (G3) — not duplicated here.

  let loading  = $state(true);
  let error    = $state(null);
  let meta     = $state(null); // GET /auth/meta
  let whoami   = $state(null); // GET /auth/whoami
  let users    = $state([]);   // [{name, isSuperuser}]
  let usersSupported = $state(true);

  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const [m, w, snap] = await Promise.all([getAuthMeta(), getWhoami(), getAuthzSnapshot()]);
      meta = m;
      whoami = w;
      usersSupported = snap.supported;
      users = snap.users;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  // ── users (create with optional password / delete) ───────────────────────
  let newUserOpen  = $state(false);
  let newUserName  = $state('');
  let newUserPass  = $state('');
  let newUserSuper = $state(false);
  let newUserBusy  = $state(false);
  let newUserError = $state(null);

  function sqlQuoteLiteral(s) {
    return `'${s.replace(/'/g, "''")}'`;
  }

  function openNewUser() {
    newUserError = null;
    newUserName = '';
    newUserPass = '';
    newUserSuper = false;
    newUserOpen = true;
  }

  async function submitNewUser() {
    newUserError = null;
    const n = newUserName.trim();
    if (!IDENT_RE.test(n)) { newUserError = 'Username must start with a letter/underscore and contain only letters, digits, underscore.'; return; }
    if (users.some((u) => u.name === n)) { newUserError = `User "${n}" already exists.`; return; }
    newUserBusy = true;
    try {
      let sql = `CREATE USER ${n}`;
      if (newUserSuper) sql += ' SUPERUSER';
      if (newUserPass) sql += ` PASSWORD ${sqlQuoteLiteral(newUserPass)}`;
      await runSql(sql);
      newUserOpen = false;
      await load();
    } catch (e) {
      newUserError = e.message ?? String(e);
    } finally {
      newUserBusy = false;
    }
  }

  async function deleteUser(name) {
    if (!confirm(`Drop user "${name}"? This revokes their credential, grants, and role memberships.`)) return;
    try {
      await runSql(`DROP USER ${name}`);
      await load();
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    }
  }

  // ── auth flow tester (POST /auth/{login,signup,refresh,logout}) ──────────
  // Tokens are kept only in this component's in-memory state — never
  // persisted (localStorage/cookies) and never swapped into the Studio's own
  // session token, which stays whatever the admin configured for the rest
  // of the app.
  let flowUsername = $state('');
  let flowPassword = $state('');
  let flowBusy     = $state(null); // 'login' | 'signup' | 'refresh' | 'logout' | null
  let flowError    = $state(null);
  let flowResult   = $state(null); // { accessToken, refreshToken, expiresIn } | null
  let flowRefreshInput = $state(''); // editable refresh token used by Refresh/Logout
  let logoutDone   = $state(false);
  let copiedField  = $state(null);

  function applyFlowResult(r) {
    flowResult = r;
    flowRefreshInput = r.refreshToken ?? '';
    logoutDone = false;
  }

  async function doLogin() {
    flowError = null; flowBusy = 'login'; logoutDone = false;
    try { applyFlowResult(await authLogin(flowUsername.trim(), flowPassword)); }
    catch (e) { flowError = e.message ?? String(e); }
    finally { flowBusy = null; }
  }
  async function doSignup() {
    flowError = null; flowBusy = 'signup'; logoutDone = false;
    try { applyFlowResult(await authSignup(flowUsername.trim(), flowPassword)); await load(); }
    catch (e) { flowError = e.message ?? String(e); }
    finally { flowBusy = null; }
  }
  async function doRefresh() {
    flowError = null; flowBusy = 'refresh'; logoutDone = false;
    try { applyFlowResult(await authRefresh(flowRefreshInput.trim())); }
    catch (e) { flowError = e.message ?? String(e); }
    finally { flowBusy = null; }
  }
  async function doLogout() {
    flowError = null; flowBusy = 'logout';
    try { await authLogout(flowRefreshInput.trim()); logoutDone = true; }
    catch (e) { flowError = e.message ?? String(e); }
    finally { flowBusy = null; }
  }

  async function copyField(field, value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copiedField = field;
      setTimeout(() => { if (copiedField === field) copiedField = null; }, 1500);
    } catch { /* clipboard unavailable — silently ignore */ }
  }

  // What's still genuinely unavailable — verified against unidb main source,
  // not assumed.
  const PENDING = [
    { name: 'Reset an existing user’s password', detail: 'Engine::set_password exists in Rust only — no ALTER USER … PASSWORD DDL or REST route yet. New users can still get a password at creation time (above).', ref: 'gap' },
    { name: 'List / revoke a user’s active sessions', detail: 'Only single-token refresh (rotate) and logout (revoke) exist — no GET route enumerates a user’s sessions.', ref: 'A4' },
    { name: 'Production token issuer', detail: 'Un-gate issuance from UNIDB_DEV_LOGIN behind an explicit signing-key config', ref: 'A5' },
    { name: 'Asymmetric JWT / JWKS', detail: 'RS256/ES256 verification + GET /.well-known/jwks.json', ref: 'A6' },
  ];
</script>

<div class="auth">
  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="err">{error.code}: {error.message}</p>
  {:else}
    <div class="grid">
      <section class="card">
        <h3>Server auth configuration</h3>
        {#if !meta?.supported}
          <p class="muted small">GET /auth/meta not available on this server.</p>
        {:else}
          <dl>
            <dt>Mode</dt>
            <dd>
              {#if meta.open_mode}
                <span class="pill warn">open mode — no users registered, everyone has full access</span>
              {:else}
                <span class="pill ok">enforced — per-user privileges active</span>
              {/if}
            </dd>
            <dt>Dev login (<code>POST /auth/login</code>)</dt>
            <dd>
              {#if meta.dev_login_enabled}
                <span class="pill warn">enabled — signing key configured</span>
              {:else}
                <span class="pill muted">disabled — no signing key, login/signup/refresh will error</span>
              {/if}
            </dd>
            <dt>Signup (<code>POST /auth/signup</code>)</dt>
            <dd>
              {#if meta.signup_enabled}
                <span class="pill warn">enabled — self-service account creation is open</span>
              {:else}
                <span class="pill muted">disabled (UNIDB_ALLOW_SIGNUP not set)</span>
              {/if}
            </dd>
            {#if meta.privilege_types?.length}
              <dt>Privilege types</dt>
              <dd class="mono">{meta.privilege_types.join(', ')}</dd>
            {/if}
          </dl>
        {/if}
      </section>

      <section class="card">
        <h3>Signed in as</h3>
        {#if !whoami?.supported}
          <p class="muted small">GET /auth/whoami not available on this server.</p>
        {:else}
          <dl>
            <dt>User</dt>
            <dd class="mono">{whoami.user ?? '(no identity — open mode / embedded)'}</dd>
            <dt>Superuser</dt>
            <dd>{whoami.is_superuser ? 'yes' : 'no'}</dd>
            <dt>Roles</dt>
            <dd>
              {#if whoami.roles?.length}
                <span class="chips">{#each whoami.roles as r}<span class="chip">{r}</span>{/each}</span>
              {:else}
                <span class="muted small">none</span>
              {/if}
            </dd>
            <dt>Table privileges</dt>
            <dd>
              {#if whoami.privileges?.length}
                <ul class="priv-list">
                  {#each whoami.privileges as p}
                    <li><span class="mono">{p.table}</span> — {p.ops?.join(', ')}</li>
                  {/each}
                </ul>
              {:else}
                <span class="muted small">none (or superuser — bypasses grants)</span>
              {/if}
            </dd>
          </dl>
        {/if}
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h3>Users</h3>
        <button class="ghost small-btn" onclick={openNewUser}>+ New user</button>
      </div>
      {#if !usersSupported}
        <p class="muted small">This server doesn't expose <code>unidb_catalog.users</code> yet.</p>
      {:else if users.length === 0}
        <p class="muted small">No users yet — server is in open mode.</p>
      {:else}
        <ul class="user-list">
          {#each users as u}
            <li>
              <span class="mono">{u.name}</span>
              {#if u.isSuperuser}<span class="pill super">superuser</span>{/if}
              <span class="grow"></span>
              <button class="del-btn" title="Drop user" onclick={() => deleteUser(u.name)}>✕</button>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="muted small foot-note">
        Password is optional at creation (needed only if this user will use password login/signup
        below). Role membership and table grants are managed in the <strong>Roles</strong> tab.
      </p>
    </section>

    <section class="card">
      <h3>Test the auth flow</h3>
      <p class="muted small">
        Exercises the real <code>POST /auth/{'{login,signup,refresh,logout}'}</code> routes.
        Tokens shown below live only in this panel's memory for this session — never persisted,
        never swapped into the Studio's own admin session token.
      </p>

      <div class="flow-grid">
        <div class="flow-form">
          <label class="field">
            <span class="flabel">Username</span>
            <input bind:value={flowUsername} placeholder="alice" spellcheck="false" />
          </label>
          <label class="field">
            <span class="flabel">Password</span>
            <input type="password" bind:value={flowPassword} />
          </label>
          <div class="flow-btns">
            <button onclick={doLogin} disabled={flowBusy !== null || !flowUsername || !flowPassword}>
              {flowBusy === 'login' ? 'Logging in…' : 'Login'}
            </button>
            <button
              class="ghost"
              onclick={doSignup}
              disabled={flowBusy !== null || !flowUsername || !flowPassword || !meta?.signup_enabled}
              title={meta?.signup_enabled ? '' : 'Disabled — server started without UNIDB_ALLOW_SIGNUP=1'}
            >
              {flowBusy === 'signup' ? 'Signing up…' : 'Signup'}
            </button>
          </div>
        </div>

        <div class="flow-form">
          <label class="field">
            <span class="flabel">Refresh token</span>
            <input bind:value={flowRefreshInput} placeholder="(from a login/signup/refresh above)" spellcheck="false" class="mono-input" />
          </label>
          <div class="flow-btns">
            <button onclick={doRefresh} disabled={flowBusy !== null || !flowRefreshInput}>
              {flowBusy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
            <button class="ghost" onclick={doLogout} disabled={flowBusy !== null || !flowRefreshInput}>
              {flowBusy === 'logout' ? 'Logging out…' : 'Logout (revoke)'}
            </button>
          </div>
          {#if logoutDone}<p class="ok-note">Revoked (204). Idempotent — safe to press again.</p>{/if}
        </div>
      </div>

      {#if flowError}<p class="err">{flowError}</p>{/if}

      {#if flowResult}
        <div class="token-out">
          <div class="token-row">
            <span class="flabel">Access token (JWT, expires in {flowResult.expiresIn}s)</span>
            <div class="token-value">
              <code class="mono truncate">{flowResult.accessToken}</code>
              <button class="copy-btn" onclick={() => copyField('access', flowResult.accessToken)}>
                {copiedField === 'access' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div class="token-row">
            <span class="flabel">Refresh token (opaque)</span>
            <div class="token-value">
              <code class="mono truncate">{flowResult.refreshToken}</code>
              <button class="copy-btn" onclick={() => copyField('refresh', flowResult.refreshToken)}>
                {copiedField === 'refresh' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      {/if}
    </section>

    <section class="card pending-card">
      <h3>Still not available</h3>
      <p class="muted small">
        Verified against unidb main's source (not assumed) — shown so nothing above pretends to
        cover ground it doesn't.
      </p>
      <ul class="pending-list">
        {#each PENDING as item}
          <li>
            <span class="pending-badge">{item.ref}</span>
            <div>
              <div class="pending-name">{item.name}</div>
              <div class="pending-detail">{item.detail}</div>
            </div>
            <span class="pill muted">not available</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<!-- ── New user modal ── -->
{#if newUserOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newUserOpen = false)}>
    <div class="modal" role="dialog" aria-label="New user" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New user</strong>
        <button class="x" onclick={() => (newUserOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Username</span>
          <input bind:value={newUserName} placeholder="e.g. alice" spellcheck="false" />
        </label>
        <label class="field">
          <span class="flabel">Password (optional — required for password login/signup)</span>
          <input type="password" bind:value={newUserPass} />
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={newUserSuper} />
          Superuser (bypasses all grants and RLS)
        </label>
        {#if newUserError}<p class="err">{newUserError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newUserOpen = false)}>Cancel</button>
        <button onclick={submitNewUser} disabled={newUserBusy}>
          {newUserBusy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .auth { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }

  .card {
    border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
    background: var(--panel);
  }
  .card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: var(--text); }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .card-head h3 { margin: 0; }

  dl { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  dt { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  dd { margin: 2px 0 0; font-size: 13px; }
  .mono { font-family: var(--mono); }

  .pill {
    display: inline-block; font-size: 11px; font-weight: 600; border-radius: 10px;
    padding: 2px 9px;
  }
  .pill.ok   { background: rgba(22,163,74,0.14); color: #15803d; }
  .pill.warn { background: rgba(217,119,6,0.14); color: #b45309; }
  .pill.muted { background: var(--panel-alt); color: var(--muted); }
  .pill.super { background: rgba(217,119,6,0.15); color: #b45309; font-size: 9px; text-transform: uppercase; padding: 1px 6px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: var(--mono); font-size: 11px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px;
  }
  .priv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }

  .user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .user-list li {
    display: flex; align-items: center; gap: 8px; padding: 6px 4px; font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .user-list li:last-child { border-bottom: none; }
  .grow { flex: 1; }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }
  .foot-note { margin-top: 10px; }

  .flow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 4px; }
  @media (max-width: 640px) { .flow-grid { grid-template-columns: 1fr; } }
  .flow-form { display: flex; flex-direction: column; gap: 8px; }
  .flow-btns { display: flex; gap: 8px; }
  .flow-btns button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input {
    padding: 7px 10px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .mono-input { font-family: var(--mono); }
  .check-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
  .ok-note { margin: 4px 0 0; font-size: 12px; color: #15803d; }

  .token-out { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .token-row { display: flex; flex-direction: column; gap: 3px; }
  .token-value { display: flex; align-items: center; gap: 8px; }
  .truncate {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 11px; background: var(--panel-alt); border-radius: 4px; padding: 4px 8px;
  }
  .copy-btn {
    background: none; border: 1px solid var(--border); border-radius: 5px;
    color: var(--muted); font-size: 11px; padding: 3px 9px; cursor: pointer; flex-shrink: 0;
  }
  .copy-btn:hover { color: var(--text); border-color: var(--accent); }

  .pending-card { background: var(--panel-alt); }
  .pending-list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .pending-list li {
    display: flex; align-items: center; gap: 10px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
  }
  .pending-badge {
    font-family: var(--mono); font-size: 10px; font-weight: 700; color: var(--muted);
    background: var(--panel-alt); border-radius: 4px; padding: 2px 6px; flex-shrink: 0;
  }
  .pending-name { font-size: 13px; font-weight: 600; }
  .pending-detail { font-size: 11px; color: var(--muted); margin-top: 1px; }
  .pending-list li > div:nth-child(2) { flex: 1; min-width: 0; }

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
    width: min(420px, 100%); display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3); overflow: hidden;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .modal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .x:hover { color: var(--err-fg); }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .small-btn { padding: 4px 10px; font-size: 12px; }
  .modal-foot button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
