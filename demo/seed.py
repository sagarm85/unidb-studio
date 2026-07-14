#!/usr/bin/env python3
"""
demo/seed.py — configurable bulk seeder for the e-commerce demo schema.

Uses POST /tables/{name}/bulk (item 32) — one txn + server-side loop per
chunk, ~5–6× faster than the old /sql multi-row VALUES approach.

Usage:
  python3 demo/seed.py --size 10k      # ~15 000 rows  (~15 sec)
  python3 demo/seed.py --size 50k      # ~75 000 rows  (~75 sec)
  python3 demo/seed.py --size 200k     # ~370 000 rows (~6 min)
  python3 demo/seed.py --size 1M       # ~1.86 M rows  (~28 min)

Prerequisites: run demo/setup_schema.py first.
"""

import argparse, json, random, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────
BASE  = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
SQL_HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
BULK_HDRS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/x-ndjson"}

# 5k rows/call for single-table ops (customers, products).
BULK_CHUNK = 5_000
# Orders/order_items chunk — each order generates 1-5 items so a batch of
# 5k orders yields ≤25k items. Kept equal to BULK_CHUNK; safe with the
# engine's UNIDB_REQUEST_TIMEOUT_SECS=300. Reduce to 1_000 on debug builds.
ORD_CHUNK  = 5_000

# Row counts (N_CUST), rest scales proportionally:
SIZES = {
    "10k":  1_000,
    "50k":  5_000,
    "200k": 20_000,
    "500k": 50_000,
    "1m":   100_000, "1M": 100_000,
}

# ── Reference data ────────────────────────────────────────────────────────────
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

BASE_DT = datetime(2024, 1, 1)
_SEC    = timedelta(seconds=1)


