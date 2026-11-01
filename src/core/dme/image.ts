// Siemens MS42 / MS43 flash images: which DME and software version an image is, and the checksums the DME checks
// before it lets the engine start. Nothing here talks to the car.
//
// Layout (MS4X wiki, "Siemens MS43" / "Siemens MS42"):
//   MS43 512 KB: boot 0x00000, program 0x10000-0x6FFFF, calibration 0x70000-0x7FFFF (64 KB)
//   MS42 512 KB: calibration 0x48000-0x4FFFF (32 KB), program from 0x50000
//   A "calibration read" is just the calibration (64 / 32 KB).
// The calibration starts with an ASCII header; the software version sits at byte 8 (MS43 "430069", MS42 "0110C6").
//
// Checksums (worked out by rudywolf, https://github.com/therudywolf/MS4X, docs CC BY-SA 4.0, and checked here against
// every stock image of ms4x-net):
//   CRC-16, polynomial 0xA001 reflected, over the blocks of a descriptor: [CRC word][block count][pad][start, end]…
//   (32-bit little-endian physical addresses, end included). The start value is two ASCII bytes of the version string,
//   which for the calibration CRC are bytes 0x0C-0x0D of the calibration ("69" of 430069, "C6" of 0110C6).
//     MS43: calibration descriptor 0x73FE0, program descriptor 0x6FDE0 (start value through the pointer at 0x6ED42)
//     MS42: calibration descriptor 0x4FEE0, program descriptor 0x50306 (start value at 0x50032)
//   MS43 also keeps two 32-bit sums (seed + the 16-bit words of two [start, end) ranges), described in the program at
//     0x6FDAE (program sum: stored, seed 0x6FDB2, ranges 0x6FDBE) and 0x72FFC (calibration sum: seed 0x6FDB8,
//     ranges 0x6FDCE). The calibration sum lies inside the calibration CRC, so it has to be fixed first.
//
// Rule used by fixChecksums: a checksum is only recomputed when the same computation gave the stored value on the
// image as it was read. If it did not, the app does not understand that image well enough to change it.

import { DME_DEFS, type DmeFamily, type DmeVersionDef, defFor } from './defs';

export type ImageKind = 'full' | 'calibration';

export interface DmeImageInfo {
  family: DmeFamily;
  version: string;
  kind: ImageKind;
  /** where the calibration starts in this file */
  calStart: number;
  calSize: number;
  /** software version found in the program part of a full image (should equal `version`) */
  programVersion?: string;
  def?: DmeVersionDef;
  /** the calibration header, for display */
  header: string;
}

export interface ChecksumCheck {
  name: string;
  /** file offset of the stored value */
  at: number;
  stored: number;
  computed: number;
  ok: boolean;
  /** this checksum covers calibration bytes (the only ones the app may change) */
  calibration: boolean;
}

const LAYOUT: Record<DmeFamily, { full: number; calStart: number; calSize: number; programIdent: [number, number] }> = {
  // programIdent: range of the full image searched for the version string outside the calibration
  MS43: { full: 0x80000, calStart: 0x70000, calSize: 0x10000, programIdent: [0x6ff00, 0x70000] },
  MS42: { full: 0x80000, calStart: 0x48000, calSize: 0x8000, programIdent: [0x50000, 0x50100] },
};

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const printable = (s: string) => s.replace(/[^\x20-\x7e]/g, '.');

function versionAt(b: Uint8Array, calStart: number): { family: DmeFamily; version: string } | null {
  const v = ascii(b, calStart + 8, 6);
  if (/^4300\d\d$/.test(v)) return { family: 'MS43', version: v };
  if (/^0110[0-9A-F]{2}$/.test(v)) return { family: 'MS42', version: v };
  return null;
}

