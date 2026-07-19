import { useEffect, useMemo, useState } from 'react';
import { getToken, setToken as setEngineToken } from '@/lib/engine/api.js';
import { cn } from '@/lib/utils';

// The generate flow talks to the dev server's /__token endpoint, which only
// exists under `npm run dev` — so the button is dev-only. Ported behavior
// 1:1 from src-v1/lib/TokenStatus.svelte.
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
    </span>
  );
}