# ── HTTP helpers ──────────────────────────────────────────────────────────────
def run_sql(q):
    req = urllib.request.Request(f"{BASE}/sql",
          data=json.dumps({"sql": q}).encode(), headers=SQL_HDRS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def bulk_insert(table, rows_dicts, chunk=BULK_CHUNK):
    """POST NDJSON chunks to /tables/{table}/bulk. Returns total inserted."""
    total, errs = 0, 0
    for i in range(0, len(rows_dicts), chunk):
        chunk_rows = rows_dicts[i:i+chunk]
        body = "\n".join(json.dumps(r) for r in chunk_rows).encode()
        req  = urllib.request.Request(f"{BASE}/tables/{table}/bulk",
               data=body, headers=BULK_HDRS, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                resp = json.loads(r.read())
            total += resp.get("inserted", 0)
        except urllib.error.HTTPError as e:
            errs += 1
            body_err = json.loads(e.read())
            if errs <= 3:
                print(f"    ! bulk error {table}: {body_err.get('error','?')}", file=sys.stderr)
    return total


def rand_ts(rng, lo=0, hi=730):
    delta_secs = rng.randint(lo * 86400, hi * 86400)
    return (BASE_DT - timedelta(seconds=delta_secs)).strftime('%Y-%m-%d %H:%M:%S')


def progress(label, done, total, t0):
    ela  = time.time() - t0
    rate = done / ela if ela > 0 else 0
    eta  = (total - done) / rate if rate > 0 else 0
    pct  = done / total * 100
    print(f"  {label:<22} {done:>8,}/{total:,} ({pct:.0f}%)  "
          f"{ela:.0f}s  {rate:,.0f} rows/s  eta {eta:.0f}s")


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Seed the unidb e-commerce demo tables.")
    ap.add_argument("--size", default="10k",
                    help="10k | 50k | 200k | 500k | 1M  (default: 10k)")
    args = ap.parse_args()

    key = args.size.lower() if args.size.lower() in SIZES else args.size
    if key not in SIZES:
        sys.exit(f"Unknown size '{args.size}'. Choose: 10k, 50k, 200k, 500k, 1M")

    N_CUST = SIZES[key]
    N_PROD = max(100, N_CUST // 10)
    N_ORD  = N_CUST * 2

    rng  = random.Random(42)
    rng2 = random.Random(99)

    print(f"\n── Seeding ({args.size}) via bulk API ───────────────────────────────────")
    print(f"   customers={N_CUST:,}  products={N_PROD:,}  orders={N_ORD:,}")

    REPORT_EVERY = max(1, N_CUST // 5)  # 5 progress lines per table max

    # ── Customers ─────────────────────────────────────────────────────────
    print(f"\n── Customers ({N_CUST:,}) ──────────────────────────────────────────────")
    t0, inserted, rows = time.time(), 0, []
    for i in range(N_CUST):
        idx = rng.randrange(len(CITIES))
        rows.append({"id": i+1,
            "name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
            "email": f"user{i+1}@example.com",
            "phone": f"+1-{rng.randint(200,999)}-{rng.randint(100,999)}-{rng.randint(1000,9999)}",
            "city": CITIES[idx], "country": COUNTRIES[idx],
            "created_at": rand_ts(rng, 365, 730)})
        if len(rows) == BULK_CHUNK:
            inserted += bulk_insert("customers", rows)
            if inserted % REPORT_EVERY < BULK_CHUNK:
                progress("customers", inserted, N_CUST, t0)
            rows = []
    if rows: inserted += bulk_insert("customers", rows)
    print(f"  done {inserted:,} in {time.time()-t0:.1f}s  ({inserted/(time.time()-t0):.0f} rows/s)")

    # ── Products ──────────────────────────────────────────────────────────
    print(f"\n── Products ({N_PROD:,}) ─────────────────────────────────────────────")
    t0, rows = time.time(), []
    for i in range(N_PROD):
        cat = rng.choice(CATEGORIES)
        rows.append({"id": i+1,
            "name": f"{rng.choice(PROD_NAMES)} {i+1}", "category": cat,
            "price": round(rng.uniform(4.99, 999.99), 2),
            "stock_qty": rng.randint(0, 5000),
            "sku": f"SKU-{cat[:3].upper()}-{i+1:06d}",
            "created_at": rand_ts(rng, 500, 1000)})
    n = bulk_insert("products", rows)
    print(f"  done {n:,} in {time.time()-t0:.1f}s")

    # ── Orders + order_items ──────────────────────────────────────────────
    print(f"\n── Orders ({N_ORD:,}) + order_items ─────────────────────────────────")
    t0 = time.time()
    ord_rows, oi_rows, oi_id, ord_done = [], [], 0, 0
    REPORT_ORD = max(1, N_ORD // 5)

    for i in range(N_ORD):
        oid = i + 1
        cid = rng.randint(1, N_CUST)
        ts  = rand_ts(rng, 0, 365)
        n   = rng.randint(1, 5)
        total = 0.0
        for _ in range(n):
            oi_id += 1
            pid   = rng.randint(1, N_PROD)
            qty   = rng.randint(1, 10)
            price = round(rng.uniform(4.99, 499.99), 2)
            lt    = round(qty * price, 2)
            total += lt
            oi_rows.append({"id": oi_id, "order_id": oid, "product_id": pid,
                             "qty": qty, "unit_price": price, "line_total": lt})
        ord_rows.append({"id": oid, "customer_id": cid,
                          "status": rng.choice(STATUSES),
                          "total_amount": round(total, 2), "created_at": ts})

        if len(ord_rows) == ORD_CHUNK:
            bulk_insert("orders", ord_rows)
            bulk_insert("order_items", oi_rows)
            ord_done += len(ord_rows)
            if ord_done % REPORT_ORD < ORD_CHUNK:
                progress("orders", ord_done, N_ORD, t0)
            ord_rows, oi_rows = [], []

    if ord_rows:
        bulk_insert("orders", ord_rows)
        bulk_insert("order_items", oi_rows)
        ord_done += len(ord_rows)

    print(f"  done orders={ord_done:,} order_items={oi_id:,} in {time.time()-t0:.1f}s")

    # ── Invoices + invoice_items ──────────────────────────────────────────
    print(f"\n── Invoices + invoice_items ──────────────────────────────────────────")
    t0 = time.time()
    inv_rows, ii_rows, inv_id, ii_id, inv_done = [], [], 0, 0, 0
    REPORT_INV = max(1, N_ORD // 5)

    for i in range(N_ORD):
        inv_id += 1
        oid    = i + 1
        issued_dt = BASE_DT - timedelta(seconds=rng2.randint(0, 365 * 86400))
        due_dt    = issued_dt + timedelta(days=30)
        paid_dt   = issued_dt + timedelta(days=rng2.randint(1, 25)) if rng2.random() < 0.75 else None
        istatus   = "paid" if paid_dt else ("overdue" if rng2.random() < 0.3 else "issued")
        inv_rows.append({"id": inv_id, "order_id": oid,
            "invoice_number": f"INV-{inv_id:08d}",
            "issued_at": issued_dt.strftime('%Y-%m-%d %H:%M:%S'),
            "due_at":    due_dt.strftime('%Y-%m-%d %H:%M:%S'),
            "paid_at":   paid_dt.strftime('%Y-%m-%d %H:%M:%S') if paid_dt else None,
            "total_amount": round(rng2.uniform(10, 5000), 2), "status": istatus})
        for _ in range(rng2.randint(1, 3)):
            ii_id += 1
            pid2  = rng2.randint(1, N_PROD)
            qty2  = rng2.randint(1, 5)
            price2= round(rng2.uniform(4.99, 299.99), 2)
            ii_rows.append({"id": ii_id, "invoice_id": inv_id, "product_id": pid2,
                             "description": f"Product #{pid2} service",
                             "qty": qty2, "unit_price": price2,
                             "line_total": round(qty2*price2, 2)})

        if len(inv_rows) == ORD_CHUNK:
            bulk_insert("invoices", inv_rows)
            bulk_insert("invoice_items", ii_rows)
            inv_done += len(inv_rows)
            if inv_done % REPORT_INV < ORD_CHUNK:
                progress("invoices", inv_done, N_ORD, t0)
            inv_rows, ii_rows = [], []

    if inv_rows:
        bulk_insert("invoices", inv_rows)
        bulk_insert("invoice_items", ii_rows)
        inv_done += len(inv_rows)

    print(f"  done invoices={inv_done:,} invoice_items={ii_id:,} in {time.time()-t0:.1f}s")

    # ── Final counts ──────────────────────────────────────────────────────
    print("\n── Row counts ───────────────────────────────────────────────────────────")
    total_rows = 0
    for tbl in ["customers","products","orders","order_items","invoices","invoice_items"]:
        res = run_sql(f"SELECT COUNT(*) FROM {tbl}")
        n   = (res.get("results") or [{}])[0].get("rows", [[0]])[0][0]
        print(f"  {tbl:<22} {n:>10,}")
        total_rows += n
    print(f"  {'TOTAL':<22} {total_rows:>10,}")
    print(f"\n✓ Seed complete ({args.size}).\n")


if __name__ == "__main__":
    main()
