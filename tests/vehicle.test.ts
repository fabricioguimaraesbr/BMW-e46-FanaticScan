// Vehicle screen logic and guided checks: factory order, VIN/mileage comparison, check verdicts, and the values the
// checks read from the simulated car through the BMW files.
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { classifyJob } from '../src/core/api/safety';
import { atfVerdict, camStats, lambdaVerdicts, misfireData, misfireVerdicts, pick, sensorStats, thermostatCheck, vanosVerdicts } from '../src/core/api/checks';
import { cleanVin, compareIdentity, paintName, parseFa, saText } from '../src/core/api/vehicle';
import { SIM_FA, createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';

describe('factory order and identity', () => {
  it('parses the FA string', () => {
    const fa = parseFa(`${SIM_FA}+ABCD-EFGH\0\0garbage`)!;
    expect(fa).toMatchObject({ series: 'E46', built: { month: 3, year: 2001 }, typeKey: 'AV31', paint: '0354', upholstery: 'N6SW', eWords: ['ABCD'], hoWords: ['EFGH'] });
    expect(fa.options).toContain('205');
    expect(saText('205')).toBe('Automatic transmission');
    expect(paintName('0354')).toBe('Titanium Silver metallic');
    expect(parseFa('')).toBeNull();
    expect(parseFa('\xff\xff\xff')).toBeNull();
  });
  it('compares VIN and mileage between modules', () => {
    expect(cleanVin('00000000000000000')).toBe('');
    expect(cleanVin(' kl12345 ')).toBe('KL12345');
    const ok = compareIdentity([
      { module: 'IKE', label: '', vin: 'KL12345', odometer: 186432 },
      { module: 'EWS', label: '', vin: 'WBAAV31010KL12345' },
      { module: 'DME', label: '', vin: 'WBAAV31010KL12345', programmedKm: 120000 },
    ]);
    expect(ok.every((f) => f.level !== 'warn')).toBe(true);
    const bad = compareIdentity([
      { module: 'IKE', label: '', vin: 'KL12345', odometer: 90000 },
      { module: 'EWS', label: '', vin: 'KL12345' },
      { module: 'DME', label: '', vin: 'GN55555', programmedKm: 150000 },
    ]);
    expect(bad.filter((f) => f.level === 'warn').map((f) => f.text).join(' ')).toMatch(/DME reports …GN55555.*EWS–DME/s);
    expect(bad.some((f) => /150 000 km, more than the odometer/.test(f.text))).toBe(true);
  });
  it('mileage readings of the cluster are reads, its writes stay blocked', () => {
    expect(classifyJob('AIF_GWSZ_LESEN', 'kombi46')).toBe('read');
    expect(classifyJob('STATUS_AIF_GWSZ_LESEN', 'kombi46r')).toBe('read');
    expect(classifyJob('GWSZ_RESET', 'kombi46')).toBe('write');
    expect(classifyJob('GWSZ_OFFSET_SCHREIBEN', 'kombi46')).toBe('write');
    expect(classifyJob('AIF_GWSZ_LESEN', 'other')).toBe('write');
  });
});

describe('guided check verdicts', () => {
  it('gearbox fluid window', () => {
    expect(atfVerdict([{ t: 0, temp: 22, rpm: 700 }, { t: 60, temp: 26, rpm: 700 }]).text).toMatch(/Check at 30 °C, in about 1:00/);
    expect(atfVerdict([{ t: 0, temp: 38, rpm: 700 }]).level).toBe('ok');
    expect(atfVerdict([{ t: 0, temp: 58, rpm: 700 }]).level).toBe('warn');
    expect(atfVerdict([{ t: 0, temp: 38, rpm: 0 }]).title).toMatch(/engine off/);
  });
  it('thermostat stuck open and healthy warm-up', () => {
    const stuck = Array.from({ length: 100 }, (_, i) => ({ t: i * 10, clt: Math.min(72, 20 + i), out: Math.min(70, 18 + i), rpm: 800, speed: 50 }));
    const r = thermostatCheck(stuck);
    expect(r.verdicts.filter((v) => v.level === 'bad').map((v) => v.title).join()).toMatch(/Radiator hot|Only 72/);
    const good = Array.from({ length: 80 }, (_, i) => ({ t: i * 10, clt: Math.min(96, 20 + i * 1.5), out: Math.min(90, 15 + i * 0.5), rpm: 800, speed: 40 }));
    const g = thermostatCheck(good);
    expect(g.verdicts[0].level).toBe('ok');
    expect(g.timeTo80).toBe(400);
  });
  it('VANOS, oxygen sensors and misfires', () => {
    const follow = Array.from({ length: 30 }, (_, i) => ({ t: i, inSoll: 80 + (i % 10) * 4, inIst: 80 + (i % 10) * 4 - 1, outSoll: -90, outIst: -90, rpm: 2000, clt: 90 }));
    expect(camStats(follow, 'inIst', 'inSoll').meanDev).toBeLessThan(2);
    expect(vanosVerdicts(follow).map((v) => v.level)).toEqual(['ok', 'info']);
    const lag = follow.map((x) => ({ ...x, inIst: 80 }));
    expect(vanosVerdicts(lag)[0].level).toBe('bad');
    const sw = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, v1: i % 4 < 2 ? 0.8 : 0.1, v2: 0.1, int1: 1.0, int2: 1.18, rpm: 800, clt: 90 }));
    expect(sensorStats(sw, 'v1', 'int1').per10s).toBeGreaterThan(5);
    const lv = lambdaVerdicts(sw);
    expect(lv.find((v) => v.title.startsWith('Bank 1'))?.level).toBe('ok');
    expect(lv.filter((v) => v.title.startsWith('Bank 2')).map((v) => v.level)).toEqual(['bad', 'warn']);
    const mv = misfireVerdicts({ rough: [0.3, 0.32, 0.31, 0.3, 1.1, 0.33], count: [0, 0, 0, 0, 6, 0] }, true);
    expect(mv.map((v) => v.title)).toEqual(['Misfires counted on cylinder 5', 'Cylinder 5 runs rougher than the others']);
  });
});

