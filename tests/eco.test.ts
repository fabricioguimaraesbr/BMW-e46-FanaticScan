import { describe, expect, it } from 'vitest';
import { carLine, familyOfVariant, identifyCar, parseEngine } from '../src/core/api/carid';
import { EcoSample, EcoTracker, ecoProfile } from '../src/core/api/eco';

describe('car identification', () => {
  it('recognises the DME families of the E46 from the module file', () => {
    expect(familyOfVariant('ms430ds0')).toBe('MS43');
    expect(familyOfVariant('MS420DS0')).toBe('MS42');
    expect(familyOfVariant('ms450ds0')).toBe('MS45');
    expect(familyOfVariant('me9n42')).toBe('ME9');
    expect(familyOfVariant('mss54')).toBe('MSS54');
    expect(familyOfVariant('native:12')).toBe('unknown');
  });
  it('reads the engine code', () => {
    expect(parseEngine('M54_25')).toEqual({ code: 'M54B25', liters: 2.5 });
    expect(parseEngine('M54B30')?.code).toBe('M54B30');
    expect(parseEngine('')).toBeUndefined();
  });
  it('puts model and gearbox together', () => {
    const c = identifyCar({ dmeVariant: 'ms430ds0', dmeIdent: { ID_MOTOR: 'M54_25' }, egsVariant: 'gs8604', egsScanned: true });
    expect(c).toMatchObject({ family: 'MS43', engine: 'M54B25', model: '325i', gearbox: 'automatic' });
    expect(carLine(c)).toBe('M54B25 · MS43 · Automatic');
    expect(identifyCar({ dmeVariant: 'ms430ds0', egsVariant: null, egsScanned: true }).gearbox).toBe('manual');
    // plug & play: the engine named by the DME gives the family
    expect(identifyCar({ dmeVariant: 'native:12', dmeIdent: { ID_MOTOR: 'M52_28' } }).family).toBe('MS42');
    // plug & play: the DME part number
    expect(identifyCar({ dmeVariant: 'native:12', dmeIdent: { ID_BMW_NR: '7545150' } }).family).toBe('MS43');
    expect(identifyCar({ dmeVariant: 'native:12', dmeIdent: { ID_BMW_NR: '7531500' } }).family).toBe('MS45');
  });
});

/** a short drive: t in seconds */
function drive(e: EcoTracker, steps: [number, Partial<EcoSample>][]) {
  for (const [t, s] of steps) e.update({ ect: 92, maf: 6, stft1: 1, stft2: -1, ...s, t: t * 1000 });
}

describe('ECO tracker', () => {
  const p = ecoProfile({ family: 'MS43', gearbox: 'automatic' });

  it('sees the fuel cut from the injection time and counts lift-offs below the cut line', () => {
    const e = new EcoTracker(p);
    const steps: [number, Partial<EcoSample>][] = [];
    let t = 0;
    // gentle: lift off at 1300 rpm, injection never 0
    for (let i = 0; i < 10; i++) steps.push([t++, { rpm: 1300, speed: 30, pedal: 20, ti: 3 }]);
    for (let i = 0; i < 5; i++) steps.push([t++, { rpm: 1200 - i * 20, speed: 28, pedal: 0, ti: 2.4 }]);
    // strong: lift off at 2300 rpm, injection to 0
    for (let i = 0; i < 5; i++) steps.push([t++, { rpm: 2300, speed: 50, pedal: 45, ti: 6 }]);
    steps.push([t++, { rpm: 2250, speed: 49, pedal: 0, ti: 2.2 }]);
    for (let i = 0; i < 4; i++) steps.push([t++, { rpm: 2100 - i * 150, speed: 47, pedal: 0, ti: 0 }]);
    drive(e, steps);
    expect(e.liftOffs).toBe(2);
    expect(e.missed).toBe(1);
    expect(e.cutsSeen).toBe(1);
    expect(e.cutSource).toBe('injection');
    expect(e.split().cut).toBeGreaterThan(0);
  });

  it('learns a pedal that rests at 10 % and still sees it released', () => {
    const e = new EcoTracker(p);
    drive(e, [[0, { rpm: 750, speed: 0, pedal: 10 }], [1, { rpm: 2000, speed: 40, pedal: 30 }], [2, { rpm: 1900, speed: 40, pedal: 10.5 }]]);
    expect(e.pedalRest).toBe(10);
    expect(e.isReleased(10.5)).toBe(true);
    expect(e.pedalTravel(30)).toBe(20);
    expect(e.state === 'coast' || e.state === 'cut').toBe(true);
  });

  it('uses the OBD-II fuel status in plug & play mode', () => {
    const e = new EcoTracker(p);
    drive(e, [[0, { rpm: 2000, speed: 40, pedal: 20, fuelStatus: 'Closed loop' }], [1, { rpm: 1900, speed: 39, pedal: 12, fuelStatus: 'Open loop (load/decel)' }]]);
    expect(e.cutSource).toBe('obd');
    expect(e.cut).toBe(true);
    expect(e.lph).toBe(0);
  });

  it('guided test passes when the injection reaches 0 after lifting off above the line', () => {
    const e = new EcoTracker(p);
    e.startTest();
    drive(e, [[0, { rpm: 2200, speed: 45, pedal: 40, ti: 5 }], [1, { rpm: 2150, speed: 45, pedal: 0, ti: 2.5 }], [2, { rpm: 2050, speed: 44, pedal: 0, ti: 0 }]]);
    expect(e.test.state).toBe('pass');
    // pressing the pedal first must not count as released
    const f = new EcoTracker(p);
    f.update({ t: 0, rpm: 2200, speed: 45, pedal: 40, ti: 5, ect: 90 });
    expect(f.state).toBe('drive');
    expect(e.checks().find((c) => c.id === 'cut')?.status).toBe('OK');
  });

  it('flags a cool engine against the thermostat map', () => {
    const e = new EcoTracker(p);
    const steps: [number, Partial<EcoSample>][] = [];
    for (let i = 0; i < 200; i++) steps.push([i, { rpm: 1800, speed: 40, pedal: 20, ti: 3, ect: 94 }]);
    drive(e, steps);
    expect(e.checks().find((c) => c.id === 'ect')?.status).toBe('WATCH');
  });
});
