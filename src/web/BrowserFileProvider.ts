// SGBD files chosen by the user (their own C:\EDIABAS\Ecu), kept locally in IndexedDB. Nothing is uploaded.

import type { EcuFileProvider } from '../core/ediabas/Ediabas';
import { PrgFile } from '../core/prg/PrgFile';

const DB = 'e46diag';
const STORE = 'ecu';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class BrowserFileProvider implements EcuFileProvider {
  private raw = new Map<string, Uint8Array>(); // "ms430ds0.prg" -> bytes
  private parsed = new Map<string, PrgFile>();

  /** True when the SGBD files are built into the page (offline package). */
  embedded = false;

  get count() {
    return this.raw.size;
  }

  /**
   * Loads SGBD files built into the page by scripts/build-offline.ts:
   * <script id="ecu-bundle" type="application/octet-stream"> base64(gzip(u32 headerLen | JSON [[name, len]...] | bytes)) </script>
   */
  async loadEmbedded(): Promise<number> {
    const el = document.getElementById('ecu-bundle');
    if (!el?.textContent?.trim()) return 0;
    const bin = Uint8Array.from(atob(el.textContent.trim()), (c) => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const headLen = new DataView(data.buffer).getUint32(0, true);
    const entries = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headLen))) as [string, number][];
    let off = 4 + headLen;
    for (const [name, len] of entries) {
      this.raw.set(name.toLowerCase(), data.subarray(off, off + len));
      off += len;
    }
    this.embedded = this.raw.size > 0;
    return this.raw.size;
  }
  names() {
    return [...this.raw.keys()].sort();
  }

  async load(base: string, ext: 'prg' | 'grp'): Promise<PrgFile | null> {
    const key = `${base.toLowerCase()}.${ext}`;
    const c = this.parsed.get(key);
    if (c) return c;
    const data = this.raw.get(key);
    if (!data) return null;
    const f = new PrgFile(key, data);
    this.parsed.set(key, f);
    return f;
  }

  /** Adds files from an <input webkitdirectory> selection; returns how many SGBDs were accepted. */
  async addFiles(list: FileList | File[]): Promise<number> {
    let n = 0;
    const store: [string, Uint8Array][] = [];
    for (const f of Array.from(list)) {
      const name = f.name.toLowerCase();
      if (!/\.(prg|grp)$/.test(name)) continue;
      const data = new Uint8Array(await f.arrayBuffer());
      try {
        new PrgFile(name, data); // validate
      } catch {
        continue;
      }
      this.raw.set(name, data);
      this.parsed.delete(name);
      store.push([name, data]);
      n++;
    }
    if (store.length && !this.embedded) await this.persist(store);
    return n;
  }

  private async persist(entries: [string, Uint8Array][]) {
    try {
      const d = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        for (const [k, v] of entries) tx.objectStore(STORE).put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* storage unavailable (private window) — files stay in memory for this visit */
    }
  }

  async restore(): Promise<number> {
    if (this.embedded) return this.raw.size;
    try {
      const d = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          this.raw.set(String(c.key), new Uint8Array(c.value as ArrayBuffer | Uint8Array));
          c.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
    return this.raw.size;
  }

  async clear() {
    this.raw.clear();
    this.parsed.clear();
    try {
      const d = await db();
      d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    } catch {
      /* ignore */
    }
  }
}