/** Identifies a DME image (full 512 KB read or calibration read). Throws with a readable reason when it is not one. */
export function identifyImage(b: Uint8Array): DmeImageInfo {
  const tries: { family: DmeFamily; kind: ImageKind; calStart: number }[] = [];
  for (const family of ['MS43', 'MS42'] as DmeFamily[]) {
    const l = LAYOUT[family];
    if (b.length === l.full) tries.push({ family, kind: 'full', calStart: l.calStart });
    if (b.length === l.calSize) tries.push({ family, kind: 'calibration', calStart: 0 });
  }
  if (!tries.length) {
    throw new Error(`Not a Siemens MS42/MS43 read: ${b.length} bytes (expected 512 KB, or the 64 KB / 32 KB calibration).`);
  }
  for (const t of tries) {
    const v = versionAt(b, t.calStart);
    if (!v || v.family !== t.family) continue;
    const l = LAYOUT[t.family];
    let programVersion: string | undefined;
    if (t.kind === 'full') {
      const area = ascii(b, l.programIdent[0], l.programIdent[1] - l.programIdent[0]);
      const m = (t.family === 'MS43' ? /4300\d\d/ : /0110[0-9A-F]{2}/).exec(area);
      programVersion = m?.[0];
    }
    return {
      family: t.family,
      version: v.version,
      kind: t.kind,
      calStart: t.calStart,
      calSize: l.calSize,
      programVersion,
      def: defFor(t.family, v.version),
      header: printable(ascii(b, t.calStart, 0x30)),
    };
  }
  throw new Error('No MS42/MS43 software version found in the calibration header. The read may be damaged or from another DME.');
}

// ---------------------------------------------------------------------------------------------- checksums
export function crc16(data: Uint8Array, start: number): number {
  let crc = start & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Physical address → offset in this file, or -1 when it is not in it. */
function fileOf(info: DmeImageInfo, phys: number): number {
  const f = info.family === 'MS43' ? phys & 0x7ffff : phys;
  if (info.kind === 'full') return f < 0x80000 ? f : -1;
  const rel = f - LAYOUT[info.family].calStart;
  return rel >= 0 && rel < info.calSize ? rel : -1;
}

interface CrcDesc {
  name: string;
  /** physical address of the descriptor */
  desc: number;
  /** physical address of the two start bytes */
  start: number | { pointer: number };
  calibration: boolean;
}
interface SumDesc {
  name: string;
  stored: number;
  seed: number;
  ranges: number;
  calibration: boolean;
}

const CRCS: Record<DmeFamily, CrcDesc[]> = {
  MS43: [
    { name: 'Calibration CRC-16', desc: 0x73fe0, start: 0x7000c, calibration: true },
    { name: 'Program CRC-16', desc: 0x6fde0, start: { pointer: 0x6ed42 }, calibration: false },
  ],
  MS42: [
    { name: 'Calibration CRC-16', desc: 0x4fee0, start: 0x4800c, calibration: true },
    { name: 'Program CRC-16', desc: 0x50306, start: 0x50032, calibration: false },
  ],
};
const SUMS: Record<DmeFamily, SumDesc[]> = {
  MS43: [
    { name: 'Program 32-bit sum', stored: 0x6fdae, seed: 0x6fdb2, ranges: 0x6fdbe, calibration: false },
    { name: 'Calibration 32-bit sum', stored: 0x72ffc, seed: 0x6fdb8, ranges: 0x6fdce, calibration: true },
  ],
  MS42: [],
};

function crcBlocks(b: Uint8Array, info: DmeImageInfo, d: CrcDesc): [number, number][] | null {
  const at = fileOf(info, d.desc);
  if (at < 0) return null;
  const n = b[at + 2];
  if (!n || n > 16) return null;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const lo = fileOf(info, u32(b, at + 4 + 8 * i)), hi = fileOf(info, u32(b, at + 8 + 8 * i));
    if (lo < 0 || hi < lo) return null;
    out.push([lo, hi]);
  }
  return out;
}

function crcOf(b: Uint8Array, info: DmeImageInfo, d: CrcDesc): ChecksumCheck | null {
  const blocks = crcBlocks(b, info, d);
  const at = fileOf(info, d.desc);
  let startAt: number;
  if (typeof d.start === 'number') startAt = fileOf(info, d.start);
  else {
    const p = fileOf(info, d.start.pointer);
    startAt = p < 0 ? -1 : fileOf(info, u32(b, p));
  }
  if (!blocks || at < 0 || startAt < 0) return null;
  let c = u16(b, startAt);
  for (const [lo, hi] of blocks) c = crc16(b.subarray(lo, hi + 1), c);
  const stored = u16(b, at);
  return { name: d.name, at, stored, computed: c, ok: c === stored, calibration: d.calibration };
}

