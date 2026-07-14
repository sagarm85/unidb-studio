#!/usr/bin/env python3
"""
demo/setup_schema.py — create the e-commerce demo schema with FK constraints.

Run this ONCE before seeding. Idempotent: drops & recreates tables each time.
"""

import json, urllib.request, sys

BASE  = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def sql(q):
    req = urllib.request.Request(
        f"{BASE}/sql",
        data=json.dumps({"sql": q}).encode(),
        headers=HDRS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        return {"error": body.get("error", str(e)), "code": body.get("code")}


def run(label, q):
    r = sql(q)
    err = r.get("error") or (r.get("results") or [{}])[0].get("error")
    status = "OK " if not err else "ERR"
    print(f"  {status}  {label}" + (f": {err}" if err else ""))
    return not err


# ── Drop in reverse-dependency order ────────────────────────────────────────
print("\n── Drop existing tables ─────────────────────────────────────────────────")
for t in ["invoice_items", "invoices", "order_items", "orders", "products", "customers", "_fk_test"]:
    run(f"DROP TABLE {t}", f"DROP TABLE {t}")

# ── Recreate with explicit FOREIGN KEY constraints ───────────────────────────
print("\n── Create schema (with FK constraints) ──────────────────────────────────")

run("customers", """CREATE TABLE customers (
  id         INTEGER   PRIMARY KEY,
  name       TEXT      NOT NULL,
  email      TEXT      NOT NULL,
  phone      TEXT,
  city       TEXT,
  country    TEXT,
  created_at TIMESTAMP NOT NULL)""")

run("products", """CREATE TABLE products (
  id         INTEGER   PRIMARY KEY,
  name       TEXT      NOT NULL,
  category   TEXT      NOT NULL,
  price      REAL      NOT NULL,
  stock_qty  INTEGER   NOT NULL,
  sku        TEXT      NOT NULL,
  created_at TIMESTAMP NOT NULL)""")

run("orders", """CREATE TABLE orders (
  id           INTEGER   PRIMARY KEY,
  customer_id  INTEGER   NOT NULL,
  status       TEXT      NOT NULL,
  total_amount REAL      NOT NULL,
  created_at   TIMESTAMP NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id))""")

run("order_items", """CREATE TABLE order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  unit_price REAL    NOT NULL,
  line_total REAL    NOT NULL,
  FOREIGN KEY (order_id)   REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id))""")

run("invoices", """CREATE TABLE invoices (
  id             INTEGER   PRIMARY KEY,
  order_id       INTEGER   NOT NULL,
  invoice_number TEXT      NOT NULL,
  issued_at      TIMESTAMP NOT NULL,
  due_at         TIMESTAMP NOT NULL,
  paid_at        TIMESTAMP,
  total_amount   REAL      NOT NULL,
  status         TEXT      NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id))""")

run("invoice_items", """CREATE TABLE invoice_items (
  id          INTEGER PRIMARY KEY,
  invoice_id  INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  description TEXT    NOT NULL,
  qty         INTEGER NOT NULL,
  unit_price  REAL    NOT NULL,
  line_total  REAL    NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (product_id) REFERENCES products(id))""")

# ── Verify information_schema sees the FK relationships ──────────────────────
print("\n── Verify: information_schema.tables ─────────────────────────────────────")
r = sql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
rows = (r.get("results") or [{}])[0].get("rows", [])
for row in rows:
    print(f"  {row[0]}")

print("\n── Verify: referential_constraints (FK edges) ───────────────────────────")
r = sql("""SELECT constraint_name, unique_constraint_name
           FROM information_schema.referential_constraints
           ORDER BY constraint_name""")
rows = (r.get("results") or [{}])[0].get("rows", [])
if rows:
    for row in rows:
        print(f"  {row[0]}  →  {row[1]}")
else:
    print("  (none — FK constraints may not be registered yet)")

print("\n✓ Schema ready. Run:  python3 demo/seed.py --size 10k\n")
