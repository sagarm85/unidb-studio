# unidb Studio — Demo Guide

> **Two parts:** Part 1 is setup (run before the audience arrives). Part 2 is the live script (follow in order during the demo).

> **Studio is now the v2 React rewrite** (Vite + React 19 + TypeScript + Tailwind
> v4 + shadcn). The left nav is grouped into four sections — **Project Overview**,
> then **Database** (Table Editor · SQL Editor · Schema · CSV Import),
> **Platform** (Storage · Events · Auth · Users · Webhooks · Channel Authz ·
> Broadcast & Presence · Scheduled Jobs), **API** (API Docs · GraphQL), and
> **Monitor** (Observability · Logs · Compare). The old flat tab bar and the
> "Records" label are gone — "Records" is now **Table Editor**. The eight
> Platform/API panels below are new as of the 2026-08-01/02 Supabase-parity work
> (engine items 132–146); they are the second half of the demo.

---

## Part 1 — Pre-demo setup

Allow **15–20 minutes** before the demo. Run every step in order.

---

### Step 1 — Clean slate

```bash
# Stop local processes (unidb binary + Studio dev server)
pkill -f unidb-server-full 2>/dev/null || true
pkill -f vite 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
lsof -ti:8080 | xargs kill -9 2>/dev/null || true

# Stop Docker containers (releases ports 9000, 9001, 5432 safely)
docker rm -f pg-demo 2>/dev/null || true
docker compose -f demo/docker-compose.demo.yml down 2>/dev/null || true
docker compose -f docker/docker-compose.minio.yml down 2>/dev/null || true

# Wipe engine data
rm -rf /tmp/unidb-demo-data && mkdir -p /tmp/unidb-demo-data
```

---

### Step 2 — Start the stack

> Pick **Path A** or **Path B** — not both.

#### Path A — Local binary

```bash
cargo build --release -p unidb-server-full
docker compose -f docker/docker-compose.minio.yml up -d
curl -sf http://localhost:9000/minio/health/live && echo "MinIO ready"
docker run -d --name pg-demo \
  -e POSTGRES_USER=demo -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=demo \
  -p 5433:5432 postgres:16-alpine
until docker exec pg-demo pg_isready -U demo 2>/dev/null; do sleep 1; done && echo "Postgres ready"
nohup env \
  UNIDB_DATA_DIR=/tmp/unidb-demo-data \
  UNIDB_JWT_SECRET=dev-secret \
  UNIDB_REQUEST_TIMEOUT_SECS=300 \
  UNIDB_BUFFER_POOL_PAGES=1000000 \
  STORAGE_BACKEND=minio \
  STORAGE_S3_ENDPOINT=http://localhost:9000 \
  STORAGE_ACCESS_KEY=minioadmin \
  STORAGE_SECRET_KEY=minioadmin \
  STORAGE_BUCKET=unidb \
  STORAGE_FORCE_PATH_STYLE=true \
  ./target/release/unidb-server-full > /tmp/unidb.log 2>&1 < /dev/null &
until curl -sf http://localhost:8080/metrics > /dev/null; do sleep 1; done && echo "Engine ready"
```

#### Path B — Full Docker

```bash
# From unidb-studio root
docker compose -f demo/docker-compose.demo.yml up -d --build
until curl -sf http://localhost:8080/metrics > /dev/null; do sleep 2; done && echo "Engine ready"
```

---

### Step 4 — Start the Studio

```bash
# From unidb-studio root
nohup npm run dev > /tmp/studio.log 2>&1 < /dev/null &

until curl -sf http://localhost:5173 > /dev/null 2>&1; do sleep 1; done && echo "Studio ready"
```

Open **http://localhost:5173**

---

### Step 4b — Bootstrap the `dev` user as a superuser *(do not skip — the Auth/Users/Webhooks/Cron/Channel-Authz panels 403 without it)*

