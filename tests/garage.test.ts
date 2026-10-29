import { describe, expect, it } from 'vitest';
import { addScan, diffScans, emptyGarage, findCarByVin, GarageScan, mergeGarage, normalizeVin, parseGarage } from '../src/core/api/garage';
import { buildReport, maskVinHex, maskVinText } from '../src/core/api/report';
import { resolveTask, SERVICE_TASKS } from '../src/core/api/service';
import type { JobListEntry } from '../src/core/api/DiagSession';

const scan = (id: string, at: string, dme: string[], egs?: string[]): GarageScan => ({
  id,
  at,
  source: 'sim',
  modules: [
    { short: 'DME', name: 'Engine', variant: 'ms430ds0', state: 'read', dtcs: dme.map((c) => ({ code: c, text: c, present: true })) },
    ...(egs ? [{ short: 'EGS', name: 'Gearbox', variant: 'gs8604', state: 'read' as const, dtcs: egs.map((c) => ({ code: c, text: c, present: true })) }] : []),
  ],
});

describe('garage', () => {
  it('compares two scans: new, cleared and still there', () => {
    const d = diffScans(scan('a', '2026-10-01', ['83', '84'], ['61']), scan('b', '2026-10-20', ['84', '20']));
    const dme = d.find((x) => x.module === 'DME')!;
    expect(dme.added.map((x) => x.code)).toEqual(['20']);
    expect(dme.cleared.map((x) => x.code)).toEqual(['83']);
    expect(dme.kept.map((x) => x.code)).toEqual(['84']);
    expect(d.find((x) => x.module === 'EGS')!.onlyIn).toBe('older');
  });

  it('recognises VINs and finds the car by the short VIN', () => {
    expect(normalizeVin(' wbaav31070fm12345 ')).toBe('WBAAV31070FM12345');
    expect(normalizeVin('FM12345')).toBe('FM12345');
    expect(normalizeVin('0000000')).toBeUndefined();
    const g = emptyGarage();
    g.cars.push({ id: 'c1', name: 'My 325i', vin: 'WBAAV31070FM12345', createdAt: '', scans: [] });
    expect(findCarByVin(g, 'FM12345')?.id).toBe('c1');
    addScan(g, 'c1', scan('s1', '2026-10-01', []));
    expect(g.cars[0].scans.length).toBe(1);
  });

  it('exports, imports and merges without duplicates', () => {
    const g = emptyGarage();
    g.cars.push({ id: 'c1', name: 'A', createdAt: '', scans: [scan('s1', '2026-10-01', [])] });
    const copy = parseGarage(JSON.stringify(g));
    copy.cars[0].scans.push(scan('s2', '2026-10-02', ['10']));
    expect(mergeGarage(g, copy)).toEqual({ cars: 0, scans: 1 });
    expect(g.cars[0].scans.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(() => parseGarage('{"x":1}')).toThrow(/not an E46Fanatics Scan garage/);
  });
});

describe('problem report', () => {
  it('masks VINs in text and inside telegrams', () => {
    expect(maskVinText('car WBAAV31070FM12345 ok')).toBe('car WBA************** ok');
    expect(maskVinText('short FM12345')).toBe('short FM*****');
    const hex = [...'XXFM12345'].map((c) => c.charCodeAt(0).toString(16).toUpperCase()).join(' ');
    expect(maskVinHex(hex)).toBe('58 58 46 4D 2A 2A 2A 2A 2A');
  });

  it('splits the log into journal and wire, keeps only identification fields', () => {
    const r = buildReport({
      app: '1.2.0', build: 'x', userAgent: 'ua', platform: 'p', description: 'DME does not answer', page: 'faults', cable: 'FTDI', mode: 'cable', settings: {},
      log: [{ cls: 'tx', text: '10:00:00  → 12 04 00 16' }, { cls: 'job', text: '10:00:01  d_0012.IDENT — OK (90 ms)' }],
      modules: [{ short: 'DME', variant: 'ms430ds0', ident: { ID_BMW_NR: '7545150', AIF_FG_NR: 'WBAAV31070FM12345' } }],
    });
    expect(r.wire).toEqual(['10:00:00 → 12 04 00 16']);
    expect(r.journal.length).toBe(1);
    expect(r.modules[0].ident).toEqual({ ID_BMW_NR: '7545150' });
  });
});

describe('service procedures', () => {
  const job = (name: string, safety: JobListEntry['safety'], args: JobListEntry['args'] = []): JobListEntry => ({ name, comment: name, commentOriginal: '', args, kind: 'other', safety });
  it('resolves against the module file and keeps the safety class', () => {
    const t = SERVICE_TASKS.find((x) => x.id === 'dme-adapt-all')!;
    expect(resolveTask(t, [job('IDENT', 'read')])).toBeNull();
    const r = resolveTask(t, [job('ADAPT_LOESCHEN', 'reset')])!;
    expect(r.safety).toBe('reset');
    const cut = resolveTask(SERVICE_TASKS.find((x) => x.id === 'dme-injector-cut')!, [job('STEUERN_EV_1_AUS', 'test'), job('STEUERN_EV_2_AUS', 'test')])!;
    expect(cut.options.map((o) => o.label)).toEqual(['Cylinder 1', 'Cylinder 2']);
    const sia = resolveTask(SERVICE_TASKS.find((x) => x.id === 'ike-service-reset')!, [job('SIA_RESET', 'write', [{ name: 'ARG1', type: 'int', comment: '' }])])!;
    expect(sia.safety).toBe('write');
  });
});
