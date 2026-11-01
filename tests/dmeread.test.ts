// Reading the DME flash (MS43 / MS42) through the K-line, on the simulated car: the made-up 430069 image, a
// read-locked DME, and (with MS4X_DIR) the stock images of ms4x-net served by the simulated DME byte for byte.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildEditedImage, capMap, checkDefinitionFits, coolingItems, readItem } from '../src/core/dme/calibration';
import type { Ds2Link } from '../src/core/coding/clusterEeprom';
import { checkChecksums, identifyImage } from '../src/core/dme/image';
import { DmeReader, readFileName } from '../src/core/dme/reader';
import { NativeSession } from '../src/core/native/NativeSession';
import { createE46 } from '../src/core/sim/e46';
import { makeSimMs43Flash } from '../src/core/sim/ms43Flash';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';

const MS4X_DIR = process.env.MS4X_DIR ?? '/home/claude/ms4x-net';
const B25 = join(MS4X_DIR, 'ms43/firmware/Siemens_MS43_MS430069_E46_M54B25_EU4_LHD.bin');

/** The simulated DME answering directly (no serial timing): for the long reads. */
function direct(dmeFlash?: Uint8Array | 'locked'): Ds2Link {
  const dme = createE46({ cluster: false, dmeFlash }).find((e) => e.address === 0x12)!;
  return {
    async ds2Raw(addr, data) {
      const p = dme.handle(new Uint8Array(data));
      if (!p) return null;
      const f = [addr, p.length + 3, ...p];
      return new Uint8Array([...f, f.reduce((a, b) => a ^ b, 0)]);
    },
  };
}

async function car(dmeFlash?: Uint8Array | 'locked') {
  const channel = new SimChannel(createE46({ cluster: false, dmeFlash }));
  channel.answerDelay = 2;
  const iface = new ObdInterface(channel);
  await iface.connect();
  return new NativeSession({ channel, iface });
}

describe('simulated MS43 flash', () => {
  it('is a consistent made-up 430069 image', () => {
    const b = makeSimMs43Flash();
    const info = identifyImage(b);
    expect(info).toMatchObject({ family: 'MS43', version: '430069', kind: 'full', programVersion: '430069' });
    expect(checkChecksums(b, info).map((s) => [s.name, s.ok])).toEqual([
      ['Program 32-bit sum', true], ['Calibration 32-bit sum', true], ['Calibration CRC-16', true], ['Program CRC-16', true],
    ]);
    const names = coolingItems(info.def!).flatMap((g) => g.items.map((i) => i.name));
    expect(checkDefinitionFits(b, info, info.def!, names)).toEqual([]);
    const map = readItem(b, info, info.def!, info.def!.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!);
    expect(map.values[0]).toEqual([102, 102, 102, 102, 87, 87]);
    expect(map.y![0]).toBe(416);
  });
});

describe('reading the DME through the K-line (simulator)', () => {
  it('reads the calibration and the descriptors through the serial line, and the edit gets correct checksums', async () => {
    const s = await car();
    const progress: string[] = [];
    const r = await new DmeReader(s).read({ onProgress: (p) => { if (!progress.includes(p.phase)) progress.push(p.phase); } });
    expect(progress).toEqual(['detect', 'calibration', 'descriptors']);
    expect(r).toMatchObject({ family: 'MS43', version: '430069', full: false, chunk: 0x80 });
    expect(r.known).toEqual([[0x6fd00, 0x70000], [0x70000, 0x80000]]);
    expect(r.calibration.length).toBe(0x10000);
    const sim = makeSimMs43Flash();
    expect(r.calibration).toEqual(sim.slice(0x70000));
    // the program CRC needs the whole program: not computed on this read; the calibration ones are
    expect(r.sums.map((s) => [s.name, s.ok])).toEqual([['Calibration 32-bit sum', true], ['Calibration CRC-16', true]]);
    expect(r.info.programVersion).toBe('430069');
    // the read keeps what an MS43 edit needs (unlike a 64 KB calibration file)
    const def = r.info.def!;
    const off = readItem(r.image, r.info, def, def.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!).values;
    const ac = readItem(r.image, r.info, def, def.items.find((i) => i.name === 'id_tco_sp_ect_acin__n__maf_sub')!).values;
    const out = buildEditedImage(r.image, r.info, def, { id_tco_sp_ect__n__maf_sub: capMap(off, 95), id_tco_sp_ect_acin__n__maf_sub: capMap(ac, 95) });
    // the edited calibration, put into the real image, passes every checksum of the whole image
    const whole = sim.slice();
    whole.set(out.image.slice(0x70000), 0x70000);
    expect(checkChecksums(whole, identifyImage(whole)).every((c) => c.ok)).toBe(true);
    expect(readFileName(r, 'cal', new Date('2026-11-01T12:00:00Z'))).toBe('MS43_430069_cal_2026-11-01.bin');
  }, 120000);

  it('reads the whole program for a full backup (boot sector left out)', async () => {
    const s = direct();
    const r = await new DmeReader(s).read({ full: true });
    expect(r.known).toEqual([[0x10000, 0x70000], [0x70000, 0x80000]]);
    expect(r.sums.every((c) => c.ok)).toBe(true);
    expect(r.sums.length).toBe(4);
    const sim = makeSimMs43Flash();
    expect(r.image.slice(0x10000)).toEqual(sim.slice(0x10000));
    expect(r.image.subarray(0, 0x10000).every((x) => x === 0xff)).toBe(true);
  }, 300000);

  it('explains a DME that refuses to be read', async () => {
    const s = direct('locked');
    await expect(new DmeReader(s).read()).rejects.toThrow(/refused to be read \(status A1\)/);
  }, 60000);

  it('stops when asked', async () => {
    const s = direct();
    const rd = new DmeReader(s);
    const p = rd.read({ onProgress: (x) => { if (x.phase === 'calibration' && x.done > 0x400) rd.abort(); } });
    await expect(p).rejects.toThrow(/stopped/);
  }, 60000);

  it.skipIf(!existsSync(B25))('reads a stock image byte for byte', async () => {
    const stock = new Uint8Array(readFileSync(B25));
    const s = direct(stock);
    const r = await new DmeReader(s).read();
    expect(r.calibration).toEqual(stock.slice(0x70000));
    expect(r.image.slice(0x6fd00, 0x70000)).toEqual(stock.slice(0x6fd00, 0x70000));
    expect(r.sums.every((c) => c.ok)).toBe(true);
  }, 120000);
});