The Studio's dev token carries `sub: "dev"`. On a **clean** database (Step 1
wiped the data dir), the engine starts in open/bootstrap mode — but the moment
any auth-touching call runs with `sub: "dev"`, `dev` gets registered as a
**non-superuser** and the DB leaves bootstrap mode. From then on every
superuser-gated panel (Auth, Users, Webhooks, Scheduled Jobs, Channel Authz)
returns `403 PERMISSION_DENIED · user 'dev' must be a superuser`.

Prevent it by clicking **Generate token** in the Studio header **once, right
after the Studio loads and before you touch any Platform panel**. That fires the
dev-server's `/__token` middleware, which runs `CREATE USER dev SUPERUSER` while
the DB is still in bootstrap mode — permanently locking `dev` in as a superuser.

Verify:

```bash
TOK=$(grep '^VITE_UNIDB_TOKEN=' .env.local | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOK" http://localhost:8080/auth/whoami
# expect: {"user":"dev","is_superuser":true, ...}
```

If it already shows `"is_superuser": false` (you touched a Platform panel first),
see **Troubleshooting → "must be a superuser"** below for the one-time recovery.

---

### Step 5 — Seed the e-commerce schema

```bash
# From unidb-studio root
python3 demo/setup_schema.py          # creates 6 tables with FK constraints

python3 demo/seed.py --size 50k       # ~75k rows, ~4s  ← good default
# python3 demo/seed.py --size 200k   # ~300k rows, ~19s  ← larger demo
# python3 demo/seed.py --size 1M     # ~1.5M rows, ~1.5 min ← impressive numbers
```

---

### Step 6 — Load vector + document data

```bash
python3 demo/vector_demo.py
# Creates the `documents` table (title/content + VECTOR + HNSW index) — Scene 7

python3 demo/embed_search.py
# Creates `doc_embeddings`, uploads 6 docs to MinIO, inserts embeddings — Scene 8
```

> Two separate vector tables, two separate scenes: `vector_demo.py` builds
> **`documents`** (the Scene 7 NEAR() search) and `embed_search.py` builds
> **`doc_embeddings`** with the MinIO-backed source files (the Scene 8
> document-search story). Run both.

---

### Step 7 — Postgres comparison data

Postgres is already running from Step 2 (both Path A and Path B start it).  
Just run the benchmark script to seed both databases and write the Compare tab data:

```bash
python3 demo/compare.py --size 10k
# For more dramatic results: --size 50k or --size 200k
```

---

### Step 8 — Pre-demo checklist

Run through this before the audience arrives:

| # | Check | How to verify |
|---|-------|--------------|
| 1 | Engine running | `curl -sf http://localhost:8080/metrics` → returns Prometheus text |
| 2 | Studio loads | Open http://localhost:5173 — no "Not configured" banner |
| 3 | `dev` is superuser | `curl -s -H "Authorization: Bearer $TOK" http://localhost:8080/auth/whoami` → `"is_superuser":true` (Step 4b) |
| 4 | Schema visible | Studio → Schema tab → 6 table boxes with FK arrows |
| 5 | Data seeded | Studio → **Table Editor** → customers → rows appear |
| 6 | Vector tables ready | SQL editor: `SELECT COUNT(*) FROM documents;` and `SELECT COUNT(*) FROM doc_embeddings;` → both non-zero |
| 7 | Storage populated | Studio → Storage tab → `documents` bucket with 6 files (owner column shows `dev`) |
| 8 | Auth panel loads | Studio → Auth → Roles subtab lists users/roles (no 403 banner) |
| 9 | Compare data ready | Studio → Compare tab → bar chart visible (optional — see Scene 9 caveat) |
| 10 | Scene 0 works | `python3 demo/unified_txn_demo.py` → commit shows `delivered to consumer = 1`, rollback shows `= 0` |

---

## Part 2 — Live demo script

Follow **in this order**. Each section has a time estimate and exact Studio navigation.

---

### Scene 0 — The money scene: one transaction, four data models  *(4 min — lead with this)*

> **This is the demo.** Everything after it is supporting evidence. Open on the
> one thing unidb does that a Postgres + vector-store + graph-DB + queue stack
> *structurally cannot*: a single ACID transaction that writes a relational row,
> a vector embedding, and a graph edge — and emits exactly one change event —
> atomically. One `BEGIN`, one `COMMIT`, one WAL, one snapshot. If anything
> fails, all of it rolls back, across every model at once.

