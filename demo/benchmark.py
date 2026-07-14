#!/usr/bin/env python3
"""
demo/benchmark.py — run representative queries and print timing.

Demonstrates the performance visible in Studio's Query Performance tab.
"""

import json, sys, time, urllib.request, urllib.error

BASE  = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def sql(q):
    req = urllib.request.Request(
        f"{BASE}/sql",
        data=json.dumps({"sql": q}).encode(),
        headers=HDRS, method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
    elapsed_ms = (time.perf_counter() - t0) * 1000
    rows = (body.get("results") or [{}])[0].get("rows", [])
    err  = body.get("error") or (body.get("results") or [{}])[0].get("error")
    return elapsed_ms, rows, err


def run(label, query):
    ms, rows, err = sql(query)
    if err:
        print(f"  {'ERR':>6}       {label}: {err}")
    else:
        n = len(rows)
        val = rows[0][0] if (n == 1 and len(rows[0]) == 1) else f"{n} rows"
        print(f"  {ms:>7.1f} ms  {label}  →  {val}")
    return ms


print("\n── Benchmark queries ────────────────────────────────────────────────────")

# Row count reads (full scans)
run("COUNT customers",   "SELECT COUNT(*) FROM customers")
run("COUNT orders",      "SELECT COUNT(*) FROM orders")
run("COUNT order_items", "SELECT COUNT(*) FROM order_items")

# Filtered selects
run("Orders by status (delivered)",
    "SELECT COUNT(*) FROM orders WHERE status = 'delivered'")
run("Top 10 customers by order count",
    """SELECT c.name, COUNT(o.id) AS order_count
       FROM customers c
       JOIN orders o ON o.customer_id = c.id
       GROUP BY c.id, c.name
       ORDER BY order_count DESC
       LIMIT 10""")
run("Revenue by product category",
    """SELECT p.category, SUM(oi.line_total) AS revenue
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       GROUP BY p.category
       ORDER BY revenue DESC""")
run("Unpaid invoices total",
    "SELECT SUM(total_amount) FROM invoices WHERE status != 'paid'")
run("Average order value",
    "SELECT AVG(total_amount) FROM orders")

# Bulk update (watch the Observability panel update)
print("\n── Bulk UPDATE (watch Observability tab for latency spike) ─────────────")
run("Update 'pending' orders to 'confirmed'",
    "UPDATE orders SET status = 'confirmed' WHERE status = 'pending'")

print("\n── Check engine stats after benchmark ───────────────────────────────────")
try:
    req = urllib.request.Request(f"{BASE}/stats", headers={k:v for k,v in HDRS.items() if k != "Content-Type"})
    with urllib.request.urlopen(req, timeout=10) as r:
        stats = json.loads(r.read())
    sl = stats.get("statement_latency", {})
    print(f"\n  Engine statement_latency (μs):")
    print(f"  {'kind':<10} {'count':>8}  {'mean':>8}  {'p50':>8}  {'p99':>8}")
    print(f"  {'-'*52}")
    for kind, s in sl.items():
        print(f"  {kind:<10} {s['count']:>8,}  {s['mean_us']:>7,}μ  {s['p50_us']:>7,}μ  {s['p99_us']:>7,}μ")
except Exception as e:
    print(f"  Could not read /stats: {e}")

print("\n✓ Benchmark done. Open Studio → Query Performance tab to see the history.\n")
