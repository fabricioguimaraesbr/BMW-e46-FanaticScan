// Reads the flash of a Siemens MS42 / MS43 engine computer through the K-line, read only.
//
// The only telegram sent is the DME's DS2 memory read, the one BMW's own MS430DS0 job SPEICHER_LIN_LESEN builds
// (and RomRaider's DS2 memory read uses):
//   12 09 06 00 HH MM LL NN XX   → 12 LL A0 <NN bytes> XX      (HH MM LL = 24-bit physical address, NN bytes)
// Nothing here writes: there is no erase, write or programming-mode telegram in this file.
//
// What is read:
//   calibration  MS43 0x70000-0x7FFFF (64 KB), MS42 0x48000-0x4FFFF (32 KB): the maps
//   descriptors  the small part of the program that describes the checksums and names the version
//                (MS43 0x6FD00-0x6FFFF, MS42 0x50000-0x5033F), so an edited calibration can get correct checksums
//   full backup  (optional) the whole program as well, 0x10000-0x7FFFF; the boot sector with the immobilizer
//                data (0x00000-0x0FFFF) is never read
// Every read is checked: the calibration must pass its own CRC, a full read its program CRC too.

import type { Ds2Link } from '../coding/clusterEeprom';
import type { DmeFamily } from './defs';
import { type ChecksumCheck, type DmeImageInfo, checkChecksums, identifyImage } from './image';

export const DME_ADDRESS = 0x12;

export class DmeReadError extends Error {}

const LAYOUT: Record<DmeFamily, { cal: [number, number]; desc: [number, number]; probe: number }> = {
  MS43: { cal: [0x70000, 0x80000], desc: [0x6fd00, 0x70000], probe: 0x70000 },
  MS42: { cal: [0x48000, 0x50000], desc: [0x50000, 0x50340], probe: 0x48000 },
};
/** Program part of a full backup (the boot sector below 0x10000 holds immobilizer data and is left out). */
const FULL: [number, number] = [0x10000, 0x80000];
/** Block sizes tried, largest first: a DME that refuses one size gets the next. */
const CHUNKS = [0x80, 0x40, 0x20, 0x10];

export interface DmeReadResult {
  family: DmeFamily;
  version: string;
  /** 512 KB working image; bytes that were not read are 0xFF */
  image: Uint8Array;
  /** file ranges [start, end) that were read */
  known: [number, number][];
  /** the calibration alone, as a calibration read file holds it */
  calibration: Uint8Array;
  full: boolean;
  info: DmeImageInfo;
  sums: ChecksumCheck[];
  chunk: number;
  seconds: number;
}

export interface ReadProgress {
  phase: 'detect' | 'calibration' | 'descriptors' | 'program';
  done: number;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

export class DmeReader {
  private chunk = CHUNKS[0];
  private aborted = false;

  constructor(private link: Ds2Link) {}

  abort() {
    this.aborted = true;
  }

  /** Physical address to ask for a file offset. MS43: external RAM covers 0x40000-0x43FFF, use the flash mirror. */
  static phys(family: DmeFamily, file: number): number {
    if (family === 'MS43' && file >= 0x40000 && file < 0x44000) return 0x80000 | file;
    return file;
  }

  /** One memory read; null when the DME refused (status) or answered with the wrong size. */
  private async readOnce(phys: number, n: number): Promise<{ data?: Uint8Array; status?: number }> {
    const r = await this.link.ds2Raw(DME_ADDRESS, [0x06, 0x00, (phys >> 16) & 0xff, (phys >> 8) & 0xff, phys & 0xff, n], 1500);
    if (!r) return {};
    if (r[2] !== 0xa0) return { status: r[2] };
    if (r.length !== n + 4) return { status: -1 };
    return { data: r.slice(3, 3 + n) };
  }

