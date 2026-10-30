// Instrument cluster (KOMBI46 / KOMBI46R, DS2 address 0x80) EEPROM access for the coolant gauge curve.
//
// THE ONE CONTROLLED EXCEPTION TO "PERMANENT WRITES ARE BLOCKED" (see safety.ts and CLAUDE.md):
//   - only the instrument cluster, only the bytes of the coolant gauge curve found by gaugeCurve.findCurve;
//   - only after a full EEPROM backup was read in this session (the write compares against it);
//   - right before writing, the curve's words are read again and must still match the backup;
//   - one word per telegram, only the words that change, and every word is read back and compared.
// SGBD jobs are not used here (their EEPROM/coding jobs stay blocked in DiagSession.run): the telegrams are the
// cluster's own DS2 memory services, the same ones BMW's KOMBI46 file and PA Soft use:
//   read   80 09 06 03 00 HI LO N        → 80 LL A0 <2·N bytes> CS       (HI LO = word address, N ≤ 16 words)
//   write  80 0B 07 03 00 HI LO 01 B0 B1 → 80 04 A0 CS                   (A1 = busy, try again)
//   reset  80 04 12                       → software reset of the cluster (it flashes and beeps, then uses the new curve)

import { CurvePoint, GaugeCurve, applyCurve, checkCurve, findCurve } from './gaugeCurve';

export const CLUSTER_ADDRESS = 0x80;

/** A raw DS2 exchange on the K-line: returns the whole answer frame (address, length, status, data, checksum). */
export interface Ds2Link {
  ds2Raw(address: number, data: number[], timeoutMs?: number): Promise<Uint8Array | null>;
}

export const hasDs2Link = (s: unknown): s is Ds2Link => !!s && typeof (s as Ds2Link).ds2Raw === 'function';

export type ClusterKind = 'kombi46' | 'kombi46r';

/** EEPROM size in words of each cluster (from the address ranges in BMW's KOMBI46 / KOMBI46R files). */
export const EEPROM_WORDS: Record<ClusterKind, number> = { kombi46: 0x100, kombi46r: 0x400 };

/** Cluster type from the scan: the SGBD variant, or the diagnosis index of the DS2 ident (53 / 64). */
export function clusterKind(variant: string | null | undefined, ident: Record<string, unknown> = {}): ClusterKind | null {
  const v = (variant ?? '').toLowerCase();
  if (v === 'kombi46' || v === 'kombi46r') return v;
  const diag = String(ident.ID_DIAG_INDEX ?? '').replace(/^0+/, '');
  if (diag === '53') return 'kombi46';
  if (diag === '64') return 'kombi46r';
  return null;
}

export class CodingError extends Error {}

export interface Backup {
  kind: ClusterKind;
  /** what the cluster holds now (kept in step after each write) */
  image: Uint8Array;
  /** the EEPROM exactly as first read in this session */
  original: Uint8Array;
  readAt: number;
  /** identification of the cluster when it was read (for the file name / sanity checks) */
  ident: Record<string, unknown>;
}

