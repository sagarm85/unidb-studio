import { useCallback, useEffect, useState } from 'react';
import { getTables, getSchema, runSql } from '@/lib/engine/api.js';

// Catalog-loading state machine: catalog → flat `/tables` fallback,
// internal-table filter, and selection re-pointing after a reload/DDL/edit.
// Owns `selectedTable` too, since re-pointing it at the refreshed table
// object is intrinsic to a catalog reload.

export interface CatalogColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  // A secondary btree index is a plain `true`; a durable ANN index reports
  // its kind as a string (currently only `'hnsw'`) — see schema.js's DEMO_SCHEMA.
  index?: string | boolean;
  default?: unknown;
}

export interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
  primaryKey?: string[];
}

export interface CatalogRelationship {
  name: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  inferred?: boolean;
}

export interface CatalogError {
  code?: string;
  message: string;
  status?: number;
}

const notInternal = (t: CatalogTable) => !/^__/.test(t.name);

export function useCatalog() {
  const [tables, setTables] = useState<CatalogTable[]>([]);
  const [relationships, setRelationships] = useState<CatalogRelationship[]>([]);
  const [catalogSource, setCatalogSource] = useState<'catalog' | 'tables'>('catalog');
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tablesError, setTablesError] = useState<CatalogError | null>(null);
  const [tablesSupported, setTablesSupported] = useState(true);
  const [selectedTable, setSelectedTable] = useState<CatalogTable | null>(null);

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    setTablesError(null);
    try {
      // getSchema() reads information_schema.*, which — unlike GET /tables —
      // needs its own separate grant (see unidb backlog item 108; a user with
      // full CRUD on every table can still get PERMISSION_DENIED here). Treat
      // that specific failure the same as "catalog not supported" and fall
      // back to the older, ungated GET /tables route rather than surfacing a
      // dead sidebar — any other error (network, etc.) still propagates.
      let s: Awaited<ReturnType<typeof getSchema>>;
      try {
        s = await getSchema();
      } catch (e: any) {
        if (e?.code !== 'PERMISSION_DENIED') throw e;
        s = { supported: false } as Awaited<ReturnType<typeof getSchema>>;
      }
      let nextTables: CatalogTable[];
      let nextRelationships: CatalogRelationship[];
      let nextSource: 'catalog' | 'tables';
      let nextSupported: boolean;

      if (s.supported) {
        nextTables = s.tables.filter(notInternal);
        nextRelationships = s.relationships;
        nextSource = 'catalog';
        nextSupported = true;
      } else {
        const out = await getTables();
        nextTables = out.tables.filter(notInternal);
        nextRelationships = [];
        nextSource = 'tables';
        nextSupported = out.supported;
      }

      setTables(nextTables);
      setRelationships(nextRelationships);
      setCatalogSource(nextSource);
      setTablesSupported(nextSupported);
      // Re-point the current selection at the refreshed table object (after a
      // reload/DDL/edit) so the record browser sees fresh columns.
      setSelectedTable((prev) => (prev ? (nextTables.find((t) => t.name === prev.name) ?? null) : prev));
    } catch (e: any) {
      setTablesError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
      setTables([]);
      setRelationships([]);
    } finally {
      setTablesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  const canDDL = catalogSource === 'catalog'; // needs a live catalog

  // Run a DDL statement, then refresh the catalog. Callers holding their own
  // reference into `tables` (e.g. an open "manage table" target) re-point it
  // themselves off the hook's fresh `tables` array once this resolves.
  const runDDL = useCallback(
    async (sql: string) => {
      await runSql(sql);
      await loadTables();
    },
    [loadTables],
  );

  return {
    tables,
    relationships,
    catalogSource,
    tablesLoading,
    tablesError,
    tablesSupported,
    selectedTable,
    setSelectedTable,
    canDDL,
    loadTables,
    runDDL,
  };
}
