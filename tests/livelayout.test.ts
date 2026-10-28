import { describe, expect, it } from 'vitest';
import { barScale, groupOf, groupValues, kindOf, pickPanel, sameValueId, visibleValues } from '../src/core/api/livelayout';
import { evaluate } from '../src/core/api/reference';

const v = (key: string, value: number | string, unit = '') => ({ key, label: key, value, unit });

describe('live data layout', () => {
  it('splits numbers with a bar from states', () => {
    expect(kindOf(v('STAT_MOTORDREHZAHL_MWB_WERT', 730, 'rpm'))).toBe('num');
    expect(kindOf(v('STAT_LAMBDA_INTEGRATOR_1_MWB_WERT', 1.01, '-'))).toBe('num');
    expect(kindOf(v('STAT_MV1_EIN', 0))).toBe('text');
    expect(kindOf(v('STAT_PROG_MODUS', 'A-program'))).toBe('text');
    expect(kindOf(v('STAT_ADAPT_PROG', 1))).toBe('text');
  });

  it('shows each reading once', () => {
    expect(sameValueId('STAT_MOTORDREHZAHL_MWB_WERT')).toBe(sameValueId('STATUS_MOTORDREHZAHL_WERT'));
    expect(sameValueId('STAT_AN_LUFTTEMP_MWB_WERT')).toBe(sameValueId('STATUS_AN_LUFTTEMPERATUR_MWB_WERT'));
    expect(sameValueId('STAT_GANG')).not.toBe(sameValueId('STAT_GANG_TEXT'));
    const vis = visibleValues([v('STAT_GANG', 1), v('STAT_GANG_TEXT', '1st gear'), v('STAT_PROG_MODUS_NR', 0), v('STAT_PROG_MODUS', 'A-program')]);
    expect(vis.map((x) => x.key)).toEqual(['STAT_GANG_TEXT', 'STAT_PROG_MODUS']);
  });

  it('groups by what the value is', () => {
    expect(groupOf('STAT_DREHZAHL_E_LUEFTER_VON_AC_MWB_WERT')).toBe('Heaters & A/C');
    expect(groupOf('STAT_RADDREHZAHL_VL_WERT')).toBe('Wheels & brakes');
    expect(groupOf('STAT_TEMPOMAT_AUS_EIN')).toBe('Cruise control');
    expect(groupOf('STAT_OEL_TEMP_MWB_WERT')).toBe('Temperatures');
    expect(groupOf('STAT_MOTORDREHZAHL_MWB_WERT')).toBe('Engine');
    expect(groupOf('STAT_STEGDREHZAHL_WERT')).toBe('Transmission');
    const g = groupValues([v('STAT_UBATT_MWB_WERT', 14, 'V'), v('STAT_MOTORDREHZAHL_MWB_WERT', 730, 'rpm')], 'ms430ds0');
    expect(g.map((x) => x.name)).toEqual(['Engine', 'Electrical']);
  });

  it('puts the normal band inside the bar', () => {
    const s = barScale(v('STAT_MOTORDREHZAHL_MWB_WERT', 730, 'rpm'));
    expect(s).toEqual({ min: 0, max: 7000 });
    const t = barScale(v('STAT_MOTORTEMP_MWB_WERT', 90, '°C'));
    expect(t.min).toBeLessThan(80);
    expect(t.max).toBeGreaterThan(113);
  });

  it('applies a reference only in its unit', () => {
    const ctx = { idle: false };
    expect(evaluate('STAT_INT_WERT', -2.9, ctx, '%').state).toBe('na');
    expect(evaluate('STAT_INT_WERT', 0.7, ctx, '-').state).toBe('low');
  });

  it('feeds the instrument panel', () => {
    const p = pickPanel([v('STAT_MOTORDREHZAHL_MWB_WERT', 730, 'rpm'), v('STAT_MOTORTEMP_MWB_WERT', 90, '°C'), v('STAT_OEL_TEMP_MWB_WERT', 95, '°C'), v('STAT_UBATT_MWB_WERT', 14, 'V')]);
    expect(p?.tacho).toBe('STAT_MOTORDREHZAHL_MWB_WERT');
    expect(p?.bars.map((b) => b.label)).toEqual(['COOLANT', 'OIL']);
    expect(p?.readout[0].label).toBe('Battery');
    expect(pickPanel([v('STAT_X_EIN', 1)])).toBeUndefined();
  });
});
