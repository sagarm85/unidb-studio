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
  const remaining = exp === null ? null : exp - now;
  const active = remaining !== null && remaining > 0;

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  async function generate() {
    setMinting(true);
    setMintError(null);
    try {
      const res = await fetch('/__token');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      setEngineToken(out.token);
      setToken(out.token);
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
    } catch (e: any) {
      setLoginError(e?.message ?? String(e));
    } finally {
      setLoggingIn(false);
    }
  }, [username]);

  return (
    <span className="flex items-center gap-2">
      {!token ? (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="text-xs whitespace-nowrap text-text-light">no token</span>
        </>
      ) : active ? (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-ok" />
          <span
            className={cn(
              'font-mono text-xs whitespace-nowrap text-text-light',
              remaining! < 300 && 'font-semibold text-warn',
            )}
            title="time until the token expires"
          >
            {fmtRemaining(remaining!)}
          </span>
        </>
      ) : (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-error" />
          <span className="text-xs whitespace-nowrap text-text-light">expired</span>
        </>
      )}

      {canGenerate && (
        <button
          className={cn(
            'rounded-sm px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
            token && !active ? 'bg-brand-subtle text-brand hover:brightness-110' : 'text-text-light hover:bg-accent hover:text-foreground',
          )}
          onClick={generate}
          disabled={minting}
        >
          {minting ? 'Generating…' : token && !active ? 'Regenerate' : 'Generate'}
        </button>
      )}

      {mintError && (
        <span className="text-xs text-error" role="alert">
          {mintError}
        </span>
      )}

      {devLoginEnabled && !active && (
        <span className="flex items-center gap-1">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
            placeholder="username"
            spellCheck={false}
            title="Dev login (UNIDB_DEV_LOGIN=1) — issues a token for an existing user, no password"
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
