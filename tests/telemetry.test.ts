import { describe, expect, it } from 'vitest';
import type { Value } from '../src/core/api/DiagSession';
import { FuelEstimator, fmtMetric, isBad, parseGear, parseSelector, snapshot } from '../src/core/api/telemetry';

const v = (key: string, value: number | string, unit = ''): Value => ({ key, label: key, value, unit });

// names as the MS43 data block (STATUS_MESSWERTEBLOCK) and GS8.60.4 STATUS_IO_LESEN report them
const DME = [
  v('STAT_MOTORDREHZAHL_MWB_WERT', 2400, '1/min'),
  v('STAT_GESCHWINDIGKEIT_MWB_WERT', 96, 'km/h'),
  v('STAT_MOTORTEMP_MWB_WERT', 97.5, '°C'),
  v('STAT_KUEHLW_AUSL_TEMP_MWB_WERT', 82.5, '°C'),
  v('STAT_OEL_TEMP_MWB_WERT', 104.25, '°C'),
  v('STAT_LMM_MASSE_MWB_WERT', 72, 'kg/h'),
  v('STAT_PWG_WINKEL_MWB_WERT', 18, '%'),
  v('STAT_LAMBDA_INTEGRATOR_1_MWB_WERT', 1.031, '-'),
  v('STAT_LAMBDA_INTEGRATOR_2_MWB_WERT', 0.985, '-'),
  v('STAT_UBATT_MWB_WERT', 14.1, 'V'),
  v('STAT_VANOS_NW_LAGE_EINLASS_MWB_WERT', 104, '°KW'),
  v('STAT_VANOS_NW_LAGE_AUSLASS_MWB_WERT', -91, '°KW'),
  v('STAT_EINSPRITZZEIT_MWB_WERT', 4.1, 'ms'),
];
const EGS = [
  v('STAT_GETRIEBETEMPERATUR_WERT', 81, '°C'),
  v('STAT_STEGDREHZAHL_WERT', 2384, '1/min'),
  v('STAT_MOTORDREHZAHL_WERT', 2400, '1/min'),
  v('STAT_GANG_WERT', 4),
  v('STAT_WAEHLHEBEL_POSITION_TEXT', 'D'),
  v('STAT_MOTORTEMPERATUR_WERT', 97, '°C'),
];

describe('telemetry values', () => {
  it('picks and converts the MS43 / GS8.60.4 values', () => {
    const s = snapshot({ DME, EGS });
    expect(s.v.rpm).toBe(2400);
    expect(s.v.speed).toBe(96);
    expect(s.v.ect).toBe(97.5); // from the DME, not the gearbox copy
    expect(s.v.oil).toBe(104.25);
    expect(s.v.rad).toBe(82.5);
    expect(s.v.maf).toBeCloseTo(20, 5); // 72 kg/h = 20 g/s
    expect(s.v.stft1).toBeCloseTo(3.1, 5);
    expect(s.v.stft2).toBeCloseTo(-1.5, 5);
    expect(s.v.vin).toBe(104);
    expect(s.v.vex).toBe(-91);
    expect(s.v.atf).toBe(81);
    expect(s.v.ubatt).toBe(14.1);
    expect(s.gear).toBe('4');
    expect(s.selector).toBe('D');
    expect(s.v.slip).toBe(16); // engine − turbine
    expect(s.lockup).toBe(true);
    expect(s.lockupEstimated).toBe(true);
    expect(s.used.has('DME|STAT_MOTORDREHZAHL_MWB_WERT')).toBe(true);
  });
  it('finds VANOS from the target/actual jobs and works without a gearbox', () => {
    const s = snapshot({ DME: [v('STAT_VANOS_NW_LAGE_EINLASS_SOLL_WERT', 110), v('STAT_VANOS_NW_LAGE_EINLASS_IST_WERT', 108)], EGS: [] });
    expect(s.v.vin).toBe(108);
    expect(s.gear).toBeUndefined();
    expect(s.lockup).toBeUndefined();
  });
  it('reads the OBD-II PIDs in plug-and-play mode', () => {
    const s = snapshot({ DME: [v('OBD_0C', 850, 'rpm'), v('OBD_0D', 0, 'km/h'), v('OBD_05', 92, '°C'), v('OBD_10', 4.2, 'g/s'), v('OBD_06', -2.3, '%'), v('OBD_42', 14.2, 'V')], EGS: [] });
    expect(s.v.rpm).toBe(850);
    expect(s.v.maf).toBe(4.2);
    expect(s.v.stft1).toBe(-2.3);
    expect(s.v.ubatt).toBe(14.2);
  });
  it('shows sport and manual on the selector', () => {
    expect(parseSelector(v('X', 'S')).sel).toBe('S');
    expect(parseSelector(v('X', 'M4'))).toEqual({ sel: 'S', manual: true });
    expect(parseSelector(v('X', 'Position N')).sel).toBe('N');
    const s = snapshot({ DME, EGS: [...EGS.filter((x) => !/WAEHLHEBEL/.test(x.key)), v('STAT_SPORTPROGRAMM_EIN', 1)] });
    expect(s.selector).toBe('S');
    expect(s.mode).toBe('SPORT');
    expect(parseGear(v('X', 'Gang 3'))).toBe('3');
    expect(parseGear(v('X', 'R'))).toBe('R');
  });
  it('flags values outside their range and formats them', () => {
    expect(isBad('ect', 115)).toBe(true);
    expect(isBad('ect', 95)).toBe(false);
    expect(fmtMetric('stft1', 2.04)).toBe('+2.0');
    expect(fmtMetric('maf', undefined)).toBe('—');
  });
});

describe('fuel consumption from the air mass', () => {
  it('gives a plausible km/l and average', () => {
    const f = new FuelEstimator();
    const s = snapshot({ DME, EGS });
    let k: number | undefined;
    for (let i = 0; i <= 60; i++) k = f.update(i * 500, s);
    // 20 g/s air → 1.38 g/s fuel → 6.6 l/h at 96 km/h ≈ 14 km/l
    expect(k).toBeGreaterThan(12);
    expect(k).toBeLessThan(16);
    expect(f.average).toBeGreaterThan(12);
    expect(f.update(31000, snapshot({ DME: DME.map((x) => (/GESCHW/.test(x.key) ? { ...x, value: 0 } : x)), EGS }))).toBeUndefined();
  });
});
