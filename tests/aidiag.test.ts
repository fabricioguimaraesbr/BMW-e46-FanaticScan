import { describe, expect, it } from 'vitest';
import type { Dtc, Value } from '../src/core/api/DiagSession';
import { Alerts, GuidedTest, Recorder, STEPS, Scheduler, compareFaults, condition, planChannels } from '../src/core/api/aidiag';
import { aiReportMd, analyzeMd, exportZip, sessionCsv, summary } from '../src/core/api/aiexport';
import { identifyCar } from '../src/core/api/carid';
import { unzip } from '../src/core/util/unzip';

const val = (key: string, value: number | string, unit = ''): Value => ({ key, label: key, value, unit });
const dme = (rpm: number, ect: number, speed: number, pedal: number, integ = 1.0): Value[] => [
  val('STAT_MOTORDREHZAHL_WERT', rpm, '1/min'), val('STAT_MOTORTEMPERATUR_WERT', ect, 'Grad C'), val('STAT_GESCHWINDIGKEIT_WERT', speed, 'km/h'),
  val('STAT_PWG_WINKEL_WERT', pedal, '%'), val('STAT_LAMBDA_INTEGRATOR_1_WERT', integ, ''), val('STAT_LMM_MASSE_WERT', 12, 'kg/h'),
];
const dtc = (hex: string, text = 'fault'): Dtc => ({ code: parseInt(hex, 16), hex, text, textOriginal: text, details: [], present: true, frequency: 1, env: [] });

describe('AI diagnosis reading plan', () => {
  it('reads the DME block every cycle and the rest in turn', () => {
    const ch = planChannels([
      { mod: 'EGS', variant: 'gs8604', jobs: ['STATUS_IO_LESEN'] },
      { mod: 'DME', variant: 'ms430ds0', jobs: ['STATUS_MESSWERTEBLOCK', 'STATUS_VANOS_NW_LAGE_IST_SOLL_REF_EINLASS', 'STATUS_LAMBDA_ADD_1', 'STATUS_KLIMA'] },
      { mod: 'ABS', variant: 'ascmk20', jobs: ['STATUS_IO', 'STATUS_RADGESCHWINDIGKEIT'] },
    ]);
    expect(ch[0]).toMatchObject({ mod: 'DME', job: 'STATUS_MESSWERTEBLOCK', periodMs: 0 });
    expect(ch.map((c) => c.job)).not.toContain('STATUS_KLIMA');
    expect(ch.find((c) => c.mod === 'ABS')?.job).toBe('STATUS_RADGESCHWINDIGKEIT');
    const s = new Scheduler(ch);
    // first cycle: DME block + the most overdue other group (only one extra per cycle)
    const first = s.next(1000);
    expect(first[0]).toBe(0);
    expect(first.length).toBe(2);
    for (const i of first) s.done(i, 1000);
    const second = s.next(1100);
    expect(second[0]).toBe(0);
    expect(second.length).toBe(2);
    expect(second[1]).not.toBe(first[1]);
  });
});

describe('driving condition', () => {
  it('splits cold, idle, cruise, high load and overrun', () => {
    expect(condition({ ect: 50, rpm: 800, speed: 0 })).toBe('cold');
    expect(condition({ ect: 95, rpm: 700, speed: 0 })).toBe('idle');
    expect(condition({ ect: 95, rpm: 2500, speed: 80, pedal: 20 })).toBe('cruise');
    expect(condition({ ect: 95, rpm: 4500, speed: 60, pedal: 95 })).toBe('high_load');
    expect(condition({ ect: 95, rpm: 2000, speed: 60, pedal: 0 })).toBe('overrun');
  });
});

describe('guided test', () => {
  it('counts only while the condition holds and moves on', () => {
    const g = new GuidedTest();
    g.start();
    expect(g.phase).toBe('warmup');
    // already warm: done at once
    g.update(0, { ect: 90, rpm: 700, speed: 0 });
    expect(g.phase).toBe('idle');
    let t = 0;
    for (let i = 0; i < 60; i++) g.update((t += 1000), { ect: 90, rpm: 700, speed: 0 });
    // driving off does not count for the idle step
    for (let i = 0; i < 30; i++) g.update((t += 1000), { ect: 90, rpm: 2000, speed: 40 });
    expect(g.phase).toBe('idle');
    for (let i = 0; i < 62; i++) g.update((t += 1000), { ect: 90, rpm: 700, speed: 0 });
    expect(g.phase).toBe('idle_load');
    g.skip();
    expect(g.phase).toBe('cruise');
    expect(g.state[STEPS.findIndex((s) => s.id === 'idle_load')]).toBe('skipped');
    g.stop();
    expect(g.phase).toBe('free');
  });
});

describe('alerts', () => {
  it('raises once after the hold time and clears', () => {
    const a = new Alerts();
    const v = { ect: 95, rpm: 700, speed: 0, stft1: 14 };
    expect(a.update(0, v, 'idle')).toEqual([]);
    const on = a.update(9000, v, 'idle');
    expect(on.map((x) => x.id)).toContain('stft1');
    expect(a.update(10000, v, 'idle').map((x) => x.id)).not.toContain('stft1');
    const off = a.update(11000, { ...v, stft1: 2 }, 'idle');
    expect(off.find((x) => x.id === 'stft1')?.on).toBe(false);
  });
});

