import { writable, get } from 'svelte/store';
import { openEventStream } from './api.js';

const MAX_ROWS    = 500;
const LS_KEY      = 'unidb_event_stream';   // localStorage persistence key
const LS_CDC_KEY  = 'unidb_cdc_tables';     // tracks which tables have CDC enabled

// ── Reactive state ────────────────────────────────────────────────────────────
export const streaming  = writable(false);
export const events     = writable([]);
export const lastSeq    = writable(null);
export const streamErr  = writable(null);
// Set of table names known to have CDC enabled (client-tracked, persisted)
export const cdcTables  = writable(new Set(_loadCdc()));

// ── Non-reactive ──────────────────────────────────────────────────────────────
let _handle    = null;
let _streamCfg = { table: '', fromSeq: null }; // last used config

// ── localStorage helpers ──────────────────────────────────────────────────────
function _save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      wasStreaming: get(streaming),
      table:        _streamCfg.table,
      lastSeq:      get(lastSeq),
    }));
  } catch { /* private/incognito may block */ }
}

function _loadCdc() {
  try { return JSON.parse(localStorage.getItem(LS_CDC_KEY) || '[]'); } catch { return []; }
}

function _saveCdc() {
  try {
    localStorage.setItem(LS_CDC_KEY, JSON.stringify([...get(cdcTables)]));
  } catch {}
}

// ── Stream control ────────────────────────────────────────────────────────────
export function startStream({ table = '', fromSeq = null } = {}) {
  stopStream();
  streamErr.set(null);
  _streamCfg = { table, fromSeq };

  _handle = openEventStream({
    table:   table || undefined,
    fromSeq: fromSeq != null && fromSeq !== '' ? Number(fromSeq) : undefined,
    onOpen:  () => { streaming.set(true); _save(); },
    onEvent: (evt) => {
      lastSeq.set(evt.seq);
      events.update(prev => [evt, ...prev].slice(0, MAX_ROWS));
      _save();
    },
    onError: (e) => {
      streamErr.set({ code: e.code, message: e.message, status: e.status });
      streaming.set(false);
      _save();
    },
  });
}

export function stopStream() {
  _handle?.close();
  _handle = null;
  streaming.set(false);
  _save();
}

export function clearEvents() {
  events.set([]);
  lastSeq.set(null);
  _save();
}

export function isStreaming() { return get(streaming); }

// ── CDC table tracking ────────────────────────────────────────────────────────
export function markCdcEnabled(tableName) {
  cdcTables.update(s => { s.add(tableName); return s; });
  _saveCdc();
}

// ── Auto-resume on page load ──────────────────────────────────────────────────
// Called once by EventsPanel on mount.
export function maybeResume() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved?.wasStreaming) {
      // Resume from just after the last seq we saw before the reload
      startStream({
        table:   saved.table  ?? '',
        fromSeq: saved.lastSeq ?? null,
      });
      return true;
    }
  } catch {}
  return false;
}
