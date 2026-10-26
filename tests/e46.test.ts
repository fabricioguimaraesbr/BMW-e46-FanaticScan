// End-to-end: EDIABAS VM + ObdInterface (DS2 framing, echo, checksum) + simulated E46 on a byte-level K-line.
// Needs the owner's SGBD folder; set ECU_DIR or keep the default path.
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { E46_MODULES } from '../src/core/api/modules';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';
const has = existsSync(ECU_DIR);

async function session(echo = true) {
  const ch = new SimChannel(createE46(), echo);
  const iface = new ObdInterface(ch);
  await iface.connect();
  return new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface, jobTimeoutMs: 8000 });
}

describe.skipIf(!has)('E46 325i simulated', () => {
  it('scan identifies the car modules through the group files', async () => {
    const s = await session();
    const r = await s.scan(E46_MODULES.slice(0, 4));
    const v = Object.fromEntries(r.map((e) => [e.module.short, e.variant]));
    expect(v).toEqual({ DME: 'ms430ds0', EGS: 'gs8604', ABS: 'ascmk20', EWS: null });
    expect(r[0].ident.ID_BMW_NR).toBe('7545150');
  });

  it('error texts match the BMW Scanner log', async () => {
    const s = await session();
    const dme = await s.readDtcs('d_0012');
    expect(dme.dtcs.map((d) => [d.code, d.text])).toEqual([
      [0x83, 'CAN message timeout instrument cluster 2'],
      [0x84, 'CAN message timeout instrument cluster 3'],
    ]);
    expect(dme.dtcs[0].env.map((e) => e.unit)).toContain('rpm');
    const egs = (await s.readDtcs('d_0032')).dtcs;
    expect(egs.map((d) => d.text)).toEqual(['Battery supply terminal 30']);
    expect(egs[0].textOriginal).toBe('U-Batt. Versorgung Kl. 30');
    const abs = (await s.readDtcs('d_0056')).dtcs;
    expect(abs.map((d) => d.code)).toEqual([0x94, 0x95]);
    expect(abs[1].text).toBe('CAN timeout DME/DDE');
  });

  it('clears the error memory', async () => {
    const s = await session();
    for (const g of ['d_0012', 'd_0032', 'd_0056']) {
      expect((await s.clearDtcs(g)).ok).toBe(true);
      expect((await s.readDtcs(g)).dtcs).toHaveLength(0);
    }
  });

  it('reads the MS43 live data block', async () => {
    const s = await session();
    const r = await s.readValues('d_0012', 'STATUS_MESSWERTEBLOCK');
    const get = (k: string) => r.values.find((v) => v.key === k)!;
    expect(r.error).toBeUndefined();
    expect(get('STAT_MOTORDREHZAHL_MWB_WERT').value).toBeGreaterThan(600);
    expect(get('STAT_MOTORDREHZAHL_MWB_WERT').unit).toBe('rpm');
    expect(get('STAT_UBATT_MWB_WERT').value).toBeCloseTo(14.1, 0);
    expect(r.values.length).toBeGreaterThan(25);
  });

  it('works with cables that do not echo', async () => {
    const s = await session(false);
    expect((await s.readDtcs('d_0032')).dtcs).toHaveLength(1);
  });

  it('lists jobs of a variant', async () => {
    const s = await session();
    const jobs = await s.listJobs('ms430ds0');
    expect(jobs.find((j) => j.name === 'STATUS_MESSWERTEBLOCK')?.kind).toBe('status');
    expect(jobs.find((j) => j.name === 'STEUERN_EKP')?.args).toHaveLength(1);
  });
});
