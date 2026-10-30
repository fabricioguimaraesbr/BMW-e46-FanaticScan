// Coolant gauge curve (the one controlled cluster EEPROM write): curve finding, checks and the write on the
// simulated KOMBI46 / KOMBI46R, without BMW files (plug-and-play) and with them (hybrid).
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { HybridSession } from '../src/core/api/HybridSession';
import { E46_MODULES } from '../src/core/api/modules';
import { ClusterEeprom, clusterKind, hasDs2Link } from '../src/core/coding/clusterEeprom';
import { PRESETS, applyCurve, bufferRange, checkCurve, encodeCurve, findCurve, needleAngle, presetsFor } from '../src/core/coding/gaugeCurve';
import { NativeSession } from '../src/core/native/NativeSession';
import { Kombi46, createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { DriveCycle } from '../src/core/sim/drive';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';
const hex = (s: string) => s.split(/\s+/).map((x) => parseInt(x, 16));

describe('coolant gauge curve', () => {
  it('finds both layouts from the E46Fanatics guide', () => {
    const early = new Uint8Array(512).map((_, i) => (i * 37 + 11) & 0xff);
    early.set(hex('0F 00 32 1F 4B 5A 73 5A 7C 94 7D A4 06 0E 1E 0F'), 0xf0);
    const c = findCurve(early)!;
    expect(c).toMatchObject({ format: 'pairs', offset: 0xf0, length: 12 });
    expect(c.points.map((p) => p.temp)).toEqual([15, 50, 75, 115, 124, 125]);
    expect(c.points.map((p) => p.angle)).toEqual([0, 31, 90, 90, 148, 164]);
    expect(bufferRange(c.points)).toEqual([75, 115]);

    const late = new Uint8Array(2048).map((_, i) => (i * 37 + 11) & 0xff);
    late.set(hex('06 0F 32 4B 73 7D 8F 00 10 2D 2D'), 0x34d); // starts at an odd byte, like in the thread
    const l = findCurve(late)!;
    expect(l).toMatchObject({ format: 'list', offset: 0x34d, length: 7, fixedAngles: true });
    expect(l.points.map((p) => p.temp)).toEqual([15, 50, 75, 115, 125, 143]);
    expect(bufferRange(l.points)).toEqual([75, 115]);
    expect(findCurve(new Uint8Array(512).map((_, i) => (i * 37 + 11) & 0xff))).toBeNull();
  });

  it('encodes the guide revisions byte for byte', () => {
    const rev1 = presetsFor('pairs').find((p) => p.id === 'rev1')!;
    expect(encodeCurve('pairs', rev1.points)).toEqual(hex('0F 00 41 1F 5A 5A 64 5A 6E 94 73 A4'));
    const rev2 = presetsFor('pairs').find((p) => p.id === 'rev2')!;
    expect(encodeCurve('pairs', rev2.points)).toEqual(hex('0F 00 41 1F 5F 5A 69 7C 73 94 78 A4'));
    const late = presetsFor('list').find((p) => p.id === 'rev1')!;
    expect(encodeCurve('list', late.points)).toEqual(hex('06 0F 41 5A 64 6E 73'));
    const m3 = presetsFor('list').find((p) => p.id === 'm3')!;
    expect(encodeCurve('list', m3.points)).toEqual(hex('06 0F 3C 55 5F 69 73'));
    expect(PRESETS.every((p) => !checkCurve(p.points, p.format).errors.length)).toBe(true);
  });

  it('interpolates the needle and rejects unsafe curves', () => {
    const f = presetsFor('pairs')[0].points;
    expect(needleAngle(f, 95)).toBe(90);
    expect(needleAngle(f, 10)).toBe(0);
    expect(needleAngle(f, 120)).toBeCloseTo(90 + (58 * 5) / 9);
    const flat = f.map((p, i) => ({ ...p, temp: i === 3 ? 75 : p.temp }));
    expect(checkCurve(flat, 'pairs').errors.join()).toMatch(/higher than the one before/);
    expect(checkCurve(f.map((p, i) => ({ ...p, angle: i === 0 ? 5 : p.angle })), 'pairs').errors.join()).toMatch(/0°/);
    expect(checkCurve(f.map((p, i) => ({ ...p, temp: i === 5 ? 200 : p.temp })), 'pairs').errors.length).toBeGreaterThan(0);
    expect(checkCurve(f.map((p, i) => ({ ...p, temp: [15, 50, 75, 115, 130, 140][i] })), 'pairs').warnings.join()).toMatch(/red zone starts at 130/);
  });
});

async function native(cluster: 'kombi46' | 'kombi46r') {
  const kombi = new Kombi46(new DriveCycle(340), cluster);
  const channel = new SimChannel([...createE46({ cluster: false }), kombi]);
  const iface = new ObdInterface(channel);
  await iface.connect();
  return { s: new NativeSession({ channel, iface }), kombi };
}

describe('cluster EEPROM on the simulated car', () => {
  it('reads, writes the curve, verifies and restores (KOMBI46, no BMW files)', async () => {
    const { s, kombi } = await native('kombi46');
    const [scan] = await s.scan(E46_MODULES.filter((m) => m.address === 0x80));
    expect(clusterKind(scan.variant, scan.ident)).toBe('kombi46');
    expect(hasDs2Link(s)).toBe(true);
    const e = new ClusterEeprom(s, 'kombi46');
    await expect(e.writeCurve(PRESETS[1].points)).rejects.toThrow(/first/);
    const b = await e.readAll();
    expect(b.image).toEqual(kombi.eeprom);
    const curve = findCurve(b.image)!;
    const rev1 = presetsFor('pairs').find((p) => p.id === 'rev1')!.points;
    const before = kombi.eeprom.slice();
    const r = await e.writeCurve(rev1);
    // only the changed words of the curve: 32→41 (word 79), 4B→5A (7A), 73→64 (7B), 7C→6E (7C), 7D→73 (7D)
    expect(r.words).toEqual([0x79, 0x7a, 0x7b, 0x7c, 0x7d]);
    expect(kombi.writes).toBe(5);
    expect(Array.from(kombi.eeprom.subarray(0xf0, 0x100))).toEqual(hex('0F 00 41 1F 5A 5A 64 5A 6E 94 73 A4 06 0E 1E 0F'));
    for (let i = 0; i < before.length; i++) if (i < 0xf0 || i >= 0xfc) expect(kombi.eeprom[i]).toBe(before[i]);
    expect(applyCurve(before, curve, rev1)).toEqual(kombi.eeprom);
    expect(await e.coolant()).toBeTypeOf('number');
    expect(await e.restart()).toBe(true);
    // restore the original curve from the backup
    await e.restoreCurve(b.original);
    expect(kombi.eeprom).toEqual(before);
  }, 30000);

  it('refuses to write when the cluster changed since the backup', async () => {
    const { s, kombi } = await native('kombi46');
    const e = new ClusterEeprom(s, 'kombi46');
    await e.readAll();
    kombi.eeprom[0xf2] = 0x37; // someone else changed it
    const writes = kombi.writes;
    await expect(e.writeCurve(PRESETS[1].points)).rejects.toThrow(/no longer matches/);
    expect(kombi.writes).toBe(writes);
  }, 30000);

  it('writes only the temperatures of a 2003+ cluster (odd start byte)', async () => {
    const { s, kombi } = await native('kombi46r');
    const [scan] = await s.scan(E46_MODULES.filter((m) => m.address === 0x80));
    expect(clusterKind(scan.variant, scan.ident)).toBe('kombi46r');
    const e = new ClusterEeprom(s, 'kombi46r');
    const b = await e.readAll();
    expect(b.image.length).toBe(2048);
    const m3 = presetsFor('list').find((p) => p.id === 'm3')!.points;
    await e.writeCurve(m3);
    expect(Array.from(kombi.eeprom.subarray(0x34c, 0x35a))).toEqual([b.original[0x34c], ...hex('06 0F 3C 55 5F 69 73 00 10 2D 2D 4F 54')]);
  }, 60000);
});

describe.skipIf(!existsSync(ECU_DIR))('cluster with the BMW files', () => {
  it('identifies KOMBI46, reads its faults, and the gauge tool works on the same line', async () => {
    const channel = new SimChannel(createE46());
    const iface = new ObdInterface(channel);
    await iface.connect();
    const s = new HybridSession(new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface, jobTimeoutMs: 8000 }), new NativeSession({ channel, iface }), () => iface.resetLine());
    const [scan] = await s.scan(E46_MODULES.filter((m) => m.address === 0x80));
    expect(scan.variant).toBe('kombi46');
    const f = await s.readDtcs('kombi46');
    expect(f.error).toBeUndefined();
    // the SGBD's EEPROM jobs stay blocked: the only way to the EEPROM is the gauge tool
    expect((await s.run('kombi46', 'C_FA_AUFTRAG')).error?.text).toMatch(/Blocked/);
    const e = new ClusterEeprom(s, clusterKind(scan.variant, scan.ident)!);
    await e.readAll();
    await e.writeCurve(presetsFor('pairs')[2].points);
    const v = await s.readValues('kombi46', 'STATUS_CAN_KUEHLMITTELTEMP_LESEN');
    expect(v.values.find((x) => x.key === 'STAT_KUEHLMITTELTEMP_WERT')?.value).toBeTypeOf('number');
    s.native.iso.stopKeepAlive();
  }, 60000);
});
