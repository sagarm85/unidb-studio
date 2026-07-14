# unidb-studio — Claude Code rules

## Core principle: the UI must be engine-truthful

**Never add mock, hardcoded, placeholder, or synthesised data to the Studio UI.**
Every value shown must come from a live engine API response or be explicitly
derived from one. If the engine does not expose a piece of information, the UI
must either omit it or show a clear "not available" state — never invent a number.

Specific rules that follow from this:

- **No fake metric values.** Charts and stat cards must display engine data or
  remain at their "Collecting data…" / "—" empty state. Do not seed them with
  sample numbers.
- **No stub consumer offsets.** The Consumers subtab reads from `event_consumers`
  (user table) or the engine's `unidb_catalog.subscription_lag`. Do not hard-code
  consumer names or seq numbers.
- **No synthesised schema.** The Schema ERD and table list come from
  `GET /tables` + `information_schema`. Do not add fake tables or fake FK edges.
- **No placeholder log lines.** The Logs tab streams from `GET /logs`. Do not
  inject example lines.
- **No "example" slow queries.** The slow-query section in Observability shows
  engine data only. If `recent_slow_queries` is empty (threshold not set), keep
  the section empty — do not fill it with sample SQL.

---

## Known demo workarounds (to remove once engine items ship)

These are places where the Studio currently compensates for a missing engine API.
They are documented here so they can be removed when the engine gap closes —
never extend them further.

| Workaround | File | Closes when |
|------------|------|-------------|
| `event_consumers` user table for consumer offsets | `EventsPanel.svelte`, `eventStore.js` | Engine item 33: use `POST /events/ack` + `unidb_catalog.subscription_lag` instead |
| `localStorage` `unidb_cdc_tables` set for CDC-enabled status | `eventStore.js` | Engine item 33: `GET /tables/{name}/events` returns `{ enabled: bool }` |
| `get_current_seq()` 1-second SSE peek in `demo/events_demo.py` | `demo/events_demo.py` | Engine item 33: `GET /events/head` returns current seq directly |
| Client-side 60-point metrics ring buffer | `ObservabilityPanel.svelte` | Engine item 34: `GET /stats/history` prefills charts on mount |
| Client-side `commitsPerSec` / `walBytesPerSec` delta math | `ObservabilityPanel.svelte` | Engine item 34: history points carry server-computed rates |
| "Recent slow queries" always empty | `ObservabilityPanel.svelte` | Engine item 34: `UNIDB_SLOW_QUERY_MS` env var enables threshold |
| Client-side `CREATE TABLE` DDL reconstruction | `schema.js:214–233` | Engine item TBD: `object_ddl` in catalog |

Engine backlog specs: `unidb/docs/backlog/33_cdc_management_api.md`,
`unidb/docs/backlog/34_observability_api_gaps.md`.

---

## Engine-Studio API contract

The Studio talks to the engine exclusively through the routes in
`unidb/docs/REST_API.md`. If a needed route does not exist in that doc, file a
backlog item in `unidb/docs/backlog/` rather than inventing a workaround in the
Studio.

Workarounds that are already present (the table above) must carry a comment in
the code explaining what they replace and which backlog item closes them.
