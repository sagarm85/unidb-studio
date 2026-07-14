#!/usr/bin/env python3
"""
demo/compare.py — side-by-side benchmark: unidb vs Postgres.

Usage:
  python3 demo/compare.py --size 10k
  python3 demo/compare.py --size 50k  --pg-dsn "host=localhost port=5432 dbname=demo user=demo password=demo"
  python3 demo/compare.py --size 1M   --unidb-url http://localhost:8080

Steps performed:
  1. Drop & recreate schema in BOTH databases (with FK constraints).
  2. Seed BOTH databases with identical data.
  3. Run benchmark queries on BOTH and measure round-trip time.
  4. Write results to  public/benchmark-results.json  (served by Studio).
  5. Print a side-by-side table to stdout.

Requirements:
  pip3 install psycopg2-binary     (or psycopg)
"""

import argparse, json, os, random, sys, time, urllib.request, urllib.error
from datetime import datetime
from pathlib import Path

HERE   = Path(__file__).parent
PUBLIC = HERE.parent / "public"

# ── unidb HTTP helper ────────────────────────────────────────────────────────
_token = None
_base  = None


def _unidb_token(base):
    """Fetch a fresh JWT from the Studio dev server's /__token endpoint, or fall
    back to the .env.local value. Call once and cache."""
    global _token
    if _token:
        return _token
    env_path = HERE.parent / ".env.local"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("VITE_UNIDB_TOKEN="):
                _token = line.split("=", 1)[1].strip()
                return _token
    # Hardcoded dev token (valid ~1yr from when it was minted)
    _token = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJzdWIiOiJkZXYiLCJleHAiOjE3ODQwMDk0NjJ9"
        ".bxaJIr8OLyeBxmPOFVaszPfKJF0sRxSAeUclm2G_Hbc"
    )
    return _token


def unidb_sql(base, sql):
    token = _unidb_token(base)
    req   = urllib.request.Request(
        f"{base}/sql",
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
    ms   = (time.perf_counter() - t0) * 1000
    rows = (body.get("results") or [{}])[0].get("rows", [])
    err  = body.get("error") or (body.get("results") or [{}])[0].get("error")
    return round(ms, 2), rows, err


def unidb_ddl(base, label, sql):
    _, _, err = unidb_sql(base, sql)
    if err and "not found" not in err.lower() and "already exists" not in err.lower():
        print(f"  ERR  {label}: {err}")
    else:
        print(f"  OK   {label}")


# ── Reference data (shared between unidb + pg seed) ─────────────────────────
CITIES    = ["New York","Los Angeles","Chicago","Houston","Phoenix","Philadelphia",
             "San Antonio","San Diego","Dallas","San Jose","London","Paris","Berlin",
             "Tokyo","Sydney","Toronto","Mumbai","Singapore","Dubai","São Paulo"]
COUNTRIES = ["US","US","US","US","US","US","US","US","US","US",
             "GB","FR","DE","JP","AU","CA","IN","SG","AE","BR"]
CATEGORIES = ["Electronics","Clothing","Books","Home & Garden","Sports",
              "Beauty","Toys","Automotive","Food","Office"]
STATUSES   = ["pending","confirmed","shipped","delivered","cancelled"]
FIRST = ["James","Mary","John","Patricia","Robert","Jennifer","Michael","Linda",
         "William","Barbara","David","Susan","Richard","Jessica","Joseph","Sarah",
         "Thomas","Karen","Charles","Lisa","Emma","Noah","Olivia","Liam","Ava"]
LAST  = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis",
         "Wilson","Moore","Taylor","Anderson","Thomas","Jackson","White","Harris"]
PROD_NAMES = ["Wireless Headphones","Smart Watch","Running Shoes","Coffee Maker",
              "Yoga Mat","Laptop Stand","Mechanical Keyboard","LED Desk Lamp",
              "Water Bottle","Backpack","Bluetooth Speaker","Phone Case",
              "Sunglasses","Notebook","Pen Set","Resistance Bands","Air Purifier",
              "Scented Candle","Wall Clock","Throw Blanket"]

BASE_TS = int(datetime(2024, 1, 1).timestamp() * 1000)
DAY_MS  = 86_400_000


def escape(v):
    if v is None:                   return "NULL"
    if isinstance(v, bool):         return "1" if v else "0"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def rand_ts(rng, lo=0, hi=730):
    return BASE_TS - rng.randint(lo * DAY_MS, hi * DAY_MS)


SIZES = {
    "10k":  1_000,
    "50k":  5_000,
    "200k": 20_000,
    "1m":   100_000, "1M": 100_000,
}

