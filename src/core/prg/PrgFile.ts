// Parser for EDIABAS SGBD object files (.prg / .grp) — BEST/2 compiled format.
// The payload is obfuscated with XOR 0xF7; a few header integers are stored in plain form.

import { decode, decodeZ } from '../util/cp1252';

export interface JobInfo {
  name: string;
  offset: number;
  arraySize: number;
  usesName: string | null; // base file the job comes from (null = own file)
}

export interface TableInfo {
  name: string;
  columnOffset: number;
  columns: number;
  rows: number;
  // lazily indexed: entries[row][col] = byte offset of the NUL-terminated string (row 0 = header)
  entries?: number[][];
  columnIndex?: Map<string, number>;
  seekString?: (Map<string, number> | undefined)[];
  seekValue?: (Map<number, number> | undefined)[];
}

export interface VersionInfo {
  bipVersion: number;
  author: string;
  revision: string;
  from: string;
  packageVersion: number;
}

export interface Descriptions {
  global: string[];
  jobs: Map<string, string[]>;
}

export class PrgFile {
  readonly name: string; // base name lower-case, e.g. "ms430ds0"
  readonly raw: Uint8Array;
  readonly dec: Uint8Array; // fully decrypted copy
  readonly fileType: number; // 0 = group, 1 = ecu (prg)
  readonly uses: string[];
  readonly version: VersionInfo;
  readonly ownJobs: JobInfo[];
  readonly tables: TableInfo[];
  readonly tableIndex: Map<string, number>;
  private _descriptions: Descriptions | null = null;

  constructor(name: string, data: Uint8Array) {
    this.name = name.toLowerCase().replace(/\.(prg|grp)$/, '');
    this.raw = data;
    this.dec = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) this.dec[i] = data[i] ^ 0xf7;
    if (data.length < 0xa0) throw new Error(`${name}: file too short`);
    this.fileType = this.rawU32(0x10);
    this.uses = this.readUses();
    this.version = this.readVersion();
    this.ownJobs = this.readJobs();
    const { tables, index } = this.readTables();
    this.tables = tables;
    this.tableIndex = index;
  }

  get isGroup(): boolean {
    return this.fileType === 0;
  }

  rawI32(off: number): number {
    return (this.raw[off] | (this.raw[off + 1] << 8) | (this.raw[off + 2] << 16) | (this.raw[off + 3] << 24)) | 0;
  }
  rawU32(off: number): number {
    return this.rawI32(off) >>> 0;
  }
  decI32(off: number): number {
    const d = this.dec;
    return (d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24)) | 0;
  }
  decU16(off: number): number {
    return this.dec[off] | (this.dec[off + 1] << 8);
  }
  decI16(off: number): number {
    return (this.decU16(off) << 16) >> 16;
  }

  private readUses(): string[] {
    const off = this.rawI32(0x7c);
    if (off < 0) return [];
    const count = this.rawI32(off);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const start = off + 4 + i * 0x100;
      out.push(decodeZ(this.dec, start, start + 0x100));
    }
    return out;
  }

  private readVersion(): VersionInfo {
    const off = this.rawI32(0x94);
    if (off < 0) return { bipVersion: 0, author: '', revision: '', from: '', packageVersion: 0 };
    const b = this.dec;
    return {
      bipVersion: (b[off + 2] << 16) | (b[off + 1] << 8) | b[off],
      revision: `${this.decI16(off + 6)}.${this.decI16(off + 4)}`,
      author: decodeZ(b, off + 0x08, off + 0x48).replace(/\0+$/, ''),
      from: decodeZ(b, off + 0x48, off + 0x68),
      packageVersion: this.decI32(off + 0x68),
    };
  }

  private readJobs(): JobInfo[] {
    let arraySize = this.rawU32(0x18);
    if (arraySize === 0) arraySize = 1024;
    const off = this.rawI32(0x88);
    if (off < 0) return [];
    const count = this.rawI32(off);
    const jobs: JobInfo[] = [];
    let p = off + 4;
    for (let i = 0; i < count; i++, p += 0x44) {
      jobs.push({
        name: decodeZ(this.dec, p, p + 0x40),
        offset: (this.decI32(p + 0x40)) >>> 0,
        arraySize,
        usesName: null,
      });
    }
    return jobs;
  }

  private readTables(): { tables: TableInfo[]; index: Map<string, number> } {
    const off = this.rawI32(0x84);
    const tables: TableInfo[] = [];
    const index = new Map<string, number>();
    if (off < 0) return { tables, index };
    const count = this.decI32(off);
    let p = off + 4;
    for (let i = 0; i < count; i++, p += 0x50) {
      const t: TableInfo = {
        name: decodeZ(this.dec, p, p + 0x40),
        columnOffset: this.decI32(p + 0x40) >>> 0,
        columns: this.decI32(p + 0x48) >>> 0,
        rows: this.decI32(p + 0x4c) >>> 0,
      };
      tables.push(t);
      index.set(t.name.toUpperCase(), i);
    }
    return { tables, index };
  }

  /** Builds row/column offsets for a table (row 0 is the header). */
  indexTable(t: TableInfo): void {
    if (t.entries) return;
    const entries: number[][] = [];
    const colIdx = new Map<string, number>();
    let p = t.columnOffset;
    const d = this.dec;
    for (let r = 0; r < t.rows + 1; r++) {
      const row: number[] = [];
      for (let c = 0; c < t.columns; c++) {
        row.push(p);
        let l = 0;
        while (l < 1024 && p < d.length && d[p] !== 0) {
          p++;
          l++;
        }
        if (r === 0) colIdx.set(decode(d, row[c], p).toUpperCase(), c);
        p++; // skip NUL
      }
      entries.push(row);
    }
    t.entries = entries;
    t.columnIndex = colIdx;
  }

  stringAt(off: number): string {
    return decodeZ(this.dec, off, Math.min(this.dec.length, off + 1024));
  }

  /** Returns a table as array of rows (first row = column names). */
  tableRows(name: string): string[][] | null {
    const idx = this.tableIndex.get(name.toUpperCase());
    if (idx === undefined) return null;
    const t = this.tables[idx];
    this.indexTable(t);
    return t.entries!.map((row) => row.map((o) => this.stringAt(o)));
  }

  get descriptions(): Descriptions {
    if (this._descriptions) return this._descriptions;
    const res: Descriptions = { global: [], jobs: new Map() };
    const off = this.rawI32(0x90);
    if (off < 0) {
      this._descriptions = res;
      return res;
    }
    const numBytes = this.rawI32(off);
    let list: string[] = [];
    let prevJob: string | null = null;
    let line: number[] = [];
    const flush = () => {
      const comment = decode(Uint8Array.from(line));
      if (/^JOBNAME:/i.test(comment)) {
        if (prevJob === null) res.global = list;
        else if (!res.jobs.has(prevJob)) res.jobs.set(prevJob, list);
        list = [];
        prevJob = comment.substring(8);
      }
      list.push(comment);
      line = [];
    };
    for (let i = 0; i < numBytes; i++) {
      const b = this.dec[off + 4 + i];
      if (b === 10) flush();
      else {
        line.push(b);
        if (line.length >= 1097) flush();
      }
    }
    if (prevJob === null) res.global = list;
    else if (!res.jobs.has(prevJob)) res.jobs.set(prevJob, list);
    this._descriptions = res;
    return res;
  }
}

