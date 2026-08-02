import { useEffect, useRef, useState } from 'react';
import { Radio, Send, Users2 } from 'lucide-react';
import { publishBroadcast, subscribeBroadcast, subscribePresence, trackPresence } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';

// Realtime Broadcast & Presence (item 132, net-new — no v1/Svelte precedent).
// Purely in-memory and ephemeral, per REST_API.md: neither broadcast
// messages nor presence state touch the WAL/heap/catalog, and a server
// restart drops all state. A live test client, not a mocked one — every
// message/presence entry shown here came from a real SSE frame the engine
// sent, over the same feature-detected /realtime/* routes the Channel Authz
// panel documents the authorization posture for.

interface BroadcastMsg {
  event: string;
  payload: unknown;
  ts: number;
}
interface PresenceEntry {
  event: string;
  key?: string;
  state?: unknown;
  payload?: Record<string, { state: unknown }>; // sync frame's full map
  ts: number;
}

export function BroadcastPresencePanel() {
  const [topic, setTopic] = useState('room:demo');
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  const [broadcastMsgs, setBroadcastMsgs] = useState<BroadcastMsg[]>([]);
  const [pubEvent, setPubEvent] = useState('message');
  const [pubPayload, setPubPayload] = useState('{"text":"hello"}');
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);
  const [lastReceivers, setLastReceivers] = useState<number | null>(null);

  const [presenceMap, setPresenceMap] = useState<Record<string, unknown>>({});
  const [presenceLog, setPresenceLog] = useState<PresenceEntry[]>([]);
  const [trackKey, setTrackKey] = useState('me');
  const [trackState, setTrackState] = useState('{"status":"online"}');
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  const broadcastHandle = useRef<{ close: () => void } | null>(null);
  const presenceHandle = useRef<{ close: () => void } | null>(null);

  function connect() {
    disconnect();
    setConnError(null);
    setBroadcastMsgs([]);
    setPresenceMap({});
    setPresenceLog([]);

    broadcastHandle.current = subscribeBroadcast({
      topic,
      onOpen: () => setConnected(true),
      onEvent: (e: any) => setBroadcastMsgs((m) => [{ event: e.event, payload: e.payload, ts: e.ts }, ...m].slice(0, 100)),
      onError: (e) => setConnError(e.message ?? String(e)),
    });
    presenceHandle.current = subscribePresence({
      topic,
      onEvent: (e: any) => {
        // Per REST_API.md: join/update/leave frames carry {key, state} nested
        // under `payload` (same shape as join for all three) — only the
        // `sync` frame's payload IS the full presence map directly.
        const key = e.payload?.key;
        const state = e.payload?.state;
        setPresenceLog((l) => [{ event: e.event, key, state, payload: e.payload, ts: e.ts }, ...l].slice(0, 100));
        setPresenceMap((prev) => {
          if (e.event === 'sync') return e.payload ?? {};
          if (e.event === 'join' || e.event === 'update') return { ...prev, [key]: state };
          if (e.event === 'leave') {
            const next = { ...prev };
            delete next[key];
            return next;
          }
          return prev;
        });
      },
      onError: (e) => setConnError(e.message ?? String(e)),
    });
  }

  function disconnect() {
    broadcastHandle.current?.close();
    presenceHandle.current?.close();
    broadcastHandle.current = null;
    presenceHandle.current = null;
    setConnected(false);
  }

  useEffect(() => () => disconnect(), []);

  async function doPublish() {
    setPubError(null);
    let payload: unknown;
    try {
      payload = JSON.parse(pubPayload);
    } catch {
      setPubError('payload must be valid JSON.');
      return;
    }
    setPubBusy(true);
    try {
      const out = await publishBroadcast(topic, pubEvent, payload);
      setLastReceivers(out.receivers);
    } catch (e: any) {
      setPubError(e?.message ?? String(e));
    } finally {
      setPubBusy(false);
    }
  }

  async function doTrack() {
    setTrackError(null);
    let state: unknown;
    try {
      state = JSON.parse(trackState);
    } catch {
      setTrackError('state must be valid JSON.');
      return;
    }
    setTrackBusy(true);
    try {
      await trackPresence(topic, trackKey, state);
    } catch (e: any) {
      setTrackError(e?.message ?? String(e));
    } finally {
      setTrackBusy(false);
    }
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  return (
    <div className="flex h-full flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 flex items-center gap-1.5 text-md font-semibold">
          <Radio className="size-4" /> Broadcast & Presence
        </h3>
        <div className="flex items-center gap-2">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} disabled={connected} />
          {connected ? (
            <button className={ghostBtnCls} onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button className={btnCls} onClick={connect} disabled={!topic.trim()}>
              Connect
            </button>
          )}
        </div>
      </div>

      <PanelHelp
        summary="A live pub/sub + presence test client — broadcast messages on a topic and see who's currently connected."
        what={
          <>
            Connect to a topic to open its broadcast + presence SSE streams. <strong>Broadcast</strong> is fan-out messaging;{' '}
            <strong>Presence</strong> tracks who's on the channel with a live join/leave/update map. Purely in-memory and ephemeral — a
            server restart drops all state. Subject to this server's Channel Authz policies (item 140) for <code>{topic}</code>; presence
            lasts exactly as long as this tab's SSE connections stay open.
          </>
        }
        actions={[
          'Connect a topic, then publish a broadcast message and watch it arrive',
          'Open a second browser tab, Track presence, and watch both maps update on join/leave',
        ]}
        routes={['/realtime/broadcast/publish', '/realtime/broadcast/subscribe', '/realtime/presence/*']}
      />

      {connError && <p className="m-0 text-sm text-error">{connError}</p>}
      {!connected && <p className="m-0 text-sm text-text-light">Not connected — click Connect to open the broadcast + presence SSE streams for this topic.</p>}

      {connected && (
        <div className="grid flex-1 grid-cols-2 gap-4 overflow-hidden">
          {/* Broadcast */}
          <div className="flex flex-col gap-2 overflow-hidden">
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1 text-sm text-text-light">
                event
                <input value={pubEvent} onChange={(e) => setPubEvent(e.target.value)} className={cn(inputCls, 'w-32 font-mono')} spellCheck={false} />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm text-text-light">
                payload (JSON)
                <input value={pubPayload} onChange={(e) => setPubPayload(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} />
              </label>
              <button className={cn(btnCls, 'flex items-center gap-1')} onClick={doPublish} disabled={pubBusy}>
                <Send className="size-3.5" /> Publish
              </button>
            </div>
            {pubError && <p className="m-0 text-sm text-error">{pubError}</p>}
            {lastReceivers != null && <p className="m-0 text-xs text-text-muted">Last publish reached {lastReceivers} receiver(s).</p>}
            <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-card">
              {broadcastMsgs.length === 0 ? (
                <p className="m-0 p-3 text-sm text-text-light">No broadcast messages yet.</p>
              ) : (
                broadcastMsgs.map((m, i) => (
                  <div key={i} className="border-b border-border-muted px-3 py-1.5 font-mono text-sm last:border-b-0">
                    <Badge variant="info" className="mr-1.5">
                      {m.event}
                    </Badge>
                    {JSON.stringify(m.payload)}
                    <span className="ml-1.5 text-xs text-text-muted">{new Date(m.ts).toLocaleTimeString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Presence */}
          <div className="flex flex-col gap-2 overflow-hidden">
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1 text-sm text-text-light">
                key
                <input value={trackKey} onChange={(e) => setTrackKey(e.target.value)} className={cn(inputCls, 'w-28 font-mono')} spellCheck={false} />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm text-text-light">
                state (JSON)
                <input value={trackState} onChange={(e) => setTrackState(e.target.value)} className={cn(inputCls, 'font-mono')} spellCheck={false} />
              </label>
              <button className={cn(btnCls, 'flex items-center gap-1')} onClick={doTrack} disabled={trackBusy}>
                <Users2 className="size-3.5" /> Track
              </button>
            </div>
            {trackError && <p className="m-0 text-sm text-error">{trackError}</p>}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(presenceMap).length === 0 ? (
                <span className="text-sm text-text-light">No one present.</span>
              ) : (
                Object.entries(presenceMap).map(([k, v]) => (
                  <Badge key={k} variant="ok">
                    {k}: {JSON.stringify(v)}
                  </Badge>
                ))
              )}
            </div>
            <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-card">
              {presenceLog.length === 0 ? (
                <p className="m-0 p-3 text-sm text-text-light">No presence events yet.</p>
              ) : (
                presenceLog.map((e, i) => (
                  <div key={i} className="border-b border-border-muted px-3 py-1.5 font-mono text-sm last:border-b-0">
                    <Badge variant={e.event === 'leave' ? 'error' : e.event === 'sync' ? 'outline' : 'ok'} className="mr-1.5">
                      {e.event}
                    </Badge>
                    {e.event === 'sync' ? JSON.stringify(e.payload) : `${e.key}: ${JSON.stringify(e.state)}`}
                    <span className="ml-1.5 text-xs text-text-muted">{new Date(e.ts).toLocaleTimeString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
