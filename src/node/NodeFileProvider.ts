import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrgFile } from '../core/prg/PrgFile';
import type { EcuFileProvider } from '../core/ediabas/Ediabas';

/** Loads SGBD files from a directory (case-insensitive). */
export class NodeFileProvider implements EcuFileProvider {
  private index = new Map<string, string>();
  private cache = new Map<string, PrgFile>();
  constructor(dir: string) {
    for (const f of readdirSync(dir)) this.index.set(f.toLowerCase(), join(dir, f));
  }
  async load(base: string, ext: 'prg' | 'grp'): Promise<PrgFile | null> {
    const key = `${base.toLowerCase()}.${ext}`;
    const c = this.cache.get(key);
    if (c) return c;
    const p = this.index.get(key);
    if (!p) return null;
    const f = new PrgFile(key, readFileSync(p));
    this.cache.set(key, f);
    return f;
  }
}