/** Parsed job documentation (from the descriptions block). */
export interface JobDoc {
  name: string;
  comments: string[];
  args: { name: string; type: string; comments: string[] }[];
  results: { name: string; type: string; comments: string[] }[];
}

export function parseJobDoc(prg: PrgFile, jobName: string): JobDoc | null {
  const lines = prg.descriptions.jobs.get(jobName.toUpperCase()) ?? prg.descriptions.jobs.get(jobName);
  if (!lines) return null;
  const doc: JobDoc = { name: jobName, comments: [], args: [], results: [] };
  let cur: { name: string; type: string; comments: string[] } | null = null;
  let mode: 'job' | 'arg' | 'res' = 'job';
  for (const l of lines) {
    const c = l.indexOf(':');
    if (c < 0) continue;
    const key = l.substring(0, c).toUpperCase();
    const value = l.substring(c + 1);
    switch (key) {
      case 'JOBCOMMENT':
        doc.comments.push(value);
        break;
      case 'ARG':
        cur = { name: value, type: '', comments: [] };
        doc.args.push(cur);
        mode = 'arg';
        break;
      case 'ARGTYPE':
        if (cur && mode === 'arg') cur.type = value;
        break;
      case 'ARGCOMMENT':
        if (cur && mode === 'arg') cur.comments.push(value);
        break;
      case 'RESULT':
        cur = { name: value, type: '', comments: [] };
        doc.results.push(cur);
        mode = 'res';
        break;
      case 'RESULTTYPE':
        if (cur && mode === 'res') cur.type = value;
        break;
      case 'RESULTCOMMENT':
        if (cur && mode === 'res') cur.comments.push(value);
        break;
    }
  }
  return doc;
}