function sumRanges(b: Uint8Array, info: DmeImageInfo, s: SumDesc): [number, number][] | null {
  const r = fileOf(info, s.ranges);
  if (r < 0) return null;
  const out: [number, number][] = [];
  for (let k = 0; k < 2; k++) {
    const lo = fileOf(info, u32(b, r + 8 * k)), hi = fileOf(info, u32(b, r + 8 * k + 4));
    if (lo < 0 || hi < lo || (hi - lo) & 1) return null;
    out.push([lo, hi]);
  }
  return out;
}

function sumOf(b: Uint8Array, info: DmeImageInfo, s: SumDesc): ChecksumCheck | null {
  const at = fileOf(info, s.stored), seedAt = fileOf(info, s.seed);
  const ranges = sumRanges(b, info, s);
  if (at < 0 || seedAt < 0 || !ranges) return null;
  let sum = u32(b, seedAt);
  for (const [lo, hi] of ranges) for (let i = lo; i < hi; i += 2) sum = (sum + u16(b, i)) >>> 0;
  const stored = u32(b, at);
  return { name: s.name, at, stored, computed: sum, ok: sum === stored, calibration: s.calibration };
}

/**
 * Every checksum the app can compute for this image, stored next to computed. A calibration read cannot show the
 * program checksums, nor the MS43 calibration sum (its seed and ranges are described in the program).
 */
export function checkChecksums(b: Uint8Array, info: DmeImageInfo): ChecksumCheck[] {
  const out: ChecksumCheck[] = [];
  for (const s of SUMS[info.family]) {
    const r = sumOf(b, info, s);
    if (r) out.push(r);
  }
  for (const d of CRCS[info.family]) {
    const r = crcOf(b, info, d);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Recomputes the calibration checksums of `edited`, an edited copy of `original`. Only a checksum that checked out
 * on the original is recomputed (same algorithm, so it is understood for this image); the program part must be
 * unchanged. Returns the fixed copy and what was done, or throws.
 */
export function fixCalibrationChecksums(original: Uint8Array, edited: Uint8Array, info: DmeImageInfo): { image: Uint8Array; fixed: ChecksumCheck[] } {
  if (original.length !== edited.length) throw new Error('The edited image has a different size.');
  if (info.family === 'MS43' && info.kind !== 'full') {
    // the calibration 32-bit sum is described in the program part, which a calibration read does not have
    throw new Error('Changing an MS43 calibration needs a full 512 KB read (the calibration sum is described in the program).');
  }
  const calLo = info.kind === 'full' ? info.calStart : 0;
  const calHi = calLo + info.calSize;
  for (let i = 0; i < edited.length; i++) {
    if ((i < calLo || i >= calHi) && edited[i] !== original[i]) throw new Error(`Byte 0x${i.toString(16)} outside the calibration changed.`);
  }
  const before = checkChecksums(original, info).filter((c) => c.calibration);
  if (!before.some((c) => c.name.includes('CRC'))) throw new Error('The calibration CRC of this image could not be located.');
  const bad = before.filter((c) => !c.ok);
  if (bad.length) throw new Error(`The original read does not pass its own checksum (${bad.map((c) => c.name).join(', ')}). Not changing it.`);

  const img = edited.slice();
  // the 32-bit sum lies inside the CRC area: sums first, then CRCs
  for (const s of SUMS[info.family].filter((x) => x.calibration)) {
    if (!before.some((c) => c.name === s.name)) continue;
    const r = sumOf(img, info, s)!;
    img[r.at] = r.computed & 0xff; img[r.at + 1] = (r.computed >>> 8) & 0xff;
    img[r.at + 2] = (r.computed >>> 16) & 0xff; img[r.at + 3] = (r.computed >>> 24) & 0xff;
  }
  for (const d of CRCS[info.family].filter((x) => x.calibration)) {
    const r = crcOf(img, info, d)!;
    img[r.at] = r.computed & 0xff; img[r.at + 1] = r.computed >>> 8;
  }
  const after = checkChecksums(img, info);
  const wrong = after.filter((c) => !c.ok && before.some((x) => x.name === c.name));
  if (wrong.length) throw new Error(`Checksum still wrong after fixing: ${wrong.map((c) => c.name).join(', ')}.`);
  return { image: img, fixed: after.filter((c) => c.calibration) };
}

/** Versions the app has definitions for, for messages. */
export const SUPPORTED = () => DME_DEFS.versions.map((v) => `${v.family} ${v.version}`).join(', ');
