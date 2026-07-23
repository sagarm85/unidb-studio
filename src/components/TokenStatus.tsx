import { useCallback, useEffect, useMemo, useState } from 'react';
import { getToken, setToken as setEngineToken, fetchAuthMeta, devLogin } from '@/lib/engine/api.js';
import { cn } from '@/lib/utils';

// The generate flow talks to the dev server's /__token endpoint, which only
// exists under `npm run dev` — so the button is dev-only.
const canGenerate = import.meta.env.DEV;

function decodeExp(t: string): number | null {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// The `sub` claim is the only place "who am I" lives — decode it client-side
// (same as decodeExp) rather than round-tripping to GET /auth/whoami just to
// paint a badge. Absent `sub` is a real, meaningful state (implicit
// superuser, e.g. the .env.local static dev token), not an error.
function decodeSub(t: string): string | null {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function fmtRemaining(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export function TokenStatus() {
  const [token, setToken] = useState<string>(getToken());
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  const exp = useMemo(() => decodeExp(token), [token]);
  const sub = useMemo(() => decodeSub(token), [token]);
  const remaining = exp === null ? null : exp - now;
  const active = remaining !== null && remaining > 0;

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // `reload` is false for the silent auto-mint on mount (every fresh page
  // load would otherwise reload-loop) and true only when the button is
  // clicked by hand — same reasoning as login() below: switching the active
  // identity leaves every already-fetched tab stale, so a manual switch
  // needs a reload, an automatic first-mint on an empty page does not.
  async function generate(reload = false) {
    setMinting(true);
    setMintError(null);
    try {
      const res = await fetch('/__token');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      setEngineToken(out.token);
      setToken(out.token);
      if (reload) window.location.reload();
    } catch (e) {
      setMintError(e instanceof Error ? e.message : String(e));
    } finally {
      setMinting(false);
    }
  }

  useEffect(() => {
    if (canGenerate && !active) generate();
    // Mirrors v1's onMount-only auto-mint; intentionally not re-running on `active` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- dev-login fallback (item 100) ---------------------------------------
  // GET /auth/meta is public and works against any running server — dev
  // build, production preview, or a bare `vite build` bundle served with no
  // Vite proxy at all — unlike /__token above, which only exists under
  // `npm run dev`. This is what lets the Studio authenticate standalone
  // against a UNIDB_DEV_LOGIN=1 server. Deliberately manual (username input +
  // button), never auto-fired like /__token: unlike that route (which always
  // mints for the fixed dev-only "dev" subject), this one issues a token for
  // whatever username the caller types, so it must stay an explicit action.
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [username, setUsername] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    fetchAuthMeta()
      .then((m: any) => setDevLoginEnabled(!!m.dev_login_enabled))
      .catch(() => setDevLoginEnabled(false));
  }, []);

  const login = useCallback(async () => {
    const u = username.trim();
    if (!u) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const out: any = await devLogin(u);
      setEngineToken(out.token);
      setToken(out.token);
      // Every tab fetched its data once under the previous identity —
      // reload so all of them re-read it as the new one (see the
      // sessionStorage mirror in api.js that keeps this token past the
      // reload instead of falling back to the build-time env token).
      window.location.reload();
    } catch (e: any) {
      setLoginError(e?.message ?? String(e));
    } finally {
      setLoggingIn(false);
    }
  }, [username]);

  return (
    <span className="flex items-center gap-3">
      {/* Identity — the one thing everyone watching needs to read at a
          glance, so it's a plain sentence, not a bare badge + tooltip. */}
      <span className="flex items-center gap-1.5">
        {!token ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-warn" />
            <span className="text-xs whitespace-nowrap text-text-light">No token configured</span>
          </>
        ) : active ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-ok" />
            <span className="text-xs whitespace-nowrap text-text-light">
              Signed in as{' '}
              <b className={cn('font-mono font-semibold', sub ? 'text-brand' : 'text-warn')}>{sub ?? 'implicit superuser'}</b>
            </span>
            <span
              className={cn('text-xs whitespace-nowrap text-text-faint', remaining! < 300 && 'font-semibold text-warn')}
              title="Time until this session's token expires"
            >
              · expires in {fmtRemaining(remaining!)}
            </span>
          </>
        ) : (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-error" />
            <span className="text-xs whitespace-nowrap text-text-light">Session expired</span>
          </>
        )}
      </span>

      {canGenerate && (
        <button
          className={cn(
            'rounded-sm px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
            token && !active ? 'bg-brand-subtle text-brand hover:brightness-110' : 'text-text-light hover:bg-accent hover:text-foreground',
          )}
          onClick={() => generate(true)}
          disabled={minting}
          title="Mint a fresh dev token (superuser) from the local Vite dev server"
        >
          {minting ? 'Generating…' : token && !active ? 'Regenerate' : 'Generate'}
        </button>
      )}

      {mintError && (
        <span className="text-xs text-error" role="alert">
          {mintError}
        </span>
      )}

      {devLoginEnabled && (
        <span className="flex items-center gap-1.5">
          <span className="text-xs whitespace-nowrap text-text-muted">Switch user</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
            placeholder="username"
            spellCheck={false}
            title="Dev login — issues a real token for an existing user, no password. The page reloads afterward so every tab re-reads its data as that user."
            className="h-6 w-24 rounded-sm border border-border bg-secondary px-1.5 font-mono text-xs outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
          />
          <button
            className="rounded-sm bg-brand-subtle px-2 py-0.5 text-xs font-semibold text-brand whitespace-nowrap hover:brightness-110 disabled:opacity-45"
            onClick={login}
            disabled={loggingIn || !username.trim()}
          >
            {loggingIn ? 'Logging in…' : 'Login'}
          </button>
        </span>
      )}

      {loginError && (
        <span className="text-xs text-error" role="alert">
          {loginError}
        </span>
      )}
    </span>
  );
}
