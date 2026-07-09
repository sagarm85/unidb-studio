# unidb studio

A standalone, dependency-light web UI that demonstrates the [unidb](../unidb)
database engine over its documented HTTP API. It is a **pure static SPA**
(Vite + Svelte) — no backend of its own. Every action is a `fetch` against a
reachable `unidb-server`.

It builds strictly against the engine's REST contract
([`../unidb/docs/REST_API.md`](../unidb/docs/REST_API.md)); it never touches the
engine source.

## What it does

Five panels, all over `POST /sql` and `GET /tables`:

1. **SQL editor** — a textarea + **Run** → `POST /sql`. Renders a results grid
   (rows), an affected-count (`inserted`/`updated`/`deleted`/`truncated`), or a
   DDL status. Failures surface the engine's `{ error, code }` verbatim.
2. **Tables sidebar** — `GET /tables` on load → a clickable list of `name` +
   column summary. One server = one database, presented as *database → tables*.
   Internal tables (`__events__`, …) are hidden. If the server doesn't have the
   `/tables` route yet, the sidebar degrades gracefully instead of erroring.
3. **Record browser** — click a table → `SELECT * FROM <t> ORDER BY <key>
   LIMIT 50`. **Next** does **keyset paging** (`WHERE <key> > $1 ORDER BY <key>
   LIMIT 50`, tracking the last key), preferring an indexed or `id` column. With
   no obvious key it **falls back to `LIMIT`/`OFFSET`**.
4. **Join / filter + timing** — the same editor shows **two clearly separated
   timings** and never conflates them:
   - `round-trip: X ms` — client wall time (`performance.now()` around the fetch).
   - `server exec: Y ms` — true engine execution time, from a **companion
     `EXPLAIN ANALYZE <query>` call** (SELECT/CTE queries only).
5. **CSV import + timing** — pick a `.csv` (row 1 = headers), choose a target
   table → rows are inserted **batched into one transaction per request**
   (many `;`-separated `INSERT`s in a single `POST /sql` body, per the contract's
   only multi-statement-atomicity mechanism). Reports total wall-clock and
   rows/sec.

## Configure it (point it at a server)

Config is read from `.env.local` at build/dev time and is **never hardcoded**:

```bash
cp .env.example .env.local
```

Set two variables:

| Variable            | Meaning                                             |
| ------------------- | --------------------------------------------------- |
| `VITE_UNIDB_URL`    | Base URL of a running `unidb-server` (e.g. `http://127.0.0.1:8080`) |
| `VITE_UNIDB_TOKEN`  | A dev-only HS256 JWT (see below)                    |

Then:

```bash
npm install
npm run dev      # dev server (Vite)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

`.env.local` is gitignored (it matches `*.local`); `.env.example` is committed.

> Vite only exposes `.env.local` values at build time — after editing it,
> restart `npm run dev`.

## Mint a dev JWT

The engine ships a pure-bash + `openssl` helper (no Python/PyJWT needed). Use
the **same secret the server was started with** (`UNIDB_JWT_SECRET`):

```bash
TOKEN=$(UNIDB_JWT_SECRET=dev-secret ../unidb/scripts/gen_jwt.sh dev 3600)
echo "VITE_UNIDB_TOKEN=$TOKEN" >> .env.local
```

Arguments are `[subject] [ttl_seconds]` (defaults `dev` / `3600`).

## Two honesty caveats

- **The dev token is dev-only.** It embeds trust in the shared HS256 secret. A
  token minted this way must **never** ship to a browser in production — anyone
  with the bundle could forge tokens. In production a *backend-for-frontend*
  holds the secret server-side and mints short-lived tokens per authenticated
  user. This UI puts the token in the browser purely for local demoing.
- **CSV import is per-row `INSERT`, not bulk `COPY`.** unidb has no `COPY`
  path over REST, so import issues one `INSERT` statement per row (batched into
  one transaction per request to cut round-trips). It is fine for demo-sized
  files, not for large data loads. Values are inserted as quoted string literals
  and coerced to each column's type by the engine.

## Notes / known limitations

- **Column names.** `POST /sql`'s `rows` result carries a `columns` array
  (output names in order — resolved names for projections, joins and
  aggregates; `"QUERY PLAN"` for `EXPLAIN`), which the grid uses directly for
  every query, editor included. For older servers that predate this enrichment
  the grid falls back to `GET /tables` names (record browser) or positional
  headers (`col 0`, `col 1`, …).
- **CORS.** The browser calls the server directly, so `unidb-server` must allow
  this origin. If requests fail with a network error, check CORS/binding.
- Requires a reachable server for live data. With no/invalid config the UI still
  loads and shows a clear "not configured" state rather than crashing.

## Stack

Vite + Svelte 5, no component library, no runtime dependencies beyond Svelte.
The entire wire contract lives in one module, [`src/lib/api.js`](src/lib/api.js).