**Setup:** self-contained (creates its own `moat_order` / `moat_embedding`
tables + a graph edge; no seed needed). Requires `dev` to be a superuser
(Step 4b).

**Split screen: Studio → Events tab on the left, terminal on the right.**

Studio side: Events tab → select table `moat_order` → **Enable** → **Start**
(do this after the script's first run has created the table, or just narrate the
terminal).

Terminal side:
```bash
python3 demo/unified_txn_demo.py
```

What it prints, and what to say at each beat:

1. **The atomic write** — inside one `txn`, it INSERTs the order (relational),
   INSERTs its embedding (vector), and creates a `(customer)-[:PURCHASED]->(product)`
   edge (graph).
   > "Three different data models, one transaction id."
2. **Isolation** — a *second* connection queries the order mid-transaction and
   sees `count=0`.
   > "Uncommitted, so invisible — real snapshot isolation, not eventual anything."
3. **One commit** — after `COMMIT`, all three models are populated **and exactly
   one event was delivered to the CDC consumer** (watch it land on the Events tab):
   ```
   relational  moat_order rows      = 1
   vector      NEAR() top match     = order 1001
   graph       edges from cust 7    = 1
   event       delivered to consumer = 1  (op=insert, fired at commit)
   ```
4. **The rollback proof** — it does the same three-model write again, then
   `ROLLBACK`. Every model is clean and **no event fires**:
   ```
   relational rows=0 · vector rows=0 · graph edges=0 · event delivered=0
   ```
   > "One rollback undid a relational row, a vector, and a graph edge together.
   > No amount of app code makes four separate systems do that."

**Why this lands:** the same write against Postgres + Pinecone + Neo4j + Kafka is
four round-trips to four systems with **no shared commit and no shared
rollback** — a crash between them leaves the row, the embedding, the edge, and
the event permanently out of sync. unidb: one node, one WAL, one commit. All of
it, or none of it.

> Honesty note: the script measures the delivered-event count off the real SSE
> stream (`/events/subscribe?from_seq=`), **not** the `/events/head` sequence
> number — that seq is a monotonic *allocation* high-water mark and advances even
> for rolled-back writes; only committed events are ever delivered to a consumer.

---

### Scene 1 — Schema: visual data model  *(2 min)*

**Studio → Schema tab**

What to say:
> "This is the live schema — FK relationships drawn automatically from the engine catalog. No separate ERD tool, no diagram that drifts from reality."

What to show:
- Six table nodes with FK arrows between them:
  ```
  customers ──< orders ──< order_items >──┐
                  │                        ├── products
                  └──< invoices ──< invoice_items >──┘
  ```
  (`order_items` and `invoice_items` both reference `products`)
- Click a table node — FK edges highlight, column list appears
- "Add a table in SQL, hit refresh — it appears here immediately"

**Why this lands:** every team has a draw.io diagram that's six months out of date. unidb reads the actual catalog.

---

### Scene 2 — Table Editor: browse live data  *(1 min)*

**Studio → Table Editor → select `customers` from the sidebar**

What to show:
- 100 rows per page, paginated across all N rows
- Column filter (top-right input) — type a city name to narrow
- Click a row to expand the full record
- "All reads go through the same authenticated REST API your application uses"

---

### Scene 3 — SQL: analytics query  *(2 min)*

**Studio → SQL editor**

Run this first (simple, fast result):

```sql
SELECT p.category, SUM(oi.line_total) AS revenue
FROM order_items oi
JOIN products p ON p.id = oi.product_id
GROUP BY p.category
ORDER BY revenue DESC;
```

Then run the full 4-table analytics query:

