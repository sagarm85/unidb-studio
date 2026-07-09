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

// Quote a SQL identifier defensively for interpolation into generated queries
// (table/column names from introspection). unidb uses double-quoted idents.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