  /** Reads n bytes (n ≤ chunk) with retries; a size the DME refuses steps the chunk size down. */
  private async block(family: DmeFamily, file: number, n: number): Promise<Uint8Array> {
    let last: number | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.aborted) throw new DmeReadError('Reading stopped.');
      const r = await this.readOnce(DmeReader.phys(family, file), n);
      if (r.data) return r.data;
      last = r.status;
      await sleep(attempt ? 200 : 50);
    }
    const why = last === undefined ? 'did not answer' : last === -1 ? 'answered with the wrong length' : `refused it (status ${hex(last)})`;
    throw new DmeReadError(`Reading the DME at ${hex(file, 5)} failed: the DME ${why}.`);
  }

  private async range(family: DmeFamily, out: Uint8Array, [lo, hi]: [number, number], phase: ReadProgress['phase'], onProgress?: (p: ReadProgress) => void) {
    for (let a = lo; a < hi; a += this.chunk) {
      onProgress?.({ phase, done: a - lo, total: hi - lo });
      out.set(await this.block(family, a, Math.min(this.chunk, hi - a)), a);
    }
    onProgress?.({ phase, done: hi - lo, total: hi - lo });
  }

  /** Finds the family from the calibration header, and the largest block size the DME takes. */
  async detect(hint?: DmeFamily): Promise<DmeFamily> {
    const order: DmeFamily[] = hint === 'MS42' ? ['MS42', 'MS43'] : ['MS43', 'MS42'];
    let refused: number | undefined;
    for (const family of order) {
      for (const size of CHUNKS) {
        if (this.aborted) throw new DmeReadError('Reading stopped.');
        const r = await this.readOnce(LAYOUT[family].probe, size);
        if (!r.data) {
          if (r.status !== undefined && r.status !== -1) refused = r.status;
          continue;
        }
        const v = String.fromCharCode(...r.data.subarray(8, 14));
        if ((family === 'MS43' && /^4300\d\d$/.test(v)) || (family === 'MS42' && /^0110[0-9A-F]{2}$/.test(v))) {
          this.chunk = size;
          return family;
        }
        break; // it answered, but this is not that family's calibration header
      }
    }
    if (refused !== undefined) {
      throw new DmeReadError(`The DME refused to be read (status ${hex(refused)}). Some MS42/MS43 units are locked against reading over the diagnosis line; they can only be read on the bench (boot mode).`);
    }
    throw new DmeReadError('No MS42 or MS43 calibration was found. This read works on the Siemens MS42 (M52TU) and MS43 (M54) engine computers only.');
  }

  /**
   * Reads the calibration and the checksum descriptors (about 1–2 minutes), or with `full` the whole program
   * too (about 12–15 minutes). Throws when the read does not pass the DME's own checksums.
   */
  async read(opts: { full?: boolean; hint?: DmeFamily; onProgress?: (p: ReadProgress) => void } = {}): Promise<DmeReadResult> {
    const t0 = Date.now();
    opts.onProgress?.({ phase: 'detect', done: 0, total: 1 });
    const family = await this.detect(opts.hint);
    const l = LAYOUT[family];
    const image = new Uint8Array(0x80000).fill(0xff);
    const known: [number, number][] = [];
    await this.range(family, image, l.cal, 'calibration', opts.onProgress);
    known.push(l.cal);
    if (opts.full) {
      const parts: [number, number][] = [[FULL[0], l.cal[0]], [l.cal[1], FULL[1]]].filter(([a, z]) => z > a) as [number, number][];
      for (const p of parts) {
        await this.range(family, image, p, 'program', opts.onProgress);
        known.push(p);
      }
    } else {
      await this.range(family, image, l.desc, 'descriptors', opts.onProgress);
      known.push(l.desc);
    }
    known.sort((a, b) => a[0] - b[0]);
    const info = identifyImage(image, known);
    if (info.family !== family) throw new DmeReadError(`Read as ${family}, but the data looks like ${info.family}.`);
    const sums = checkChecksums(image, info);
    const cal = sums.find((s) => s.name === 'Calibration CRC-16');
    if (!cal) throw new DmeReadError('The calibration checksum could not be located in the read.');
    if (!cal.ok) throw new DmeReadError('The calibration read does not match its own checksum: the line may have dropped bytes. Read again.');
    if (opts.full) {
      const prog = sums.find((s) => s.name === 'Program CRC-16');
      if (prog && !prog.ok) throw new DmeReadError('The program part of the read does not match its own checksum. Read again.');
    }
    return {
      family,
      version: info.version,
      image,
      known,
      calibration: image.slice(l.cal[0], l.cal[1]),
      full: !!opts.full,
      info,
      sums,
      chunk: this.chunk,
      seconds: (Date.now() - t0) / 1000,
    };
  }
}

/** File name for a read: family, version and date, like `MS43_430069_cal_2026-11-01.bin`. */
export function readFileName(r: Pick<DmeReadResult, 'family' | 'version' | 'full'>, part: 'cal' | 'full', date = new Date()): string {
  return `${r.family}_${r.version}_${part === 'full' ? 'full512k-noboot' : 'cal'}_${date.toISOString().slice(0, 10)}.bin`;
}