export interface WriteReport {
  /** word addresses written */
  words: number[];
  /** the curve as read back from the cluster after the write */
  verified: Uint8Array;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ClusterEeprom {
  private backup: Backup | null = null;

  constructor(private link: Ds2Link, readonly kind: ClusterKind) {}

  get words() {
    return EEPROM_WORDS[this.kind];
  }
  get lastBackup() {
    return this.backup;
  }

  /** Reads `count` words (≤ 16) starting at word address `word`. */
  async readWords(word: number, count: number): Promise<Uint8Array> {
    if (count < 1 || count > 16 || word < 0 || word + count > this.words) throw new CodingError(`Read outside the cluster EEPROM (word ${word.toString(16)})`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.link.ds2Raw(CLUSTER_ADDRESS, [0x06, 0x03, 0x00, word >> 8, word & 0xff, count], 1500);
      if (r && r.length === 4 + count * 2 && r[2] === 0xa0) return r.slice(3, 3 + count * 2);
      if (r && r[2] === 0xa1) {
        await sleep(150);
        continue;
      }
      if (attempt === 2 || !r) throw new CodingError(r ? `The cluster refused the read (status ${r[2]?.toString(16).toUpperCase()})` : 'The cluster did not answer');
    }
    throw new CodingError('The cluster stayed busy');
  }

  /** Full EEPROM image. This is the backup every write is checked against. */
  async readAll(onProgress?: (done: number, total: number) => void, ident: Record<string, unknown> = {}): Promise<Backup> {
    const image = new Uint8Array(this.words * 2);
    for (let w = 0; w < this.words; w += 16) {
      onProgress?.(w, this.words);
      image.set(await this.readWords(w, Math.min(16, this.words - w)), w * 2);
    }
    onProgress?.(this.words, this.words);
    this.backup = { kind: this.kind, image, original: image.slice(), readAt: Date.now(), ident };
    return this.backup;
  }

  /** Uses a backup file the user saved earlier (for restore). It must be from a cluster of the same type. */
  adoptBackupFile(image: Uint8Array): void {
    if (image.length !== this.words * 2) throw new CodingError(`This file has ${image.length} bytes; a ${this.kind.toUpperCase()} EEPROM has ${this.words * 2}.`);
  }

  /** Words (address) that a byte range touches. */
  static wordsOf(offset: number, length: number): number[] {
    const out: number[] = [];
    for (let w = offset >> 1; w <= (offset + length - 1) >> 1; w++) out.push(w);
    return out;
  }

  /**
   * Writes a new coolant gauge curve. Everything that could go wrong is checked before the first byte is sent.
   * @param points the new curve (checked with checkCurve)
   */
  async writeCurve(points: CurvePoint[], onStep?: (text: string) => void): Promise<WriteReport> {
    const b = this.backup;
    if (!b) throw new CodingError('Read the cluster EEPROM (backup) first.');
    const curve = findCurve(b.image);
    if (!curve) throw new CodingError('The coolant gauge curve was not found in this cluster: nothing is written.');
    const check = checkCurve(points, curve.format);
    if (check.errors.length) throw new CodingError(check.errors.join(' '));
    return this.writeRegion(curve, applyCurve(b.image, curve, points), onStep);
  }

  /** Puts the curve of a backup image (this session's or a saved file) back. Only the curve bytes are written. */
  async restoreCurve(file: Uint8Array, onStep?: (text: string) => void): Promise<WriteReport> {
    const b = this.backup;
    if (!b) throw new CodingError('Read the cluster EEPROM first, so the restore can be checked against what is in it now.');
    this.adoptBackupFile(file);
    const now = findCurve(b.image);
    const old = findCurve(file);
    if (!now || !old) throw new CodingError('The coolant gauge curve was not found in the cluster or in the file.');
    if (now.format !== old.format || now.offset !== old.offset) throw new CodingError('The file is from a different cluster layout: not restoring.');
    const target = b.image.slice();
    target.set(file.subarray(old.offset, old.offset + old.length), old.offset);
    return this.writeRegion(now, target, onStep);
  }

  private async writeRegion(curve: GaugeCurve, target: Uint8Array, onStep?: (text: string) => void): Promise<WriteReport> {
    const b = this.backup!;
    // never touch anything outside the curve
    for (let i = 0; i < target.length; i++)
      if (target[i] !== b.image[i] && (i < curve.offset || i >= curve.offset + curve.length)) throw new CodingError('Internal check failed: the change reaches outside the gauge curve. Nothing was written.');
    const words = ClusterEeprom.wordsOf(curve.offset, curve.length);
    const first = words[0];
    // the cluster must still hold exactly what the backup says (no other tool wrote in between, same cluster)
    onStep?.('Checking the cluster against the backup');
    const now = await this.readWords(first, words.length);
    if (!now.every((x, k) => x === b.image[first * 2 + k])) throw new CodingError('The cluster no longer matches the backup read before. Read the EEPROM again. Nothing was written.');
    const changed = words.filter((w) => target[w * 2] !== b.image[w * 2] || target[w * 2 + 1] !== b.image[w * 2 + 1]);
    for (const w of changed) {
      onStep?.(`Writing word ${w.toString(16).toUpperCase().padStart(3, '0')}`);
      await this.writeWord(w, target[w * 2], target[w * 2 + 1]);
    }
    onStep?.('Reading back');
    const verified = await this.readWords(first, words.length);
    const ok = verified.every((x, k) => x === target[first * 2 + k]);
    // keep the backup image in step with the cluster for the next change (the original stays in the saved file)
    b.image.set(verified, first * 2);
    if (!ok) throw new CodingError('Read-back does not match what was written. Restore the backup and check the cable and battery voltage.');
    return { words: changed, verified };
  }

  private async writeWord(word: number, b0: number, b1: number) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.link.ds2Raw(CLUSTER_ADDRESS, [0x07, 0x03, 0x00, word >> 8, word & 0xff, 0x01, b0, b1], 2000);
      if (r && r[2] === 0xa0) return;
      if (r && r[2] !== 0xa1) throw new CodingError(`The cluster refused the write of word ${word.toString(16)} (status ${r[2].toString(16).toUpperCase()})`);
      await sleep(200);
    }
    throw new CodingError(`No confirmation for word ${word.toString(16)}. Read the EEPROM again to see what is in it.`);
  }

  /** Software reset of the cluster (KOMBI46 job SOFTWARE_RESET): it restarts and uses the new curve. */
  async restart(): Promise<boolean> {
    const r = await this.link.ds2Raw(CLUSTER_ADDRESS, [0x12], 1500);
    return !!r && r[2] === 0xa0;
  }

  /** Coolant temperature the cluster receives over CAN (KOMBI46 only), for the live needle preview. */
  async coolant(): Promise<number | null> {
    if (this.kind !== 'kombi46') return null;
    const r = await this.link.ds2Raw(CLUSTER_ADDRESS, [0x06, 0x0a, 0x00, 0x00, 0x99, 0x01], 800);
    return r && r.length >= 5 && r[2] === 0xa0 ? Math.trunc((r[3] * 75) / 100) - 48 : null;
  }
}

/** File name of a backup: e46-kombi46-eeprom-2026-10-29-2130.bin */
export function backupFileName(b: Backup): string {
  const d = new Date(b.readAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `e46-${b.kind}-eeprom-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.bin`;
}
