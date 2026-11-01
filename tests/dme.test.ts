// DME calibration (MS42 / MS43): definitions from the ms4x-net XDFs, image identification, checksums and offline
// edits, checked on the stock images of ms4x-net. Those images are not part of this repository: set MS4X_DIR to a
// folder with clones of https://github.com/ms4x-net/ms42 and https://github.com/ms4x-net/ms43 (tests that need them
// are skipped otherwise).
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { COOLING_EDITABLE, COOLING_GROUPS, COOLING_LIMITS, buildEditedImage, capMap, checkDefinitionFits, quantizeAtMost, checkDraft, checkValues, coolingItems, quantize, readItem, writeItem } from '../src/core/dme/calibration';
import { DME_DEFS, defFor } from '../src/core/dme/defs';
import { checkChecksums, crc16, fixCalibrationChecksums, identifyImage } from '../src/core/dme/image';

const MS4X_DIR = process.env.MS4X_DIR ?? '/home/claude/ms4x-net';
const have = existsSync(join(MS4X_DIR, 'ms43/firmware'));
const images = (fam: 'ms42' | 'ms43') =>
  have ? readdirSync(join(MS4X_DIR, fam, 'firmware')).filter((f) => f.endsWith('.bin')).map((f) => join(MS4X_DIR, fam, 'firmware', f)) : [];
const load = (p: string) => new Uint8Array(readFileSync(p));
/** ms4x-net's own note: this image stores a calibration CRC its content does not give (also found by rudywolf). */
const KNOWN_BAD = 'Siemens_MS43_MS430069_E39_M54B25_EU4_LHD.bin';
const B25 = join(MS4X_DIR, 'ms43/firmware/Siemens_MS43_MS430069_E46_M54B25_EU4_LHD.bin');
const SHOWN = COOLING_GROUPS.flatMap((g) => g.items);
const M52 = join(MS4X_DIR, 'ms42/firmware/Siemens_MS42_0110C6_E46_M52TUB25_EU3_LHD.bin');

describe('DME definitions', () => {
  it('cover the MS43 and MS42 software versions, every item inside the calibration', () => {
    expect(DME_DEFS.versions.map((v) => v.version)).toEqual(['430037', '430055', '430056', '430064', '430066', '430069', '0110C6']);
    for (const v of DME_DEFS.versions) {
      expect(v.calSize).toBe(v.family === 'MS43' ? 0x10000 : 0x8000);
      for (const i of v.items) {
        expect(i.raw.addr + i.rows * i.cols * (i.raw.bits / 8)).toBeLessThanOrEqual(v.calSize);
        expect(Number.isFinite(i.scale) && i.scale !== 0).toBe(true);
      }
      const names = coolingItems(v).flatMap((g) => g.items.map((i) => i.name));
      expect(names).toContain('id_tco_sp_ect__n__maf_sub');
      expect(names).toContain('id_tco_sp_ect_acin__n__maf_sub');
    }
  });

  it('CRC-16 is the reflected 0xA001 one', () => {
    expect(crc16(new TextEncoder().encode('123456789'), 0)).toBe(0xbb3d); // CRC-16/ARC check value
  });
});