BENCHMARK_QUERIES = [
    ("COUNT customers",
     "SELECT COUNT(*) FROM customers"),
    ("COUNT orders",
     "SELECT COUNT(*) FROM orders"),
    ("COUNT order_items",
     "SELECT COUNT(*) FROM order_items"),
    ("Orders: filter by status",
     "SELECT COUNT(*) FROM orders WHERE status = 'delivered'"),
    ("Top-10 customers by order count",
     """SELECT c.name, COUNT(o.id) AS n
        FROM customers c JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id, c.name ORDER BY n DESC LIMIT 10"""),
    ("Revenue by product category",
     """SELECT p.category, SUM(oi.line_total) AS revenue
        FROM order_items oi JOIN products p ON p.id = oi.product_id
        GROUP BY p.category ORDER BY revenue DESC"""),
    ("Unpaid invoices total",
     "SELECT SUM(total_amount) FROM invoices WHERE status != 'paid'"),
    ("Average order value",
     "SELECT AVG(total_amount) FROM orders"),
    ("Customers with most revenue",
     """SELECT c.name, SUM(o.total_amount) AS total
        FROM customers c JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id, c.name ORDER BY total DESC LIMIT 5"""),
]


# ── Schema DDL (identical for both databases) ─────────────────────────────────
SCHEMA_DDL = [
    ("DROP invoice_items",  "DROP TABLE IF EXISTS invoice_items"),
    ("DROP invoices",       "DROP TABLE IF EXISTS invoices"),
    ("DROP order_items",    "DROP TABLE IF EXISTS order_items"),
    ("DROP orders",         "DROP TABLE IF EXISTS orders"),
    ("DROP products",       "DROP TABLE IF EXISTS products"),
    ("DROP customers",      "DROP TABLE IF EXISTS customers"),
    ("customers", """CREATE TABLE customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      phone TEXT, city TEXT, country TEXT, created_at BIGINT NOT NULL)"""),
    ("products", """CREATE TABLE products (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      price REAL NOT NULL, stock_qty INTEGER NOT NULL,
      sku TEXT NOT NULL, created_at BIGINT NOT NULL)"""),
    ("orders", """CREATE TABLE orders (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL,
      status TEXT NOT NULL, total_amount REAL NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id))"""),
    ("order_items", """CREATE TABLE order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, qty INTEGER NOT NULL,
      unit_price REAL NOT NULL, line_total REAL NOT NULL,
      FOREIGN KEY (order_id)   REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id))"""),
    ("invoices", """CREATE TABLE invoices (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL, issued_at BIGINT NOT NULL,
      due_at BIGINT NOT NULL, paid_at BIGINT, total_amount REAL NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id))"""),
    ("invoice_items", """CREATE TABLE invoice_items (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, description TEXT NOT NULL,
      qty INTEGER NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id),
      FOREIGN KEY (product_id) REFERENCES products(id))"""),
]


def generate_seed_rows(n_cust, n_prod, n_ord, seed=42):
    """Generate all seed row tuples deterministically."""
    rng = random.Random(seed)
    rng2 = random.Random(99)

    cust_rows = []
    for i in range(n_cust):
        cid = i + 1
        idx = rng.randrange(len(CITIES))
        cust_rows.append((cid,
            f"{rng.choice(FIRST)} {rng.choice(LAST)}",
            f"user{cid}@example.com",
            f"+1-{rng.randint(200,999)}-{rng.randint(100,999)}-{rng.randint(1000,9999)}",
            CITIES[idx], COUNTRIES[idx], rand_ts(rng, 365, 730)))

    prod_rows = []
    for i in range(n_prod):
        pid = i + 1
        cat = rng.choice(CATEGORIES)
        prod_rows.append((pid,
            f"{rng.choice(PROD_NAMES)} {pid}", cat,
            round(rng.uniform(4.99, 999.99), 2),
            rng.randint(0, 5000),
            f"SKU-{cat[:3].upper()}-{pid:06d}",
            rand_ts(rng, 500, 1000)))

    ord_rows, oi_rows, inv_rows, ii_rows = [], [], [], []
    oi_id = inv_id = ii_id = 0
    for i in range(n_ord):
        oid = i + 1
        cid = rng.randint(1, n_cust)
        ts  = rand_ts(rng, 0, 365)
        n   = rng.randint(1, 5)
        total = 0.0
        for _ in range(n):
            oi_id += 1
            pid   = rng.randint(1, n_prod)
            qty   = rng.randint(1, 10)
            price = round(rng.uniform(4.99, 499.99), 2)
            lt    = round(qty * price, 2)
            total += lt
            oi_rows.append((oi_id, oid, pid, qty, price, lt))
        ord_rows.append((oid, cid, rng.choice(STATUSES), round(total, 2), ts))

        inv_id += 1
        issued = BASE_TS - rng2.randint(0, 365 * DAY_MS)
        due    = issued + 30 * DAY_MS
        paid   = issued + rng2.randint(1, 25) * DAY_MS if rng2.random() < 0.75 else None
        istatus = "paid" if paid else ("overdue" if rng2.random() < 0.3 else "issued")
        inv_rows.append((inv_id, oid, f"INV-{inv_id:08d}", issued, due, paid,
                         round(rng2.uniform(10, 5000), 2), istatus))
        for _ in range(rng2.randint(1, 3)):
            ii_id += 1
            pid2  = rng2.randint(1, n_prod)
            qty2  = rng2.randint(1, 5)
            price2= round(rng2.uniform(4.99, 299.99), 2)
            ii_rows.append((ii_id, inv_id, pid2, f"Product #{pid2} service",
                            qty2, price2, round(qty2 * price2, 2)))

    return cust_rows, prod_rows, ord_rows, oi_rows, inv_rows, ii_rows


