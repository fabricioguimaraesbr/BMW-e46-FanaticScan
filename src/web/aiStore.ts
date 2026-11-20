// IndexedDB copy of the AI Diagnosis recording, so a reload, a closed tab or a crashed head unit does not lose
// the last hour. Rows are appended in chunks (cheap); the small parts (channels, events, faults) are rewritten.
// Every call fails quietly: without storage the recording simply lives in memory only.

import { Recorder, WINDOW_MS, type ChannelRec, type Ev, type FaultRead, type Row } from '../core/api/aidiag';

const DB = 'e46diag-ai';
/** a stored recording older than this is not restored */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface Meta {
  id: 'current';
  startedAt: number;
  savedAt: number;
  channels: ChannelRec[];
  events: Ev[];
  faults: FaultRead[];
}
interface Chunk {
  /** time of the last row */
  t1: number;
  rows: Row[];
}

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'id' });
        r.result.createObjectStore('chunks', { autoIncrement: true });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => T): Promise<T | null> {
  return db().then((d) => new Promise<T | null>((resolve) => {
    if (!d) return resolve(null);
    try {
      const t = d.transaction(stores, mode);
      const out = work(t);
      t.oncomplete = () => resolve(out);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

/** Writes the rows recorded since the last call and the small parts of the recording. */
export async function saveRecording(rec: Recorder, now = Date.now()): Promise<boolean> {
  const rows = rec.rows.slice(rec.flushed);
  const meta: Meta = { id: 'current', startedAt: rec.startedAt, savedAt: now, channels: rec.channels, events: rec.events, faults: rec.faults };
  const ok = await tx(['meta', 'chunks'], 'readwrite', (t) => {
    t.objectStore('meta').put(meta);
    if (rows.length) t.objectStore('chunks').add({ t1: rows[rows.length - 1].t, rows } satisfies Chunk);
    // chunks that are entirely older than the window
    const from = now - WINDOW_MS;
    const cur = t.objectStore('chunks').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if ((c.value as Chunk).t1 < from) c.delete();
      c.continue();
    };
    return true;
  });
  if (ok) rec.flushed = rec.rows.length;
  return !!ok;
}

/** The stored recording, if there is a recent one. */
export async function loadRecording(now = Date.now()): Promise<Recorder | null> {
  const got = await tx(['meta', 'chunks'], 'readonly', (t) => {
    const out: { meta?: Meta; chunks: Chunk[] } = { chunks: [] };
    const m = t.objectStore('meta').get('current');
    m.onsuccess = () => { out.meta = m.result as Meta | undefined; };
    const all = t.objectStore('chunks').getAll();
    all.onsuccess = () => { out.chunks = all.result as Chunk[]; };
    return out;
  });
  const meta = got?.meta;
  if (!meta || now - meta.savedAt > MAX_AGE_MS || !meta.channels?.length) return null;
  const rec = new Recorder();
  rec.startedAt = meta.startedAt;
  rec.channels = meta.channels;
  rec.events = meta.events ?? [];
  rec.faults = meta.faults ?? [];
  for (const c of got!.chunks) rec.rows.push(...c.rows);
  rec.rows.sort((a, b) => a.t - b.t);
  rec.prune(now);
  rec.flushed = rec.rows.length;
  return rec.rows.length || rec.faults.length ? rec : null;
}

export async function clearRecording(): Promise<void> {
  await tx(['meta', 'chunks'], 'readwrite', (t) => {
    t.objectStore('meta').clear();
    t.objectStore('chunks').clear();
    return true;
  });
}
