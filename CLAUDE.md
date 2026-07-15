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
- **No stub consumer offsets.** The Consumers subtab reads from the engine's
  `unidb_catalog.subscription_lag`. Do not hard-code consumer names or seq numbers.
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
| Client-side `CREATE TABLE` DDL reconstruction | `schema.js:214–233` | Engine item TBD: `object_ddl` in catalog |

---

## Engine-Studio API contract

The Studio talks to the engine exclusively through the routes in
`unidb/docs/REST_API.md`. If a needed route does not exist in that doc, file a
backlog item in `unidb/docs/backlog/` rather than inventing a workaround in the
Studio.

Workarounds that are already present (the table above) must carry a comment in
the code explaining what they replace and which backlog item closes them.