def unidb_bulk_insert(base, table, cols, rows, batch=75):
    # 75 rows/call is the empirical sweet spot — see backlog item 32 for root cause.
    col_clause = ",".join(cols)
    errs = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i+batch]
        vals  = ",".join("(" + ",".join(escape(v) for v in row) + ")" for row in chunk)
        _, _, err = unidb_sql(base, f"INSERT INTO {table} ({col_clause}) VALUES {vals}")
        if err:
            errs += 1
            if errs <= 3:
                print(f"    ! unidb insert {table}: {err}", file=sys.stderr)
    return errs


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="unidb vs Postgres side-by-side benchmark")
    ap.add_argument("--size", default="10k",
                    choices=["10k","50k","200k","1M"],
                    help="Dataset size (default: 10k)")
    ap.add_argument("--unidb-url", default="http://localhost:8080",
                    help="unidb HTTP base URL")
    ap.add_argument("--pg-dsn",
                    default="host=localhost port=5432 dbname=demo user=demo password=demo",
                    help="Postgres DSN")
    ap.add_argument("--skip-setup",  action="store_true",
                    help="Skip schema creation + seeding (schema already ready)")
    ap.add_argument("--benchmark-only", action="store_true",
                    help="Alias for --skip-setup")
    args = ap.parse_args()

    # Import pg helper
    import pg as pg_helper
    if not pg_helper.available():
        print("  ! psycopg2 not found. Install: pip3 install psycopg2-binary")
        pg_conn = None
    else:
        try:
            pg_conn = pg_helper.connect(args.pg_dsn)
            print(f"  ✓ Postgres connected ({args.pg_dsn})")
        except Exception as e:
            print(f"  ! Could not connect to Postgres: {e}")
            pg_conn = None

    base = args.unidb_url
    size_key = args.size
    n_cust = SIZES.get(size_key.lower(), SIZES["10k"])
    n_prod = max(100, n_cust // 10)
    n_ord  = n_cust * 2
    flush  = 75   # empirical optimum — see backlog item 32 for root cause

    do_setup = not (args.skip_setup or args.benchmark_only)

    # ── Schema setup ──────────────────────────────────────────────────────────
    if do_setup:
        print(f"\n── Schema (unidb) ───────────────────────────────────────────────────────")
        for label, q in SCHEMA_DDL:
            unidb_ddl(base, label, q)

        if pg_conn:
            print(f"\n── Schema (postgres) ────────────────────────────────────────────────────")
            for label, q in SCHEMA_DDL:
                pg_helper.run_ddl(pg_conn, label, q)

        # ── Seed ──────────────────────────────────────────────────────────────
        print(f"\n── Generating {size_key} rows ({n_cust:,} customers) ─────────────────────")
        t0 = time.time()
        cust_rows, prod_rows, ord_rows, oi_rows, inv_rows, ii_rows = \
            generate_seed_rows(n_cust, n_prod, n_ord)
        print(f"  generated in {time.time()-t0:.1f}s")

        CUST_COLS = ["id","name","email","phone","city","country","created_at"]
        PROD_COLS = ["id","name","category","price","stock_qty","sku","created_at"]
        ORD_COLS  = ["id","customer_id","status","total_amount","created_at"]
        OI_COLS   = ["id","order_id","product_id","qty","unit_price","line_total"]
        INV_COLS  = ["id","order_id","invoice_number","issued_at","due_at","paid_at","total_amount","status"]
        II_COLS   = ["id","invoice_id","product_id","description","qty","unit_price","line_total"]

        print(f"\n── Seeding unidb ────────────────────────────────────────────────────────")
        t0 = time.time()
        for label, table, cols, rows in [
            ("customers",    "customers",    CUST_COLS, cust_rows),
            ("products",     "products",     PROD_COLS, prod_rows),
            ("orders",       "orders",       ORD_COLS,  ord_rows),
            ("order_items",  "order_items",  OI_COLS,   oi_rows),
            ("invoices",     "invoices",     INV_COLS,  inv_rows),
            ("invoice_items","invoice_items",II_COLS,   ii_rows),
        ]:
            ts = time.time()
            unidb_bulk_insert(base, table, cols, rows, batch=flush)
            print(f"  {label:<22} {len(rows):>8,} rows  {time.time()-ts:.1f}s")
        print(f"  total: {time.time()-t0:.1f}s")

        if pg_conn:
            print(f"\n── Seeding postgres ─────────────────────────────────────────────────────")
            t0 = time.time()
            for label, table, cols, rows in [
                ("customers",    "customers",    CUST_COLS, cust_rows),
                ("products",     "products",     PROD_COLS, prod_rows),
                ("orders",       "orders",       ORD_COLS,  ord_rows),
                ("order_items",  "order_items",  OI_COLS,   oi_rows),
                ("invoices",     "invoices",     INV_COLS,  inv_rows),
                ("invoice_items","invoice_items",II_COLS,   ii_rows),
            ]:
                ts = time.time()
                pg_helper.bulk_insert(pg_conn, table, cols, rows, batch=flush)
                print(f"  {label:<22} {len(rows):>8,} rows  {time.time()-ts:.1f}s")
            print(f"  total: {time.time()-t0:.1f}s")

    # ── Benchmark ─────────────────────────────────────────────────────────────
    print(f"\n── Benchmark queries ────────────────────────────────────────────────────")
    print(f"  {'Query':<40}  {'unidb':>10}  {'postgres':>10}  {'ratio':>7}")
    print(f"  {'-'*40}  {'-'*10}  {'-'*10}  {'-'*7}")

    results = []
    total_unidb = total_pg = 0.0

    for label, q in BENCHMARK_QUERIES:
        # unidb
        u_ms, u_rows, u_err = unidb_sql(base, q)
        u_val = u_rows[0][0] if (u_rows and len(u_rows[0]) == 1) else f"{len(u_rows)} rows"

        # postgres
        if pg_conn:
            p_ms, p_rows = pg_helper.run(pg_conn, q)
            p_val = p_rows[0][0] if (p_rows and len(p_rows[0]) == 1) else f"{len(p_rows)} rows"
            ratio = u_ms / p_ms if p_ms > 0 else None
            ratio_str = f"{ratio:.2f}×" if ratio else "—"
            pg_str = f"{p_ms:>9.1f}ms"
        else:
            p_ms = p_val = None
            ratio = None
            ratio_str = pg_str = "  n/a"

        total_unidb += u_ms
        if p_ms: total_pg += p_ms

        print(f"  {label:<40}  {u_ms:>9.1f}ms  {pg_str}  {ratio_str:>7}")

        results.append({
            "label":      label,
            "sql":        q,
            "unidb_ms":   round(u_ms, 2),
            "postgres_ms": round(p_ms, 2) if p_ms is not None else None,
            "unidb_result":    str(u_val),
            "postgres_result": str(p_val) if p_val is not None else None,
            "ratio":      round(ratio, 3) if ratio else None,
        })

    print(f"  {'-'*40}  {'-'*10}  {'-'*10}  {'-'*7}")
    ratio_total = total_unidb / total_pg if total_pg > 0 else None
    print(f"  {'TOTAL':<40}  {total_unidb:>9.1f}ms"
          f"  {total_pg:>9.1f}ms"
          f"  {f'{ratio_total:.2f}×' if ratio_total else '':>7}")

    # ── Write JSON for Studio ComparePanel ────────────────────────────────────
    output = {
        "run_at":  datetime.utcnow().isoformat() + "Z",
        "size":    size_key,
        "n_cust":  n_cust,
        "n_ord":   n_ord,
        "unidb_url":   base,
        "postgres_dsn": args.pg_dsn if pg_conn else None,
        "queries": results,
        "summary": {
            "unidb_total_ms":    round(total_unidb, 2),
            "postgres_total_ms": round(total_pg, 2) if total_pg else None,
            "ratio":             round(ratio_total, 3) if ratio_total else None,
            "note": "ratio = unidb / postgres (< 1 means unidb is faster)",
        },
    }

    PUBLIC.mkdir(exist_ok=True)
    out_path = PUBLIC / "benchmark-results.json"
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\n  → Results saved to {out_path.relative_to(HERE.parent)}")
    print(f"  → Open Studio → Compare tab to visualise\n")

    if pg_conn:
        pg_conn.close()


if __name__ == "__main__":
    main()
