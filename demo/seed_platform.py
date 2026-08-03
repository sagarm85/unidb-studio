#!/usr/bin/env python3
"""
demo/seed_platform.py — seed the platform panels that are otherwise empty, so the
Studio (and the walkthrough screenshots) show real, meaningful data:

  * Webhooks        — a few database webhooks over POST /webhooks (item 141)
  * Channel Authz   — realtime channel policies over PUT /realtime/policies (140)
  * Scheduled Jobs  — pg_cron-parity jobs over POST /cron/jobs (item 144)

All superuser-gated, so `dev` must be a superuser (DEMO_GUIDE Step 4b). Cron jobs
are registered only — their SQL runs at the scheduled time, not now. Safe to
re-run (webhooks upsert by id, cron by name, channel policies by topic+op).

Usage (from unidb-studio root):
    python3 demo/seed_platform.py

Config: VITE_UNIDB_TOKEN from .env.local (override with env UNIDB_TOKEN);
base URL from env UNIDB_URL (default http://localhost:8080).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
BASE = os.environ.get("UNIDB_URL", "http://localhost:8080").rstrip("/")


def _token():
    tok = os.environ.get("UNIDB_TOKEN")
    if tok:
        return tok.strip()
    env = HERE.parent / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("VITE_UNIDB_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("No token: set UNIDB_TOKEN or put VITE_UNIDB_TOKEN in .env.local")


TOKEN = _token()


def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                               headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": f"HTTP {e.code}"}


def do(label, method, path, body):
    status, resp = req(method, path, body)
    err = resp.get("error") if isinstance(resp, dict) else None
    print(f"  {'ok ' if status < 300 else 'ERR'} {label}" + (f"  ({status}: {err})" if err else ""))


def rule(t):
    print(f"\n\033[1m── {t} " + "─" * max(0, 58 - len(t)) + "\033[0m")


WEBHOOKS = [
    # Local dev services (each on its own port), mimicking a real local setup.
    {"id": "orders-to-fulfilment", "target_url": "http://localhost:4001/hooks/orders",
     "table_pattern": "orders", "events": ["insert", "update"], "signing_secret": "whsec_orders_9f2c", "enabled": True},
    {"id": "new-customer-to-crm", "target_url": "http://localhost:4002/webhooks/customers",
     "table_pattern": "customers", "events": ["insert"], "signing_secret": "whsec_crm_a71b", "enabled": True},
    {"id": "invoice-paid-to-billing", "target_url": "http://localhost:4003/hooks/invoices",
     "table_pattern": "invoices", "events": ["update"], "signing_secret": "whsec_billing_4d80", "enabled": False},
]

CRON = [
    {"name": "nightly-cancelled-cleanup", "schedule": "0 3 * * *",
     "sql": "DELETE FROM orders WHERE status = 'cancelled'", "enabled": True},
    {"name": "hourly-order-count", "schedule": "0 * * * *",
     "sql": "SELECT COUNT(*) FROM orders", "enabled": True},
    {"name": "weekly-revenue-by-country", "schedule": "0 8 * * 1",
     "sql": "SELECT country, COUNT(*) FROM customers GROUP BY country", "run_as": "analyst", "enabled": True},
]

CHANNELS = [
    ("orders:*", "subscribe", ["authenticated"]),
    ("presence:room:*", "presence", ["authenticated"]),
    ("admin:broadcast", "all", ["service_role"]),
]


def main():
    print("\033[1mseeding platform demo data: webhooks · channel authz · cron\033[0m")

    rule("Webhooks (POST /webhooks)")
    for w in WEBHOOKS:
        do(f"{w['id']}  → {w['table_pattern']} {w['events']}", "POST", "/webhooks", w)

    rule("Channel authorization (PUT /realtime/policies)")
    for topic, op, roles in CHANNELS:
        do(f"{topic}  [{op}] → {roles}", "PUT", "/realtime/policies",
           {"topic_pattern": topic, "operation": op, "roles": roles})

    rule("Scheduled jobs (POST /cron/jobs)")
    for j in CRON:
        do(f"{j['name']}  ({j['schedule']})", "POST", "/cron/jobs", j)

    rule("Done")
    print("  Webhooks / Channel Authz / Scheduled Jobs panels now show live data.")
    print("  (Broadcast & Presence is a live test client — connect a topic in the UI to see it work.)")


if __name__ == "__main__":
    main()
