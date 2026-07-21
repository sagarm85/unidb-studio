import { openEventStream } from './engine/api.js';

// Deliberately module-level (not component state): the live-tail stream must
// keep running and its state must survive switching away from the Events tab
// and back (the UI hint literally says "persists across tab switches and
// page reloads"), which a React component's local state cannot do once
// unmounted. A useSyncExternalStore-based hook (useEventStream) is how
// components read this without a state library.

const MAX_ROWS = 500;
const LS_KEY = 'unidb_event_stream';

export interface StreamEvent {
  seq: number;
  xid: number;
  table_name: string;
  op: string;
  payload: unknown;
}
export interface StreamErr {
  code?: string;
  message: string;
  status?: number;
}
export interface EventStreamSnapshot {
  streaming: boolean;
  events: StreamEvent[];
  lastSeq: number | null;
  streamErr: StreamErr | null;
}

let snapshot: EventStreamSnapshot = { streaming: false, events: [], lastSeq: null, streamErr: null };

let handle: { close: () => void } | null = null;
let streamCfg: { table: string; fromSeq: number | string | null } = { table: '', fromSeq: null };

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
function setSnapshot(patch: Partial<EventStreamSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  notify();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getSnapshot(): EventStreamSnapshot {
  return snapshot;
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ wasStreaming: snapshot.streaming, table: streamCfg.table, lastSeq: snapshot.lastSeq }));
  } catch {
    /* private/incognito may block */
  }
}

export function startStream({ table = '', fromSeq = null as number | string | null } = {}) {
  stopStream();
  setSnapshot({ streamErr: null });
  streamCfg = { table, fromSeq };

  handle = openEventStream({
    table: table || undefined,
    fromSeq: fromSeq != null && fromSeq !== '' ? Number(fromSeq) : undefined,
    onOpen: () => {
      setSnapshot({ streaming: true });
      save();
    },
    onEvent: (evt: StreamEvent) => {
      setSnapshot({ lastSeq: evt.seq, events: [evt, ...snapshot.events].slice(0, MAX_ROWS) });
      save();
    },
    onError: (e: any) => {
      setSnapshot({ streamErr: { code: e.code, message: e.message, status: e.status }, streaming: false });
      save();
    },
  });
}

export function stopStream() {
  handle?.close();
  handle = null;
  setSnapshot({ streaming: false });
  save();
}

export function clearEvents() {
  setSnapshot({ events: [], lastSeq: null });
  save();
}

// Called once by EventsPanel on mount.
export function maybeResume() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved?.wasStreaming) {
      startStream({ table: saved.table ?? '', fromSeq: saved.lastSeq ?? null });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