describe('faults start/end', () => {
  it('marks new, persisting and cleared faults', () => {
    const l = compareFaults([
      { t: 1, when: 'start', mod: 'DME', name: 'Engine', variant: 'ms430ds0', dtcs: [dtc('2A'), dtc('3B')] },
      { t: 2, when: 'end', mod: 'DME', name: 'Engine', variant: 'ms430ds0', dtcs: [dtc('2A'), dtc('4C')] },
      { t: 2, when: 'end', mod: 'EGS', name: 'Gearbox', variant: 'gs8604', dtcs: [dtc('11')] },
    ]);
    const st = (m: string, h: string) => l.find((x) => x.mod === m && x.dtc.hex === h)?.status;
    expect(st('DME', '2A')).toBe('persists');
    expect(st('DME', '4C')).toBe('new');
    expect(st('DME', '3B')).toBe('cleared');
    expect(st('EGS', '11')).toBe('end_only');
  });
});

describe('recording and export', () => {
  const car = identifyCar({ dmeVariant: 'ms430ds0', dmeIdent: { ID_MOTOR: 'M54_25' }, egsVariant: 'gs8604', egsScanned: true });
  const info = { app: 'v1.12.0', car, modules: [{ short: 'DME', name: 'Engine (DME)', variant: 'ms430ds0', ident: { ID_BMW_NR: '7545150', ID_VIN: 'WBAAV51010FK12345' } }], connection: 'K+DCAN cable', now: Date.UTC(2026, 10, 20, 12) };
  function recording() {
    const r = new Recorder();
    const d = r.channelIndex('DME', 'ms430ds0', 'STATUS_MESSWERTEBLOCK');
    const e = r.channelIndex('EGS', 'gs8604', 'STATUS_IO_LESEN');
    let t = Date.UTC(2026, 10, 20, 11);
    r.event(t, 'start', 'recording started');
    for (let i = 0; i < 50; i++) {
      t += 150;
      r.add(t, d, dme(700, 95, 0, 0, 1.12), true, 'idle');
      if (i % 2) r.add(t + 10, e, [val('STAT_GETRIEBETEMPERATUR_WERT', 80, 'Grad C'), val('STAT_GANG_TEXT', 'N')], false, 'idle');
    }
    for (let i = 0; i < 50; i++) {
      t += 150;
      r.add(t, d, dme(2500, 98, 80, 20, 1.01), true, 'cruise');
    }
    r.faults.push({ t, when: 'start', mod: 'DME', name: 'Engine', variant: 'ms430ds0', dtcs: [dtc('2A', 'Lambda control bank 1')] });
    return r;
  }

  it('writes one line per engine read with the gearbox values carried forward', () => {
    const csv = sessionCsv(recording()).trim().split('\n');
    expect(csv.length).toBe(101);
    const head = csv[0].split(',');
    expect(head).toContain('key.stft1 (%)');
    expect(head).toContain('EGS.GETRIEBETEMPERATUR [Grad C]');
    const row = csv[5].split(',');
    expect(row[head.indexOf('phase')]).toBe('idle');
    expect(row[head.indexOf('condition')]).toBe('idle');
    expect(Number(row[head.indexOf('key.stft1 (%)')])).toBeCloseTo(12, 5);
    expect(Number(row[head.indexOf('key.maf (g/s)')])).toBeCloseTo(12 / 3.6, 2);
    expect(row[head.indexOf('EGS.GETRIEBETEMPERATUR [Grad C]')]).toBe('80');
  });

  it('summarises by condition', () => {
    const s = summary(recording());
    const idle = s.find((x) => x.metric === 'key.stft1' && x.cond === 'idle')!;
    const cruise = s.find((x) => x.metric === 'key.stft1' && x.cond === 'cruise')!;
    expect(idle.mean).toBeCloseTo(12, 3);
    expect(cruise.mean).toBeCloseTo(1, 3);
    expect(s.find((x) => x.metric === 'key.stft1' && x.cond === 'all')!.n).toBe(100);
  });

  it('keeps only the last 60 minutes', () => {
    const r = recording();
    const last = r.rows[r.rows.length - 1].t;
    r.prune(last + 60 * 60 * 1000 - 5000);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.t >= last - 5000)).toBe(true);
  });

  it('builds the zip with the guide, masking the VIN', async () => {
    const bytes = await exportZip(recording(), info);
    const files = await unzip(bytes);
    expect(files.map((f) => f.name).sort()).toEqual(['ANALYZE.md', 'car.json', 'events.csv', 'faults.csv', 'session.csv', 'summary.csv']);
    const car = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === 'car.json')!.data));
    expect(car.car).toMatchObject({ model: '325i', dme_family: 'MS43' });
    expect(JSON.stringify(car)).not.toContain('12345');
    const md = new TextDecoder().decode(files.find((f) => f.name === 'ANALYZE.md')!.data);
    expect(md).toContain('Answer in the language the user writes to you');
    expect(md).toContain('325i');
    const faults = new TextDecoder().decode(files.find((f) => f.name === 'faults.csv')!.data);
    expect(faults).toContain('start_only');
  });

  it('single-file report has the guide and the data', () => {
    const md = aiReportMd(recording(), info);
    expect(md).toContain('# BMW E46 recording: instructions and data');
    expect(md).toContain('key.stft1');
    expect(md).toContain('Lambda control bank 1');
    expect(md).not.toContain('| `session.csv` |');
    expect(analyzeMd(info)).toContain('Gearbox oil');
  });
});