describe.skipIf(!existsSync(ECU_DIR))('vehicle data and check values on the simulated car', () => {
  it('reads FA, VIN, odometer and the check value groups', async () => {
    const ch = new SimChannel(createE46());
    const iface = new ObdInterface(ch);
    await iface.connect();
    const s = new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface });
    const fa = await s.readValues('kombi46', 'C_FA_LESEN');
    expect(parseFa(String(fa.values.find((v) => v.key === 'FAHRZEUGAUFTRAG')?.value))?.typeKey).toBe('AV31');
    expect((await s.readValues('kombi46', 'AIF_FG_NR_LESEN')).values.find((v) => v.key === 'AIF_FG_NR')?.value).toBe('KL12345');
    expect((await s.readValues('kombi46', 'AIF_GWSZ_LESEN')).values.find((v) => v.key === 'STAT_GWSZ_WERT')?.value).toBe(186432);
    const v = await s.readValues('ms430ds0', 'STATUS_VANOS_NW_LAGE_IST_SOLL_REF_EINLASS');
    expect(pick(v.values, /EINLASS_SOLL_WERT$/)).toBeTypeOf('number');
    const lr = await s.readValues('ms430ds0', 'STATUS_SYSTEMCHECK_LAUFUNRUHE');
    const md = misfireData(lr.values);
    expect(md.rough[4]).toBeGreaterThan(md.rough[0]!);
    expect(md.count[4]).toBe(4);
    const egs = await s.readValues('gs8604', 'STATUS_IO_LESEN');
    expect(pick(egs.values, /GETRIEBETEMPERATUR_WERT$/)).toBeTypeOf('number');
  }, 60000);
});
