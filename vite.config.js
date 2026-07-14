import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TOKEN_KEY = 'VITE_UNIDB_TOKEN'
const TTL_SECONDS = 3600
// Don't hand out a token about to die under the caller: below this remaining
// lifetime we mint a fresh one instead of returning the env token.
const MIN_REMAINING_SECONDS = 60

const b64url = (s) => Buffer.from(s).toString('base64url')

// Same shape as ../unidb/scripts/gen_jwt.sh: HS256, { sub, exp }.
function mintToken(secret, sub = 'dev', ttl = TTL_SECONDS) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const exp = Math.floor(Date.now() / 1000) + ttl
  const payload = b64url(JSON.stringify({ sub, exp }))
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${sig}`, exp }
}

function tokenExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

// Dev-only `GET /__token`. If the token already in .env.local is still active
// it is returned as-is (it's already the env value); otherwise a fresh dev JWT
// is minted with UNIDB_JWT_SECRET (default `dev-secret`, matching the README
// dev flow) and written back to .env.local so builds/restarts pick it up too.
// Never part of the production bundle — `apply: 'serve'` only.
function devTokenPlugin() {
  return {
    name: 'unidb-dev-token',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__token', (req, res) => {
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

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(out))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), devTokenPlugin()],
  server: { port: 5173, strictPort: true },
})
