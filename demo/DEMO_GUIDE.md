# unidb Studio — Demo Guide

> **Two parts:** Part 1 is setup (run before the audience arrives). Part 2 is the live script (follow in order during the demo).

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
until curl -sf http://localhost:8080/stats > /dev/null; do sleep 1; done && echo "Engine ready"
```

#### Path B — Full Docker

```bash
# From unidb-studio root
docker compose -f demo/docker-compose.demo.yml up -d --build
until curl -sf http://localhost:8080/stats > /dev/null; do sleep 2; done && echo "Engine ready"
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
python3 demo/embed_search.py
# Creates doc_embeddings table, uploads 6 docs to MinIO, inserts embeddings
```

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
| 1 | Engine running | `curl -sf http://localhost:8080/stats` → returns JSON |
| 2 | Studio loads | Open http://localhost:5173 — no "Not configured" banner |
| 3 | Schema visible | Studio → Schema tab → 6 table boxes with FK arrows |
| 4 | Data seeded | Studio → Records → customers → rows appear |
| 5 | Vector table ready | SQL editor: `SELECT COUNT(*) FROM doc_embeddings;` → 6 |
| 6 | Storage populated | Studio → Storage tab → `documents/` bucket with 6 files |
| 7 | Compare data ready | Studio → Compare tab → bar chart visible |

---

## Part 2 — Live demo script

Follow **in this order**. Each section has a time estimate and exact Studio navigation.

---

### Scene 1 — Schema: visual data model  *(2 min)*

**Studio → Schema tab**

What to say:
> "This is the live schema — FK relationships drawn automatically from the engine catalog. No separate ERD tool, no diagram that drifts from reality."

What to show:
- Six table nodes with FK arrows between them:
  ```
  customers ──< orders ──< order_items >── products
                  │
                  └──< invoices ──< payments
  ```
- Click a table node — FK edges highlight, column list appears
- "Add a table in SQL, hit refresh — it appears here immediately"

**Why this lands:** every team has a draw.io diagram that's six months out of date. unidb reads the actual catalog.

---

### Scene 2 — Records: browse live data  *(1 min)*

**Studio → Records → select `customers` from the sidebar**

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
- Open the `documents/` bucket — 6 text files uploaded by `embed_search.py`
- Click a file name to download via presigned URL

**Studio → Records → `doc_embeddings`**
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

### Scene 9 — Postgres comparison: bar chart  *(2 min)*

*Skip this scene if Step 7 of setup was skipped.*

**Studio → Compare tab**

What to show:
- Horizontal bar chart: unidb (accent colour) vs Postgres 16 (blue) per benchmark query
- Verdict banner: total elapsed time + speedup/slowdown ratio

For a more dramatic result, run a larger seed from the terminal and reload:
```bash
python3 demo/compare.py --size 50k
# Reload Studio → Compare tab
```

What to say:
> "Same schema, same queries, same hardware. The Compare tab writes a JSON file — any CI pipeline can track this over time."

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Studio shows "Not configured" | Check `.env.local`: `VITE_UNIDB_URL=http://localhost:8080` and `VITE_UNIDB_TOKEN=<token>` |
| Engine not starting | `tail /tmp/unidb.log` — port 8080 in use? Run Step 1 again |
| Schema tab shows no tables | Run `python3 demo/setup_schema.py` |
| Records tab shows no rows | Run `python3 demo/seed.py --size 50k` |
| `doc_embeddings` not found | Run `python3 demo/embed_search.py` |
| vec_distance COLUMN_NOT_FOUND | Remove `vec_distance` from WHERE — use it in SELECT only |
| Compare tab empty | Run `python3 demo/compare.py --size 10k` |
| Docker Hub TLS timeout on Path B | Switch to Path A (local binary) — `postgres:16-alpine` is a tiny image that almost always pulls; the Rust base image is the one that times out |
| Events tab shows nothing | Select table `orders`, click Enable, then Start — then run the script or SQL |

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
| `setup_schema.py` | Drop + recreate 6 tables with FK constraints |
| `seed.py --size N` | Bulk-insert e-commerce data |
| `benchmark.py` | 8 representative queries + engine latency stats |
| `compare.py --size N` | Benchmark unidb AND Postgres; write Compare tab data |
| `events_demo.py` | Enable CDC on `orders`, fire INSERT / UPDATE / DELETE |
| `vector_demo.py` | VECTOR table + HNSW index + NEAR() product search |
| `embed_search.py` | Upload 6 docs to MinIO, embed, semantic NEAR() search |

**Studio tabs at a glance**

| Tab | What to show |
|-----|-------------|
| Schema | FK relationship graph — always live from the engine catalog |
| Records | Browse + paginate any table; click a row for full detail |
| SQL editor | Live queries; Embed button converts text → NEAR() vector |
| Observability → Overview | WAL, commits/sec, cache hit rate, active transactions |
| Observability → Query Performance | p50/p99 per query kind + browser query history |
| Events | Real-time CDC stream — INSERT/UPDATE/DELETE in < 5 ms |
| Storage | MinIO bucket browser, file upload, presigned download |
| Compare | unidb vs Postgres bar chart |
| Logs | Structured request logs with correlation IDs |
