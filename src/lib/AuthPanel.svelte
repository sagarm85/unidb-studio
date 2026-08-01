<script>
  import {
    getAuthMeta, getWhoami, getAuthzSnapshot, runSql,
    authLogin, authSignup, authRefresh, authLogout,
    listSessions, revokeSession,
    mfaEnroll, mfaVerify, mfaChallenge, mfaDisable,
    getOauthProviders, oauthAuthorizeUrl, oauthCallback,
    BASE_URL,
  } from './api.js';

  // Authentication panel (Workstream G1 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  //
  // Live over the engine's real, fully-merged contract (items 100/121/122/4,
  // 127, 128, through PR #230 on unidb main):
  //   - GET /auth/meta + GET /auth/whoami (item 100).
  //   - Users: list/create-with-password/delete, plus reset-password for an
  //     EXISTING user via `ALTER USER … PASSWORD '…'` (item 4).
  //   - The full credentialed flow: POST /auth/{login,signup,refresh,logout},
  //     including the item-127 MFA-challenge branch (login returns
  //     `{mfa_required, challenge}` instead of a session when the user has
  //     TOTP enabled).
  //   - Active sessions: `unidb_catalog.sessions` (item 4) + revoke-by-id via
  //     `DELETE /auth/sessions/{id}`.
  //   - TOTP MFA (item 127, D4): enroll -> verify -> recovery codes -> disable,
  //     reflecting `whoami.mfa_enabled`.
  //   - OAuth social login (item 128, D1): "Sign in with Google/GitHub"
  //     against feature-detected providers.
  // Per CLAUDE.md, nothing here is fabricated: anything the engine doesn't
  // support is an explicit "not available" state, never a dead-looking form.
  //
  // Production issuer (A5, `UNIDB_JWT_SIGNING_KEY`) and asymmetric JWT/JWKS
  // (A6, `UNIDB_JWT_PUBLIC_KEY` + `GET /.well-known/jwks.json`) shipped in PR
  // #223 — surfaced in the server-config card via `GET /auth/meta`'s
  // `dev_login_enabled`, which now reflects either issuer path (verified in
  // `src/server/handlers.rs::get_auth_meta` — the field name is a holdover,
  // its meaning broadened; the UI label says so).
  //
  // Role/grant/membership editing (including the three built-in roles) is
  // the Roles tab's job (G3) — not duplicated here.
  //
  // QR rendering for MFA enrollment is deliberately NOT built: this SPA has
  // no backend, so rendering a QR from the `otpauth://` URI client-side
  // would mean either (a) vendoring a QR-encoding algorithm — a nontrivial,
  // easy-to-get-subtly-wrong piece of code (Reed–Solomon ECC, mask-pattern
  // scoring) that can't be scan-tested in this environment, so a silent bug
  // would ship a QR image that *looks* right but doesn't scan — or (b)
  // sending the TOTP secret to a third-party QR image API, a real
  // secret-exposure bug this codebase's engine-truthful/no-fabrication ethos
  // would reject outright. Every authenticator app also accepts the raw
  // base32 secret as manual entry, which is what's shown instead (both the
  // secret and the full `otpauth://` URI, copy-able) — a real degrade, not a
  // missing feature dressed up.

  let loading  = $state(true);
  let error    = $state(null);
  let meta     = $state(null); // GET /auth/meta
  let whoami   = $state(null); // GET /auth/whoami
  let users    = $state([]);   // [{name, isSuperuser}]
  let usersSupported = $state(true);
  let sessions = $state([]);   // [{sessionId, username, createdAt, expiresAt, revoked}]
  let sessionsSupported = $state(true);
  let oauthProviders = $state({ google: false, github: false });

  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  $effect(() => { load(); checkOauthCallback(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const [m, w, snap, sess, providers] = await Promise.all([
        getAuthMeta(), getWhoami(), getAuthzSnapshot(), listSessions(), getOauthProviders(),
      ]);
      meta = m;
      whoami = w;
      usersSupported = snap.supported;
      users = snap.users;
      sessionsSupported = sess.supported;
      sessions = sess.sessions;
      oauthProviders = providers;
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

  // ── reset an existing user's password (ALTER USER … PASSWORD, item 4) ────
  let resetTarget   = $state(null); // username, or null
  let resetPassword = $state('');
  let resetBusy      = $state(false);
  let resetError      = $state(null);

  function openReset(name) {
    resetTarget = name;
    resetPassword = '';
    resetError = null;
  }

  async function submitReset() {
    if (!resetPassword) { resetError = 'Enter a new password.'; return; }
    resetBusy = true;
    resetError = null;
    try {
      await runSql(`ALTER USER ${resetTarget} PASSWORD ${sqlQuoteLiteral(resetPassword)}`);
      resetTarget = null;
    } catch (e) {
      resetError = e.message ?? String(e);
    } finally {
      resetBusy = false;
    }
  }

  // ── active sessions (unidb_catalog.sessions + DELETE /auth/sessions/{id}) ─
  let revokeBusyId = $state(null); // sessionId currently revoking, or null
  let sessionsError = $state(null);

  // created_at/expires_at are epoch SECONDS (see api.js's listSessions doc).
  function fmtEpochSecs(secs) {
    if (secs == null) return '—';
    return new Date(secs * 1000).toLocaleString();
  }

  async function doRevokeSession(sessionId) {
    revokeBusyId = sessionId;
    sessionsError = null;
    try {
      await revokeSession(sessionId);
      const sess = await listSessions();
      sessionsSupported = sess.supported;
      sessions = sess.sessions;
    } catch (e) {
      sessionsError = e.message ?? String(e);
    } finally {
      revokeBusyId = null;
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

  // item 127: when the account being logged into has TOTP MFA enabled,
  // POST /auth/login returns {mfa_required, challenge, expires_in} instead
  // of a session — this holds that pending challenge until redeemed (or it
  // expires, 5 minutes) at POST /auth/mfa/challenge.
  let mfaLoginChallenge = $state(null); // { challenge, expiresIn } | null
  let mfaLoginCode      = $state('');
  let mfaLoginBusy      = $state(false);
  let mfaLoginError     = $state(null);

  function applyFlowResult(r) {
    flowResult = r;
    flowRefreshInput = r.refreshToken ?? '';
    logoutDone = false;
    mfaLoginChallenge = null;
  }

  async function doLogin() {
    flowError = null; flowBusy = 'login'; logoutDone = false; mfaLoginChallenge = null;
    try {
      const r = await authLogin(flowUsername.trim(), flowPassword);
      if (r.mfaRequired) {
        mfaLoginChallenge = { challenge: r.challenge, expiresIn: r.expiresIn };
        mfaLoginCode = '';
        mfaLoginError = null;
      } else {
        applyFlowResult(r);
      }
    }
    catch (e) { flowError = e.message ?? String(e); }
    finally { flowBusy = null; }
  }

  async function doMfaLoginChallenge() {
    if (!mfaLoginChallenge || !mfaLoginCode) return;
    mfaLoginBusy = true;
    mfaLoginError = null;
    try {
      applyFlowResult(await mfaChallenge(mfaLoginChallenge.challenge, mfaLoginCode.trim()));
    } catch (e) {
      mfaLoginError = e.message ?? String(e);
    } finally {
      mfaLoginBusy = false;
    }
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

  // ── TOTP MFA (item 127, D4) — enroll -> verify -> recovery codes; disable ─
  // Acts on the CALLER's own account (the token this Studio instance is
  // configured with), same as the "Signed in as" card above — not the users
  // list, which is a different identity's account.
  let mfaOpen        = $state(false);  // enroll modal
  let mfaStep        = $state('start'); // 'start' | 'verify' | 'done'
  let mfaSecret       = $state(null);
  let mfaOtpauthUrl   = $state(null);
  let mfaVerifyCode   = $state('');
  let mfaRecoveryCodes = $state([]);
  let mfaBusy         = $state(false);
  let mfaError        = $state(null);

  function openMfaEnroll() {
    mfaOpen = true;
    mfaStep = 'start';
    mfaSecret = null;
    mfaOtpauthUrl = null;
    mfaVerifyCode = '';
    mfaRecoveryCodes = [];
    mfaError = null;
  }

  async function startMfaEnroll() {
    mfaBusy = true;
    mfaError = null;
    try {
      const out = await mfaEnroll();
      if (!out.supported) { mfaError = "This server doesn't expose POST /auth/mfa/enroll yet."; return; }
      mfaSecret = out.secret;
      mfaOtpauthUrl = out.otpauthUrl;
      mfaStep = 'verify';
    } catch (e) {
      mfaError = e.message ?? String(e);
    } finally {
      mfaBusy = false;
    }
  }

  async function submitMfaVerify() {
    if (!mfaVerifyCode) { mfaError = 'Enter the 6-digit code from your authenticator app.'; return; }
    mfaBusy = true;
    mfaError = null;
    try {
      const out = await mfaVerify(mfaVerifyCode.trim());
      mfaRecoveryCodes = out.recoveryCodes;
      mfaStep = 'done';
      await load(); // refresh whoami.mfa_enabled
    } catch (e) {
      mfaError = e.message ?? String(e);
    } finally {
      mfaBusy = false;
    }
  }

  function closeMfaEnroll() {
    mfaOpen = false;
  }

  let mfaDisableOpen  = $state(false);
  let mfaDisableCode  = $state('');
  let mfaDisableBusy  = $state(false);
  let mfaDisableError = $state(null);

  function openMfaDisable() {
    mfaDisableOpen = true;
    mfaDisableCode = '';
    mfaDisableError = null;
  }

  async function submitMfaDisable() {
    if (!whoami.is_superuser && !mfaDisableCode) {
      mfaDisableError = 'Enter a live TOTP or recovery code.';
      return;
    }
    mfaDisableBusy = true;
    mfaDisableError = null;
    try {
      await mfaDisable(mfaDisableCode.trim() || null);
      mfaDisableOpen = false;
      await load();
    } catch (e) {
      mfaDisableError = e.message ?? String(e);
    } finally {
      mfaDisableBusy = false;
    }
  }

  async function copyMfaField(field, value) {
    await copyField(field, value);
  }

  // ── OAuth 2.0 social login (item 128, D1) ─────────────────────────────────
  // "Sign in with Google/GitHub" is a REAL browser redirect
  // (GET /auth/oauth/{provider}/authorize -> 302 to the provider), not a
  // fetch — it navigates the whole tab away from the Studio. For the
  // callback to land back in THIS panel (a static SPA with no backend of
  // its own to run a server-side callback), the deployment's
  // `UNIDB_OAUTH_<PROVIDER>_REDIRECT_URI` needs to point back at the
  // Studio's own origin (e.g. `<studio-origin>/?tab=auth`) — App.svelte
  // already restores the `?tab=` on load, so that lands here. This module
  // then forwards the provider's `?code=&state=` to the engine's own
  // `GET /auth/oauth/{provider}/callback` as a plain (CORS) fetch to finish
  // the flow. This is a real, working integration when the redirect_uri is
  // configured that way — not assumed/fabricated behavior; if it isn't
  // configured that way (e.g. redirect_uri points straight at the engine),
  // the provider's callback response (raw JSON) just lands outside the SPA,
  // same as it would for any other backend-less static-SPA OAuth consumer.
  const OAUTH_PENDING_KEY = 'unidb_studio_oauth_pending_provider';
  let oauthError = $state(null);
  let oauthCallbackBusy = $state(false);

  function startOauth(provider) {
    try { sessionStorage.setItem(OAUTH_PENDING_KEY, provider); } catch { /* storage unavailable */ }
    window.location.href = oauthAuthorizeUrl(provider);
  }

  function stripOauthQueryParams() {
    const url = new URL(window.location.href);
    let changed = false;
    for (const k of ['code', 'state', 'error']) {
      if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
    }
    if (changed) history.replaceState({}, '', url.toString());
  }

  async function checkOauthCallback() {
    const params = new URLSearchParams(window.location.search);
    let pending = null;
    try { pending = sessionStorage.getItem(OAUTH_PENDING_KEY); } catch { /* storage unavailable */ }

    if (params.get('error')) {
      oauthError = `Provider denied the request: ${params.get('error')}`;
      try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* ignore */ }
      stripOauthQueryParams();
      return;
    }
    if (!params.has('code') || !params.has('state') || !pending) return;

    try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* ignore */ }
    oauthCallbackBusy = true;
    oauthError = null;
    try {
      applyFlowResult(await oauthCallback(pending, params.get('code'), params.get('state')));
      await load();
    } catch (e) {
      oauthError = e.message ?? String(e);
    } finally {
      oauthCallbackBusy = false;
      stripOauthQueryParams();
    }
  }

  // No remaining "not available" gaps for G1 as of PR #230 — password
  // reset, session listing/revoke, MFA enroll/verify/disable, and OAuth
  // sign-in are all live below (OAuth buttons are feature-detected per
  // provider and simply absent when unconfigured).
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
            <dt>Local token issuer (<code>login</code>/<code>signup</code>/<code>refresh</code>)</dt>
            <dd>
              {#if meta.dev_login_enabled}
                <span class="pill warn">enabled — UNIDB_DEV_LOGIN or UNIDB_JWT_SIGNING_KEY is set</span>
              {:else}
                <span class="pill muted">disabled — no signing key, login/signup/refresh will error</span>
              {/if}
            </dd>
            <dt>Asymmetric verify (<code>GET /.well-known/jwks.json</code>)</dt>
            <dd><a class="jwks-link" href="{BASE_URL}/.well-known/jwks.json" target="_blank" rel="noopener">{BASE_URL}/.well-known/jwks.json</a></dd>
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
            <dt>TOTP MFA (<code>whoami.mfa_enabled</code>)</dt>
            <dd>
              {#if whoami.mfa_enabled == null}
                <span class="muted small">not reported by this server (pre-item-127)</span>
              {:else if whoami.mfa_enabled}
                <span class="pill ok">enabled</span>
                <button class="link-btn" onclick={openMfaDisable}>Disable</button>
              {:else}
                <span class="pill muted">not enabled</span>
                <button class="link-btn" onclick={openMfaEnroll}>Enroll</button>
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
              <button class="link-btn" title="Reset password" onclick={() => openReset(u.name)}>Reset password</button>
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
      <h3>Active sessions</h3>
      {#if !sessionsSupported}
        <p class="muted small">This server doesn't expose <code>unidb_catalog.sessions</code> yet.</p>
      {:else if sessions.length === 0}
        <p class="muted small">No sessions yet — issue one via login/signup/refresh below.</p>
      {:else}
        {#if sessionsError}<p class="err small">{sessionsError}</p>{/if}
        <table class="session-table">
          <thead>
            <tr><th>Session</th><th>User</th><th>Created</th><th>Expires</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {#each sessions as s}
              <tr class:revoked-row={s.revoked}>
                <td class="mono session-id" title={s.sessionId}>{s.sessionId.slice(0, 12)}…</td>
                <td class="mono">{s.username}</td>
                <td class="small">{fmtEpochSecs(s.createdAt)}</td>
                <td class="small">{fmtEpochSecs(s.expiresAt)}</td>
                <td>
                  {#if s.revoked}
                    <span class="pill muted">revoked</span>
                  {:else}
                    <span class="pill ok">active</span>
                  {/if}
                </td>
                <td>
                  {#if !s.revoked}
                    <button class="link-btn" onclick={() => doRevokeSession(s.sessionId)} disabled={revokeBusyId === s.sessionId}>
                      {revokeBusyId === s.sessionId ? 'Revoking…' : 'Revoke'}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <p class="muted small foot-note">
        A superuser sees every session; a named non-superuser sees (and may revoke) only their own —
        server-enforced, not filtered client-side. Revoking here is per-session
        (<code>DELETE /auth/sessions/{'{id}'}</code>); the flow tester below still uses
        <code>POST /auth/logout</code> for the token you're currently holding.
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
          {#if mfaLoginChallenge}
            <div class="mfa-challenge">
              <p class="muted small">
                This account has MFA enabled — enter a live TOTP or recovery code to finish
                signing in (challenge expires in {mfaLoginChallenge.expiresIn}s).
              </p>
              <div class="mfa-challenge-row">
                <input
                  bind:value={mfaLoginCode}
                  placeholder="123456"
                  class="mono-input"
                  spellcheck="false"
                  onkeydown={(e) => e.key === 'Enter' && doMfaLoginChallenge()}
                />
                <button onclick={doMfaLoginChallenge} disabled={mfaLoginBusy || !mfaLoginCode}>
                  {mfaLoginBusy ? 'Verifying…' : 'Verify'}
                </button>
              </div>
              {#if mfaLoginError}<p class="err small">{mfaLoginError}</p>{/if}
            </div>
          {/if}
          {#if oauthProviders.google || oauthProviders.github}
            <div class="oauth-row">
              <span class="flabel">Or sign in with</span>
              <div class="oauth-btns">
                {#if oauthProviders.google}
                  <button class="ghost oauth-btn" onclick={() => startOauth('google')}>Google</button>
                {/if}
                {#if oauthProviders.github}
                  <button class="ghost oauth-btn" onclick={() => startOauth('github')}>GitHub</button>
                {/if}
              </div>
              <p class="muted small">
                Real browser redirect to <code>GET /auth/oauth/&lt;provider&gt;/authorize</code> —
                leaves this page. Lands back here only if this server's
                <code>_REDIRECT_URI</code> points at the Studio's own origin.
              </p>
            </div>
          {/if}
          {#if oauthCallbackBusy}<p class="muted small">Completing OAuth sign-in…</p>{/if}
          {#if oauthError}<p class="err small">{oauthError}</p>{/if}
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

<!-- ── Reset password modal ── -->
{#if resetTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (resetTarget = null)}>
    <div class="modal" role="dialog" aria-label="Reset password" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Reset password · {resetTarget}</strong>
        <button class="x" onclick={() => (resetTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">
          Runs <code>ALTER USER {resetTarget} PASSWORD '…'</code> (superuser-gated).
        </p>
        <label class="field">
          <span class="flabel">New password</span>
          <input type="password" bind:value={resetPassword} onkeydown={(e) => e.key === 'Enter' && submitReset()} />
        </label>
        {#if resetError}<p class="err">{resetError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (resetTarget = null)}>Cancel</button>
        <button onclick={submitReset} disabled={resetBusy}>{resetBusy ? 'Resetting…' : 'Reset password'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── MFA enroll modal (item 127) ── -->
{#if mfaOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={closeMfaEnroll}>
    <div class="modal" role="dialog" aria-label="Enroll MFA" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Enroll TOTP MFA</strong>
        <button class="x" onclick={closeMfaEnroll}>✕</button>
      </div>
      <div class="modal-body">
        {#if mfaStep === 'start'}
          <p class="muted small">
            Runs <code>POST /auth/mfa/enroll</code> for your own account ({whoami?.user}).
            Generates a fresh TOTP secret — not enabled yet until you confirm it below with a
            live code.
          </p>
          {#if mfaError}<p class="err">{mfaError}</p>{/if}
        {:else if mfaStep === 'verify'}
          <p class="muted small">
            Add this to your authenticator app (Google Authenticator, 1Password, Authy, …),
            then enter the 6-digit code it shows to confirm.
          </p>
          <label class="field">
            <span class="flabel">Secret (manual entry)</span>
            <div class="token-value">
              <code class="mono truncate">{mfaSecret}</code>
              <button class="copy-btn" onclick={() => copyMfaField('mfa-secret', mfaSecret)}>
                {copiedField === 'mfa-secret' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
          <label class="field">
            <span class="flabel">otpauth:// URI</span>
            <div class="token-value">
              <code class="mono truncate">{mfaOtpauthUrl}</code>
              <button class="copy-btn" onclick={() => copyMfaField('mfa-uri', mfaOtpauthUrl)}>
                {copiedField === 'mfa-uri' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
          <label class="field">
            <span class="flabel">6-digit code</span>
            <input
              bind:value={mfaVerifyCode}
              placeholder="123456"
              class="mono-input"
              spellcheck="false"
              onkeydown={(e) => e.key === 'Enter' && submitMfaVerify()}
            />
          </label>
          {#if mfaError}<p class="err">{mfaError}</p>{/if}
        {:else if mfaStep === 'done'}
          <p class="ok-note">MFA enabled. Save these one-time recovery codes now — shown only once,
            never re-fetchable.</p>
          <div class="recovery-codes">
            {#each mfaRecoveryCodes as c}<code class="mono">{c}</code>{/each}
          </div>
          <button class="ghost small-btn" onclick={() => copyMfaField('mfa-recovery', mfaRecoveryCodes.join('\n'))}>
            {copiedField === 'mfa-recovery' ? 'Copied' : 'Copy all'}
          </button>
        {/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        {#if mfaStep === 'start'}
          <button class="ghost" onclick={closeMfaEnroll}>Cancel</button>
          <button onclick={startMfaEnroll} disabled={mfaBusy}>{mfaBusy ? 'Starting…' : 'Start enrollment'}</button>
        {:else if mfaStep === 'verify'}
          <button class="ghost" onclick={closeMfaEnroll}>Cancel</button>
          <button onclick={submitMfaVerify} disabled={mfaBusy || !mfaVerifyCode}>{mfaBusy ? 'Verifying…' : 'Verify & enable'}</button>
        {:else}
          <button onclick={closeMfaEnroll}>Done</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- ── MFA disable modal (item 127) ── -->
{#if mfaDisableOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (mfaDisableOpen = false)}>
    <div class="modal" role="dialog" aria-label="Disable MFA" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Disable MFA</strong>
        <button class="x" onclick={() => (mfaDisableOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        {#if whoami?.is_superuser}
          <p class="muted small">
            Superuser emergency path — no code required (<code>POST /auth/mfa/disable</code>
            with an empty body).
          </p>
        {:else}
          <p class="muted small">Enter a live TOTP or recovery code to confirm.</p>
          <label class="field">
            <span class="flabel">Code</span>
            <input
              bind:value={mfaDisableCode}
              placeholder="123456 or a1b2c3-d4e5f6"
              class="mono-input"
              spellcheck="false"
              onkeydown={(e) => e.key === 'Enter' && submitMfaDisable()}
            />
          </label>
        {/if}
        {#if mfaDisableError}<p class="err">{mfaDisableError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (mfaDisableOpen = false)}>Cancel</button>
        <button onclick={submitMfaDisable} disabled={mfaDisableBusy}>{mfaDisableBusy ? 'Disabling…' : 'Disable MFA'}</button>
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
  .jwks-link { font-family: var(--mono); font-size: 12px; color: var(--accent); word-break: break-all; }

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
  .link-btn {
    background: none; border: none; color: var(--accent); cursor: pointer;
    font-size: 11px; padding: 0 4px;
  }
  .link-btn:hover { text-decoration: underline; }
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

  .session-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .session-table th, .session-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  .session-table th { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .session-table tr:last-child td { border-bottom: none; }
  .session-table tr.revoked-row { opacity: 0.6; }
  .session-id { white-space: nowrap; }

  .mfa-challenge {
    margin-top: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel-alt);
  }
  .mfa-challenge-row { display: flex; gap: 8px; margin-top: 6px; }
  .mfa-challenge-row input { flex: 1; min-width: 0; }
  .mfa-challenge-row button {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer; flex-shrink: 0;
  }

  .oauth-row { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .oauth-btns { display: flex; gap: 8px; }
  .oauth-btn { flex: 1; }

  .recovery-codes {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0;
  }
  .recovery-codes code {
    font-family: var(--mono); font-size: 12px; background: var(--panel-alt);
    border-radius: 4px; padding: 5px 8px; text-align: center;
  }

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
