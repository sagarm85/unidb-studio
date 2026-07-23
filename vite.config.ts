import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const TOKEN_KEY = 'VITE_UNIDB_TOKEN'
const TTL_SECONDS = 365 * 24 * 3600   // 1 year — dev token, never needs manual refresh
// Don't hand out a token about to die under the caller: below this remaining
// lifetime we mint a fresh one instead of returning the env token.
const MIN_REMAINING_SECONDS = 60

const b64url = (s: string) => Buffer.from(s).toString('base64url')

// Same shape as ../unidb/scripts/gen_jwt.sh: HS256, { sub, exp }.
function mintToken(secret: string, sub = 'dev', ttl = TTL_SECONDS) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const exp = Math.floor(Date.now() / 1000) + ttl
  const payload = b64url(JSON.stringify({ sub, exp }))
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${sig}`, exp }
}

function tokenExp(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

function readEnvVar(lines: string[], key: string): string {
  const line = lines.find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim() : ''
}

// Bootstrap-safety net: every Studio-minted token carries `sub: "dev"`. If
// "dev" isn't a registered superuser, the FIRST auth DDL anyone runs against
// this server (Auth tab, SQL editor, a script) flips it out of open/
// bootstrap mode and permanently locks every future dev-token request out of
// every superuser-gated route (GRANT, CREATE POLICY, the auth catalog reads)
// — with no recovery path from inside the app itself (confirmed the hard way
// against a live server: had to hand-mint a no-`sub` implicit-superuser JWT
// out of band to unstick it). Run once per `npm run dev` process, fire-and-
// forget, before the first /__token response, so the Studio's own dev token
// can never lock itself out.
let bootstrapAttempted = false
async function bootstrapDevSuperuser(baseUrl: string, token: string) {
  if (bootstrapAttempted || !baseUrl) return
  bootstrapAttempted = true
  try {
    const res = await fetch(`${baseUrl}/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'CREATE USER dev SUPERUSER' }),
    })
    if (res.ok) {
      console.log('[unidb-dev-token] bootstrapped "dev" as superuser')
      return
    }
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    if (body?.code === 'AUTHZ_ERROR' && /already exists/i.test(body?.error ?? '')) {
      return // already bootstrapped (by us on a prior run, or manually) — fine
    }
    if (body?.code === 'PERMISSION_DENIED') {
      console.warn(
        '[unidb-dev-token] could not bootstrap "dev" as superuser (permission denied) — ' +
          'another user/role was likely created first, exiting open mode. Auth-tab / GRANT / ' +
          'CREATE POLICY calls from this dev token will 403 until "dev" is manually granted ' +
          'SUPERUSER by an existing superuser token.',
      )
      return
    }
    console.warn(`[unidb-dev-token] bootstrap check failed: ${body?.error ?? res.statusText}`)
  } catch {
    // Server unreachable (e.g. unidb-server not started yet) — silent; the
    // rest of the Studio already surfaces connectivity errors on its own.
  }
}

// Dev-only `GET /__token`. If the token already in .env.local is still active
// it is returned as-is (it's already the env value); otherwise a fresh dev JWT
// is minted with UNIDB_JWT_SECRET (default `dev-secret`, matching the README
// dev flow) and written back to .env.local so builds/restarts pick it up too.
// Never part of the production bundle — `apply: 'serve'` only.
function devTokenPlugin(): Plugin {
  return {
    name: 'unidb-dev-token',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__token', (_req, res) => {
        const envPath = resolve(server.config.root, '.env.local')
        const lines = existsSync(envPath)
          ? readFileSync(envPath, 'utf8').split('\n')
          : []
        const idx = lines.findIndex((l) => l.startsWith(`${TOKEN_KEY}=`))
        const current = idx >= 0 ? lines[idx].slice(TOKEN_KEY.length + 1).trim() : ''
        const exp = current ? tokenExp(current) : null
        const now = Math.floor(Date.now() / 1000)

        let out
        if (exp && exp - now > MIN_REMAINING_SECONDS) {
          out = { token: current, exp, refreshed: false }
        } else {
          const secret = process.env.UNIDB_JWT_SECRET ?? 'dev-secret'
          out = { ...mintToken(secret), refreshed: true }
          const line = `${TOKEN_KEY}=${out.token}`
          if (idx >= 0) lines[idx] = line
          else lines.push(line)
          writeFileSync(envPath, lines.join('\n'))
        }

        bootstrapDevSuperuser(readEnvVar(lines, 'VITE_UNIDB_URL'), out.token)

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(out))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devTokenPlugin()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  server: { port: 5173, strictPort: true },
})
