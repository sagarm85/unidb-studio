import { writable, get } from 'svelte/store';
import { openEventStream } from './api.js';

const MAX_ROWS = 500;

// Persistent state — survives tab switches because this module is a singleton.
export const streaming  = writable(false);
export const events     = writable([]);
export const lastSeq    = writable(null);
export const streamErr  = writable(null);

// Non-reactive handle — kept outside stores to avoid Svelte tracking it.
let _handle = null;

export function startStream({ table, fromSeq } = {}) {
  stopStream();
  streamErr.set(null);

  _handle = openEventStream({
    table:    table || undefined,
    fromSeq:  fromSeq != null && fromSeq !== '' ? Number(fromSeq) : undefined,
    onOpen:   () => streaming.set(true),
    onEvent:  (evt) => {
      lastSeq.set(evt.seq);
      events.update(prev => [evt, ...prev].slice(0, MAX_ROWS));
    },
    onError:  (e) => {
      streamErr.set({ code: e.code, message: e.message, status: e.status });
      streaming.set(false);
    },
  });
}

export function stopStream() {
  _handle?.close();
  _handle = null;
  streaming.set(false);
}

export function clearEvents() {
  events.set([]);
  lastSeq.set(null);
}

export function isStreaming() {
  return get(streaming);
}