```sql
-- Revenue and invoice breakdown per customer
SELECT
    c.id                 AS customer_id,
    c.name               AS customer_name,
    c.city,
    c.country,
    COUNT(o.id)          AS order_count,
    SUM(oi.line_total)   AS order_revenue,
    AVG(oi.unit_price)   AS avg_unit_price,
    COUNT(i.id)          AS invoice_count,
    SUM(i.total_amount)  AS total_invoiced,
    MAX(o.created_at)    AS last_order_at
FROM customers c
JOIN orders      o  ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id   = o.id
JOIN invoices    i  ON i.order_id    = o.id
GROUP BY c.id, c.name, c.city, c.country
HAVING COUNT(o.id) >= 2
ORDER BY order_revenue DESC
LIMIT 50000;
```

What to say:
> "Four-table join, GROUP BY, HAVING, ORDER BY across hundreds of thousands of rows. After this runs, switch to Observability to see the latency spike."

---

### Scene 4 — Observability: live engine metrics  *(2 min)*

**Studio → Observability tab → Overview**

What to point at:
- **Cache hit rate** — should be >90% after the join query above ran twice
- **WAL throughput** — spikes during writes, flat on reads
- **Active transactions** — watch it tick during the CDC demo later
- **Commits/sec** — flat right now (read-only workload)

What to say:
> "These charts update every 5 seconds from the engine's internal stats API. No external monitoring agent needed."

Run the 4-table query again while the Observability tab is visible — the cache hit chart responds in the next poll.

---

### Scene 5 — Query Performance: latency breakdown  *(1 min)*

**Studio → Observability tab → Query Performance**  *(click the subtab in the header)*

What to show:
- **Statement latency table** — p50 / p99 per query kind (SELECT, INSERT, UPDATE, DELETE)
  - SELECT p99 should show the spike from the JOIN query
- **Query history** — every SQL run from this browser session, with round-trip time in ms
  - Colour-coded: green < 50 ms, yellow 50–500 ms, red > 500 ms

---

### Scene 6 — Events: real-time CDC  *(2 min)*

**Split screen: Studio on the left, terminal on the right**

Studio side:
1. **Studio → Events tab**
2. Select table `orders` from the dropdown
3. Click **Enable**
4. Click **Start**

Terminal side:
```bash
python3 demo/events_demo.py
```

Watch in Studio:
- 3 × **INSERT** events appear immediately (new pending orders)
- 3 × **UPDATE** events (`pending → confirmed`)
- 1 × **DELETE** event

Click any event row → detail drawer opens with the full JSON payload (before/after values for UPDATE).

What to say:
> "Every committed write fires an SSE event in under 5 milliseconds. No polling, no Kafka, no change-data-capture middleware — it's built into the transaction log."

**Or demonstrate manually in the SQL editor:**

```sql
INSERT INTO orders (id, customer_id, status, total_amount, created_at)
VALUES (99999, 1, 'pending', 149.99, 1700000000);

UPDATE orders SET status = 'shipped' WHERE id = 99999;

DELETE FROM orders WHERE id = 99999;
```

---

### Scene 7 — Vector search: NEAR()  *(3 min)*

**Studio → SQL editor**

First show the data:
```sql
SELECT id, title FROM documents LIMIT 12;
```

Then show NEAR in action — use the **Embed button** (top-right of the SQL editor toolbar):
1. Click **Embed**
2. Type: `wireless headphones noise cancellation bluetooth`
3. Click **Insert** — a 64-dim float vector fills the cursor position
4. Complete the query and run:

```sql
SELECT id, title, vec_distance
FROM documents
WHERE NEAR(embedding, [...], 10);
```

Read the `vec_distance` column in results:

| vec_distance | Meaning |
|---|---|
| < 0.8 | Strong match |
| 0.8 – 1.3 | Plausible match |
| > 1.3 | Noise (hash collision) |

> `vec_distance` is available in SELECT only — never put it in WHERE.

What to say:
> "The Studio converts plain English to a 64-dimension vector client-side, no embedding service required. The engine uses an HNSW index to answer in microseconds. In production you'd swap our word-hash function for OpenAI or sentence-transformers — the SQL surface is identical."

---

### Scene 8 — Document search: Storage + embeddings  *(2 min)*

