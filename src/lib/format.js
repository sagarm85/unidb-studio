// Rendering helpers for cells coming off /sql. Per REST_API.md a JSON column
// arrives as a real nested value (object/array), DECIMAL as a decimal string,
// TIMESTAMP as a UTC string, NULL as JSON null.

export function formatCell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function isNull(value) {
  return value === null || value === undefined;
}

// A short "col1 INT, col2 TEXT, …" summary for the sidebar.
export function columnSummary(columns, max = 4) {
  if (!columns?.length) return 'no columns';
  const shown = columns.slice(0, max).map((c) => c.name).join(', ');
  return columns.length > max ? `${shown}, +${columns.length - max} more` : shown;
}

// Interpolate a SQL identifier from introspection into generated queries.
// unidb resolves only BARE identifiers: it keeps the quote characters when
// converting a double-quoted name, so `SELECT * FROM "demo"` looks up a table
// literally named `"demo"` and 404s. Names from introspection are engine-
// created and therefore always plain, so pass those through bare; anything
// unexpected still gets quoted so it can never break out of the query (the
// engine will then reject it honestly rather than us interpolating it raw).
export function quoteIdent(name) {
  const s = String(name);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