describe.skipIf(!have)('stock images (ms4x-net)', () => {
  it('identifies every image and its checksums check out', () => {
    const all = [...images('ms43'), ...images('ms42')];
    expect(all.length).toBeGreaterThanOrEqual(30);
    for (const p of all) {
      const b = load(p);
      const info = identifyImage(b);
      expect(info.kind).toBe('full');
      expect(p).toContain(info.family === 'MS43' ? `MS43_MS${info.version}` : `MS42_${info.version}`);
      expect(info.programVersion).toBe(info.version);
      expect(info.def?.version).toBe(info.version);
      const sums = checkChecksums(b, info);
      expect(sums.length).toBe(info.family === 'MS43' ? 4 : 2);
      const bad = sums.filter((s) => !s.ok).map((s) => s.name);
      expect(bad).toEqual(p.endsWith(KNOWN_BAD) ? ['Calibration CRC-16'] : []);
      expect(checkDefinitionFits(b, info, info.def!, SHOWN)).toEqual([]);
    }
  });

  it('reads a calibration-only read (64 KB / 32 KB) too', () => {
    const b = load(B25).slice(0x70000);
    const info = identifyImage(b);
    expect(info).toMatchObject({ family: 'MS43', version: '430069', kind: 'calibration', calStart: 0 });
    expect(checkChecksums(b, info).map((s) => [s.name, s.ok])).toEqual([['Calibration CRC-16', true]]);
    const m = load(M52).slice(0x48000, 0x50000);
    const mi = identifyImage(m);
    expect(mi).toMatchObject({ family: 'MS42', version: '0110C6', kind: 'calibration' });
    expect(checkChecksums(m, mi).every((s) => s.ok)).toBe(true);
  });

  it('decodes the M54 e-thermostat maps', () => {
    const b = load(B25);
    const info = identifyImage(b);
    const def = info.def!;
    const off = readItem(b, info, def, def.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!);
    expect(off.y).toEqual([416, 640, 896, 1312, 1504, 2016, 3008, 3712, 4000, 4992, 6016, 6496]);
    expect(off.x!.length).toBe(6);
    expect(off.values[0]).toEqual([102, 102, 102, 102, 87, 87]);
    expect(off.values[11]).toEqual([87, 87, 87, 87, 87, 87]);
    const ac = readItem(b, info, def, def.items.find((i) => i.name === 'id_tco_sp_ect_acin__n__maf_sub')!);
    expect(ac.values[0]).toEqual([102, 102, 102, 102, 80.25, 80.25]);
    const pre = readItem(b, info, def, def.items.find((i) => i.name === 'c_tco_sp_toil_min')!);
    expect(pre.values).toEqual([[105]]);
    // MS42 has the maps too
    const m = load(M52);
    const mi = identifyImage(m);
    const mm = readItem(m, mi, mi.def!, mi.def!.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!);
    expect(mm.values.flat().every((v) => v >= 80 && v <= 115)).toBe(true);
  });

  it('notices a definition from another version', () => {
    const b = load(B25);
    const info = identifyImage(b);
    const wrong = defFor('MS43', '430037')!;
    const problems = checkDefinitionFits(b, info, wrong);
    expect(problems[0]).toMatch(/definition is for MS43 430037/);
    expect(problems.length).toBeGreaterThan(1); // and its axes do not make sense on this image
    // even if the version strings had agreed, every other MS43 definition fails on the content alone
    for (const d of DME_DEFS.versions.filter((v) => v.family === 'MS43' && v.version !== '430069')) {
      expect(checkDefinitionFits(b, { ...info, version: d.version, programVersion: d.version }, d, SHOWN).length).toBeGreaterThan(0);
    }
  });

  it('edits a map offline and recomputes the calibration checksums', () => {
    for (const p of [B25, M52]) {
      const b = load(p);
      const info = identifyImage(b);
      const def = info.def!;
      const item = def.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!;
      const cur = readItem(b, info, def, item);
      const want = cur.values.map((row) => row.map((v) => Math.min(v, 95)));
      const { image, changed } = writeItem(b, info, def, item, want);
      expect(changed.length).toBeGreaterThan(0);
      const lo = info.calStart + item.raw.addr, hi = lo + item.rows * item.cols;
      expect(changed.every((i) => i >= lo && i < hi)).toBe(true);
      expect(checkChecksums(image, info).filter((s) => !s.ok).length).toBeGreaterThan(0); // stale until fixed
      const fixed = fixCalibrationChecksums(b, image, info);
      expect(checkChecksums(fixed.image, info).every((s) => s.ok)).toBe(true);
      const again = readItem(fixed.image, info, def, item);
      expect(again.values).toEqual(want.map((r) => r.map((v) => quantize(item, v).value)));
      // nothing outside the calibration moved
      const diff = [...fixed.image.keys()].filter((i) => fixed.image[i] !== b[i]);
      expect(diff.every((i) => i >= info.calStart && i < info.calStart + info.calSize)).toBe(true);
    }
  });

  it('refuses what it cannot do safely', () => {
    const b = load(B25);
    const info = identifyImage(b);
    const def = info.def!;
    const item = def.items.find((i) => i.name === 'c_tco_sp_toil_min')!;
    expect(checkValues(item, [[300]]).errors.join()).toMatch(/maximum|cannot be stored/);
    expect(() => writeItem(b, info, def, item, [[300]])).toThrow();
    // a program byte changed
    const prog = writeItem(b, info, def, item, [[100.5]]).image;
    prog[0x20000] ^= 1;
    expect(() => fixCalibrationChecksums(b, prog, info)).toThrow(/outside the calibration/);
    // MS43 calibration-only read: the calibration sum cannot be recomputed
    const cal = b.slice(0x70000), ci = identifyImage(cal);
    const calEdit = writeItem(cal, ci, def, item, [[100.5]]).image;
    expect(() => fixCalibrationChecksums(cal, calEdit, ci)).toThrow(/full 512 KB read/);
    // an original that does not pass its own checksum
    const badP = join(MS4X_DIR, 'ms43/firmware', KNOWN_BAD);
    const bad = load(badP), bi = identifyImage(bad);
    const badEdit = writeItem(bad, bi, bi.def!, item, [[100.5]]).image;
    expect(() => fixCalibrationChecksums(bad, badEdit, bi)).toThrow(/does not pass its own checksum/);
    expect(COOLING_EDITABLE).not.toContain('id_ectpwm_add__n__tco_sp');
  });

  it('rejects files that are not a DME read', () => {
    expect(() => identifyImage(new Uint8Array(1000))).toThrow(/Not a Siemens/);
    expect(() => identifyImage(new Uint8Array(0x80000))).toThrow(/No MS42\/MS43 software version/);
  });

  it('factory values of every image sit inside the app limits', () => {
    for (const p of [...images('ms43'), ...images('ms42')]) {
      const b = load(p);
      const info = identifyImage(b);
      for (const [name, [lo, hi]] of Object.entries(COOLING_LIMITS)) {
        const item = info.def!.items.find((i) => i.name === name);
        if (!item) continue;
        const v = readItem(b, info, info.def!, item).values.flat();
        expect(v.every((x) => x >= lo && x <= hi), `${p} ${name} ${v.join(',')}`).toBe(true);
      }
    }
  });

  it('checks a draft and builds the edited file', () => {
    const b = load(B25);
    const info = identifyImage(b);
    const def = info.def!;
    const read = (n: string) => readItem(b, info, def, def.items.find((i) => i.name === n)!);
    const cur = Object.fromEntries(['id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub', 'c_tco_sp_toil_min'].map((n) => [n, read(n)]));
    const off95 = capMap(cur.id_tco_sp_ect__n__maf_sub.values, 95);
    const ac95 = capMap(cur.id_tco_sp_ect_acin__n__maf_sub.values, 95);
    expect(off95[0]).toEqual([95, 95, 95, 95, 87, 87]);
    const mapItem = cur.id_tco_sp_ect__n__maf_sub.item;
    expect(quantize(mapItem, 95).value).toBe(95.25); // 0.75 °C steps
    expect(quantizeAtMost(mapItem, 95)).toBe(94.5);
    expect(quantizeAtMost(mapItem, 87)).toBe(87);
    expect(checkDraft(def, cur, { id_tco_sp_ect__n__maf_sub: off95, id_tco_sp_ect_acin__n__maf_sub: ac95 })).toEqual({ errors: [], warnings: [] });
    // A/C off lowered below the A/C map
    expect(checkDraft(def, cur, { id_tco_sp_ect__n__maf_sub: capMap(off95, 85) }).errors.join()).toMatch(/A\/C on/);
    expect(checkDraft(def, cur, { id_tco_sp_ect__n__maf_sub: capMap(off95, 85), id_tco_sp_ect_acin__n__maf_sub: capMap(ac95, 85) }).warnings.length).toBe(2);
    expect(checkDraft(def, cur, { c_tco_sp_toil_min: [[120]] }).errors.join()).toMatch(/between 85 and 110/);
    expect(checkDraft(def, cur, { id_ectpwm_add__n__tco_sp: [[0]] }).errors.join()).toMatch(/cannot be changed/);

    const out = buildEditedImage(b, info, def, { id_tco_sp_ect__n__maf_sub: off95, id_tco_sp_ect_acin__n__maf_sub: ac95, c_tco_sp_toil_min: [[105]] });
    expect(out.changes.map((c) => c.name)).toEqual(['id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub']);
    expect(out.changes[0].cells.length).toBe(32);
    expect(out.changes[0].cells[0]).toEqual({ row: 0, col: 0, from: 102, to: 95.25 });
    expect(checkChecksums(out.image, info).every((s) => s.ok)).toBe(true);
    expect(() => buildEditedImage(b, info, def, { c_tco_sp_toil_min: [[105]] })).toThrow(/Nothing changed/);
    // a calibration-only MS43 read can be looked at but not turned into a file
    const cal = b.slice(0x70000), ci = identifyImage(cal);
    expect(() => buildEditedImage(cal, ci, def, { id_tco_sp_ect__n__maf_sub: off95, id_tco_sp_ect_acin__n__maf_sub: ac95 })).toThrow(/full 512 KB/);
    // MS42 too
    const m = load(M52), mi = identifyImage(m);
    const mOff = readItem(m, mi, mi.def!, mi.def!.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!).values;
    const mAc = readItem(m, mi, mi.def!, mi.def!.items.find((i) => i.name === 'id_tco_sp_ect_acin__n__maf_sub')!).values;
    const mo = buildEditedImage(m, mi, mi.def!, { id_tco_sp_ect__n__maf_sub: capMap(mOff, 95), id_tco_sp_ect_acin__n__maf_sub: capMap(mAc, 95) });
    expect(checkChecksums(mo.image, mi).every((s) => s.ok)).toBe(true);
  });
});