**Studio → Storage tab**
- Open the `documents` bucket — 6 text files uploaded by `embed_search.py`
- Note the **owner** column (`dev`, the JWT `sub` that uploaded them) and the
  bucket's **public/private** badge — per-object authorization is live (item 125,
  F1): private buckets are owner-only, public buckets readable-by-anyone,
  superuser/`service_role` bypasses both
- Click a file name to download via presigned URL

**Studio → Table Editor → `doc_embeddings`**
- Show title, source_key (MinIO path), snippet, and raw VECTOR column

**Studio → SQL editor**

```sql
SELECT title, source_key, vec_distance
FROM doc_embeddings
WHERE NEAR(embedding, [...], 6);
```

Use Embed button with: `crash recovery write ahead log durability`

What to say:
> "MinIO stores the raw files. unidb stores the vectors and metadata. NEAR() finds the closest documents in microseconds. The source_key links back to the original file in object storage."

---

### Scene 9 — Postgres comparison: bar chart  *(optional — read the caveat first)*

> **Framing warning (project `CLAUDE.md` §6 — do not skip this).** This tab is a
> **single-model CRUD** comparison, and on that workload unidb is *expected to
> lose* to Postgres (recent runs: ~5× slower on single-table analytics). That is
> by design — unidb rebuilds Postgres-class architecture *plus* three more models
> on one node; it is not trying to out-Postgres Postgres on Postgres's home turf.
> **Do not headline this scene as evidence unidb is "faster."** Leading with a
> chart where you're 5× behind undercuts the entire Scene-0 argument.

Use this tab **only** in one of two honest ways:

- **Skip it** in a moat-focused demo (recommended). Scene 0 is the argument; this
  isn't.
- **Reframe it** as the story that actually matters: the **cross-domain
  transactional** comparison — the write from Scene 0 (row + embedding + edge +
  event) costs unidb **one** commit, versus **four** network round-trips to four
  systems with no shared transaction for the Postgres + Pinecone + Neo4j + Kafka
  stack. That is the benchmark where unidb wins, and it's the same claim Scene 0
  makes qualitatively. (A dedicated cross-domain benchmark script is a TODO; until
  it lands, make the point verbally against Scene 0, not off this single-model
  bar chart.)

**Studio → Compare tab** (if shown): horizontal bar chart, unidb vs Postgres 16
per query, with the elapsed-time/ratio banner. If you show it, **say the quiet
part out loud** — "single-table CRUD is Postgres's strongest ground and we're in
its ballpark while also carrying vector + graph + queue; the win is Scene 0, not
this chart."

---

## Part 2b — Supabase-parity platform panels *(new, engine items 132–146)*

> This is the "one node replaces your whole backend" half of the demo: auth &
> RLS, a user-management console, a REST + GraphQL data API, realtime, webhooks,
> and cron — all over the **same** engine, the same transaction log, the same
> authorization surface. Everything here is live; nothing is mocked. All of these
> panels require `dev` to be a superuser (Step 4b).

### Scene 10 — Auth: roles, grants, RLS policies  *(4 min)*

**Studio → Auth tab** — seven subtabs across the top.

1. **Roles** — the users + roles list, a transitive role-membership editor, and a
   per-table **GRANT/REVOKE checkbox matrix**. The three built-ins
   (`anon` / `authenticated` / `service_role`) show read-only.
   > "This is Postgres-style RBAC — roles, membership, per-table privileges —
   > administered from the browser and enforced by the same engine that runs
   > your SQL."

2. **Policies** — create a row-level-security policy live:
   ```sql
   CREATE POLICY cust_self ON customers
     FOR SELECT TO authenticated
     USING (country = auth.jwt() ->> 'country');
   ```
   The helper buttons insert `current_user`, `auth.uid()`, and
   `auth.jwt() ->> 'claim'` (always parenthesised). Each existing policy shows its
   real `target_roles`.

3. **Preview** — `POST /auth/preview`: pick a user/role and run a query **as
   them**, seeing the RLS-filtered result. Run `SELECT * FROM customers` as an
   `authenticated` user vs. as `dev` (superuser bypass) to show the filter bite.

