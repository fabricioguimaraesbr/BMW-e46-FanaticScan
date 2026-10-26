import { describe, expect, it } from 'vitest';
import { engineContext, evaluate } from '../src/core/api/reference';
import { valueLabel, jobLabel } from '../src/core/api/i18n-jobs';

const idle = { idle: true };
const driving = { idle: false };

describe('M54 reference ranges', () => {
  it('flags values out of range', () => {
    expect(evaluate('STAT_MOTORTEMP_MWB_WERT', 92, idle).state).toBe('ok');
    expect(evaluate('STAT_MOTORTEMP_MWB_WERT', 118, idle).state).toBe('high');
    expect(evaluate('STAT_MOTORTEMP_MWB_WERT', 40, idle).state).toBe('cold');
    expect(evaluate('STAT_UBATT_MWB_WERT', 11.6, idle).state).toBe('low');
    expect(evaluate('STAT_LAMBDA_INTEGRATOR_1_MWB_WERT', 1.18, idle).state).toBe('high');
    expect(evaluate('STAT_VANOS_NW_LAGE_AUSLASS_MWB_WERT', -95, idle).state).toBe('ok');
  });
  it('checks idle-only values only at warm idle', () => {
    expect(evaluate('STAT_LMM_MASSE_MWB_WERT', 6, idle).state).toBe('low');
    expect(evaluate('STAT_LMM_MASSE_MWB_WERT', 6, driving).state).toBe('na');
    expect(evaluate('STAT_LMM_MASSE_MWB_WERT', 250, driving).state).toBe('na');
  });
  it('detects warm idle from the data block', () => {
    const v = (key: string, value: number) => ({ key, value });
    expect(engineContext([v('STAT_MOTORDREHZAHL_MWB_WERT', 720), v('STAT_GESCHWINDIGKEIT_MWB_WERT', 0), v('STAT_MOTORTEMP_MWB_WERT', 90)]).idle).toBe(true);
    expect(engineContext([v('STAT_MOTORDREHZAHL_MWB_WERT', 2500), v('STAT_GESCHWINDIGKEIT_MWB_WERT', 60), v('STAT_MOTORTEMP_MWB_WERT', 90)]).idle).toBe(false);
    expect(engineContext([v('STAT_MOTORDREHZAHL_MWB_WERT', 900), v('STAT_GESCHWINDIGKEIT_MWB_WERT', 0), v('STAT_MOTORTEMP_MWB_WERT', 30)]).idle).toBe(false);
  });
});

describe('English labels', () => {
  it('translates values and functions', () => {
    expect(valueLabel('STAT_OEL_TEMPERATUR_WERT')).toBe('Oil temp');
    expect(valueLabel('STAT_RAD_GESCHW_VL_WERT')).toBe('Wheel speed front left');
    expect(valueLabel('STAT_WAEHLHEBEL_POSITION')).toBe('Selector lever position');
    expect(jobLabel('EKP-Relais ansteuern: Default Ein=0xFF , Aus=0x00')).toBe('Fuel pump relay (on = 0xFF, off = 0x00)');
    expect(jobLabel('Adaptionen loeschen')).toBe('Reset all adaptations');
  });
});