4. **Whoami** — `GET /auth/whoami`: the caller's identity/privileges (this is what
   Step 4b's check reads).

5. **Sessions** — `unidb_catalog.sessions` (id, user, created, expires, revoked —
   never a token/hash), with per-session **revoke** (`DELETE /auth/sessions/{id}`).

6. **Sign-in flows** — the credential tester: `POST /auth/{login,signup,refresh,
   logout}`, **TOTP MFA** enroll/verify/disable (the `otpauth://` URI + recovery
   codes are shown once), **OAuth** buttons for all seven presets (Google/GitHub/
   Apple/Microsoft/GitLab/Discord/Facebook — each self-hides when its provider
   isn't configured server-side), and **email flows** — password recovery and
   magic-link, each showing the uniform `{ok:true}` no-enumeration response, plus
   a live **dev-inbox viewer** (`GET/DELETE /auth/dev-inbox`, superuser-only) that
   reads back the captured email and fills the redemption token for you.

**Why this lands:** this is the whole Supabase auth stack — RBAC, RLS, sessions,
MFA, OAuth, magic-link — with no separate auth service and no second datastore.

---

### Scene 11 — Users: admin console  *(1 min)*

**Studio → Users tab** — superuser user management over `/auth/admin/users`.

- Click **New user**: username, optional password (blank = passwordless,
  OAuth/magic-link only), **Superuser** / **Banned** toggles, and
  `app_metadata` / `user_metadata` JSON.
  - `app_metadata` = admin-controlled, trusted claims (roles, plan tier) readable
    in RLS via `auth.jwt() ->> 'claim'`.
  - `user_metadata` = user-editable profile (display name, avatar).
- Create `sagarm` with a password, then hop to **Auth → Sign-in flows** and log in
  as that user to show the credential flow end-to-end.
- **Banned** blocks login/refresh (`403 USER_BANNED`) and revokes all the user's
  sessions — the "disable without deleting" switch.

---

### Scene 12 — API: REST + GraphQL data API  *(3 min)*

**Studio → API Docs tab**
- A live **OpenAPI 3** schema viewer generated from the engine's own
  `GET /rest/v1` document, with copy-paste curl snippets.
- The **GET/POST/PATCH/DELETE explorer** exercises the real PostgREST-style
  surface over `/rest/v1/<table>`: `select=` + embedded FK expansion, filter
  operators (`eq/neq/gt/gte/lt/lte/like/ilike/in/is`), `order=`/`limit`/`offset`,
  item 136's per-embed filter/order/limit, and item 139's `Prefer: count=exact`
  (→ `Content-Range`) and `return=representation|minimal` — the real response
  headers are shown.
  - Try: `GET /rest/v1/orders?select=id,status,customers(name,city)&status=eq.paid&order=id.desc&limit=5` with `Prefer: count=exact`.

**Studio → GraphQL tab**
- Schema browser from a real introspection query against `POST /graphql`
  (read **and** write — `insert_/update_/delete_<table>` mutation roots, item 133).
- The callout surfaces unidb's two differentiators over a relational-only
  pg_graphql: **`edges(type, direction)`** graph traversal and root
  **`near_<table>(vector, k)`** vector similarity — as first-class GraphQL fields
  alongside FK relationships.
- Run a starter query, then a mutation, and show the real `{data, errors}`
  envelope. Every mutation resolves through the same enforced SQL path as
  `/rest/v1` and `/sql`, so RLS / `WITH CHECK` / column grants apply identically.

**Why this lands:** one engine auto-generates both a REST and a GraphQL API from
the live catalog, and the GraphQL one can traverse graph edges and do vector
search — things a Postgres + pg_graphql stack cannot.

---

### Scene 13 — Realtime: Broadcast & Presence  *(2 min)*

**Studio → Broadcast & Presence tab** — a live SSE test client over
`/realtime/broadcast/*` and `/realtime/presence/*` (item 132).

- **Broadcast:** subscribe to a topic in one browser tab, publish a message from
  another — it arrives instantly over SSE.
- **Presence:** click **Track** to join a channel; open a second tab and watch the
  live join/leave/update map update on both.

> "Ephemeral by design — purely in-memory, per the engine contract. A server
> restart drops all broadcast/presence state; it never touches the WAL or heap."

**Studio → Channel Authz tab** — realtime channel authorization policies over
`/realtime/policies` (item 140): govern who may subscribe to which channel,
enforced by the same RLS engine.

---

### Scene 14 — Webhooks & Scheduled Jobs  *(2 min)*

**Studio → Webhooks tab** — database webhook management over `/webhooks`
(item 141, superuser-only).
- Register a hook: id, target URL, `table_pattern`, event list
  (`insert`/`update`/`delete`), and a signing secret. On every matching row change
  the engine POSTs the CDC envelope to the operator endpoint (HMAC-signed).
  > "Outbound HTTP on row change, straight from the transaction log — no Kafka,
  > no Debezium, no polling worker."

**Studio → Scheduled Jobs tab** — a `pg_cron`-parity surface over `/cron/jobs`
(item 144).
- Register `(name, schedule, sql, run_as?)` — e.g. nightly cleanup at 3am:
  ```
  name: nightly-cleanup   schedule: 0 3 * * *
  sql:  DELETE FROM sessions WHERE expires_at < now()
  ```
- Toggle/delete jobs, see last-run status. Optionally `run_as` a scoped role so
  RLS/grants apply. In-memory schedule state, reset on server restart (no
  persisted run history).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Studio shows "Not configured" | Check `.env.local`: `VITE_UNIDB_URL=http://localhost:8080` and `VITE_UNIDB_TOKEN=<token>` |
| Engine not starting | `tail /tmp/unidb.log` — port 8080 in use? Run Step 1 again |
| `PERMISSION_DENIED · must be a superuser` on Auth / Users / Webhooks / Cron / Channel Authz | `dev` was registered as a non-superuser before Step 4b ran. Recover once with an implicit-superuser (no-`sub`) token — drop and recreate `dev` as `SUPERUSER`. See the recovery block below. (Prevent it next time: run Step 4b before touching any Platform panel.) |
| Schema tab shows no tables | Run `python3 demo/setup_schema.py` |
| Table Editor shows no rows | Run `python3 demo/seed.py --size 50k` |
| `documents` table not found (Scene 7) | Run `python3 demo/vector_demo.py` |
| `doc_embeddings` not found (Scene 8) | Run `python3 demo/embed_search.py` |
| vec_distance COLUMN_NOT_FOUND | Remove `vec_distance` from WHERE — use it in SELECT only |
| Compare tab empty | Run `python3 demo/compare.py --size 10k` |
| Docker Hub TLS timeout on Path B | Switch to Path A (local binary) — `postgres:16-alpine` is a tiny image that almost always pulls; the Rust base image is the one that times out |
| Events tab shows nothing | Select table `orders`, click Enable, then Start — then run the script or SQL |
| OAuth buttons missing in Sign-in flows | Expected — each provider self-hides unless configured server-side (`UNIDB_OAUTH_<PROVIDER>_CLIENT_ID`/`_SECRET`) |
| Dev-inbox viewer absent / 404 | Superuser-only, and only present on the default `UNIDB_EMAIL_TRANSPORT=log` (never on a real-SMTP deployment) |
| Broadcast/Presence/Cron state vanished | Expected — all three are in-memory only and reset on every engine restart |

**Recovery: promote `dev` to superuser** (run from the `unidb` repo, uses your `UNIDB_JWT_SECRET`):

```bash
b64url(){ openssl base64 -A | tr '+/' '-_' | tr -d '='; }
H=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
P=$(printf '{"exp":9999999999}' | b64url)                    # no "sub" => implicit superuser
SU="$H.$P.$(printf '%s' "$H.$P" | openssl dgst -sha256 -hmac dev-secret -binary | b64url)"
curl -s -H "Authorization: Bearer $SU" -X POST http://localhost:8080/sql -H 'Content-Type: application/json' -d '{"sql":"DROP USER dev"}'
curl -s -H "Authorization: Bearer $SU" -X POST http://localhost:8080/sql -H 'Content-Type: application/json' -d '{"sql":"CREATE USER dev SUPERUSER"}'
curl -s -H "Authorization: Bearer $SU" http://localhost:8080/auth/whoami   # via the new dev: is_superuser:true
```

`DROP USER` is authz-only — it does **not** cascade to tables, rows, or storage
objects (the `owner:"dev"` tags are just metadata), so your seeded data is safe.
The existing `.env.local` token (`sub: "dev"`) automatically maps to the new
superuser `dev` — no token change needed.

---

## Quick reference

**Seed sizes**

| Flag | Approx rows | Time |
|------|------------|------|
| `--size 10k` | ~15k | ~1s |
| `--size 50k` | ~75k | ~4s |
| `--size 200k` | ~300k | ~19s |
| `--size 1M` | ~1.5M | ~1.5 min |
| `--size 5M` | ~4M | ~4 min |

**Scripts** (run from `unidb-studio` root)

| Script | Purpose |
|--------|---------|
| `unified_txn_demo.py` | **Scene 0** — one atomic txn across relational + vector + graph + event, plus the rollback proof (self-contained; needs `dev` superuser) |
| `setup_schema.py` | Drop + recreate 6 tables with FK constraints |
| `seed.py --size N` | Bulk-insert e-commerce data |
| `benchmark.py` | 8 representative queries + engine latency stats |
| `compare.py --size N` | Benchmark unidb AND Postgres; write Compare tab data |
| `events_demo.py` | Enable CDC on `orders`, fire INSERT / UPDATE / DELETE |
| `vector_demo.py` | VECTOR table + HNSW index + NEAR() product search |
| `embed_search.py` | Upload 6 docs to MinIO, embed, semantic NEAR() search |

**Studio tabs at a glance** (v2 grouped nav)

| Group | Tab | What to show |
|-------|-----|-------------|
| — | Project Overview | Stat cards + live metrics chart; quick links into the other tabs |
| Database | Table Editor | Browse + paginate any table; inline cell edit, insert/delete, CSV export |
| Database | SQL Editor | Live queries; saved/pinned queries; `EXPLAIN`/`EXPLAIN ANALYZE`; Embed button converts text → NEAR() vector |
| Database | Schema | FK relationship ERD — always live from the engine catalog; DDL view |
| Database | CSV Import | Batched per-row `INSERT` loader (demo-sized, not bulk `COPY`) |
| Platform | Storage | Object browser over `/storage/*`; owner column + public/private, per-object authz (item 125) |
| Platform | Events | Real-time CDC stream — INSERT/UPDATE/DELETE over SSE in < 5 ms |
| Platform | Auth | Roles · Grants · Policies · Preview · Whoami · Sessions · Sign-in flows (RBAC, RLS, MFA, OAuth, magic-link) |
| Platform | Users | Superuser user management over `/auth/admin/users` (create/ban/superuser/metadata) |
| Platform | Webhooks | Outbound-HTTP-on-row-change hooks over `/webhooks` (item 141) |
| Platform | Channel Authz | Realtime channel authorization policies over `/realtime/policies` (item 140) |
| Platform | Broadcast & Presence | Live SSE broadcast + presence test client (item 132; ephemeral) |
| Platform | Scheduled Jobs | `pg_cron`-parity job registration over `/cron/jobs` (item 144; in-memory) |
| API | API Docs | OpenAPI 3 viewer + GET/POST/PATCH/DELETE `/rest/v1` explorer (filters, embeds, `Prefer`) |
| API | GraphQL | Schema browser + query/mutation editor; `edges(...)` traversal + `near_<table>(...)` vector search |
| Monitor | Observability | WAL, commits/sec, cache hit rate, active transactions; Query Performance subtab (p50/p99 + history) |
| Monitor | Logs | Structured request logs with correlation IDs |
| Monitor | Compare | unidb vs Postgres bar chart |
