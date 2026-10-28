// Reference values for the E46 325i (M54 / MS43, GS8.60.4 / 5HP19, ASC MK20) used to flag live data.
// Sources: BMW technical training M54 / MS42-MS43 (6500 rpm cut-off, VANOS 80-120 / 80-105 °KW,
// injector pulse ≈ 3.5-5 ms), map-controlled thermostat 100-110 °C part load / 85-95 °C full load.
// Values marked approximate are typical workshop values, not BMW specifications.

export interface Reference {
  lo?: number;
  hi?: number;
  /** Below this the engine is just cold, not faulty (shown as "Warming up"). */
  warmFrom?: number;
  /** Only meaningful at warm idle (engine running, < 1000 rpm, car stopped). */
  idleOnly?: boolean;
  /** Only applies when the value comes in one of these units (the same name can be a factor in one group and % in another). */
  units?: string[];
  note: string;
}

export type RefState = 'ok' | 'low' | 'high' | 'cold' | 'na';

/** Keys are value bases (see baseKey): MS43 data block and single STATUS jobs share them. */
export const REFERENCES: Record<string, Reference> = {
  MOTORDREHZAHL: { lo: 600, hi: 6500, note: 'Warm idle ≈ 700 rpm. Fuel cut-off at 6,500 rpm.' },
  MOTORTEMP: { lo: 80, hi: 113, warmFrom: 80, note: 'Map thermostat: 100–110 °C part load, 85–95 °C full load. Fully open at 113 °C.' },
  MOTORTEMPERATUR: { lo: 80, hi: 113, warmFrom: 80, note: 'Map thermostat: 100–110 °C part load, 85–95 °C full load. Fully open at 113 °C.' },
  OEL_TEMP: { lo: 70, hi: 130, warmFrom: 70, note: 'Typical 90–120 °C when warm (approximate).' },
  OEL_TEMPERATUR: { lo: 70, hi: 130, warmFrom: 70, note: 'Typical 90–120 °C when warm (approximate).' },
  UBATT: { lo: 12.4, hi: 14.8, note: 'Engine running 13.5–14.5 V. Engine off 12.4–12.8 V.' },
  KL15: { lo: 12.4, hi: 14.8, note: 'Engine running 13.5–14.5 V. Engine off 12.4–12.8 V.' },
  AN_LUFTTEMP: { lo: -25, hi: 60, note: 'Close to outside temperature; up to ~60 °C after heat soak.' },
  AN_LUFTTEMPERATUR: { lo: -25, hi: 60, note: 'Close to outside temperature; up to ~60 °C after heat soak.' },
  LMM_MASSE: { lo: 10, hi: 25, idleOnly: true, note: 'Warm idle ≈ 12–22 kg/h (approximate). Low values can mean a dirty MAF or air leak.' },
  LMM: { lo: 10, hi: 25, idleOnly: true, note: 'Warm idle ≈ 12–22 kg/h (approximate).' },
  EINSPRITZZEIT: { lo: 1.8, hi: 4.5, idleOnly: true, note: 'Warm idle ≈ 2–4 ms (approximate).' },
  ZUENDWINKEL: { lo: 0, hi: 20, idleOnly: true, note: 'Warm idle ≈ 5–15° before TDC (approximate).' },
  LAMBDA_INTEGRATOR_1: { lo: 0.9, hi: 1.1, units: ['-', ''], note: 'Fuel trim factor; 1.00 is ideal. Outside ±10 % points to air leaks, MAF or fuel pressure.' },
  LAMBDA_INTEGRATOR_2: { lo: 0.9, hi: 1.1, units: ['-', ''], note: 'Fuel trim factor; 1.00 is ideal. Outside ±10 % points to air leaks, MAF or fuel pressure.' },
  INT: { lo: 0.9, hi: 1.1, units: ['-', ''], note: 'Fuel trim factor; 1.00 is ideal.' },
  INT_2: { lo: 0.9, hi: 1.1, units: ['-', ''], note: 'Fuel trim factor; 1.00 is ideal.' },
  LL_STELLER_TV: { lo: 20, hi: 45, idleOnly: true, note: 'Idle valve duty at warm idle ≈ 25–40 % (approximate). High = dirty valve or air leak.' },
  VANOS_NW_LAGE_EINLASS: { lo: 80, hi: 120, note: 'Intake VANOS range 80–120 °KW.' },
  VANOS_NW_LAGE_AUSLASS: { lo: -105, hi: -80, note: 'Exhaust VANOS range 80–105 °KW (shown negative).' },
  LUFTDRUCK: { lo: 850, hi: 1060, note: 'Ambient pressure; lower at altitude (São Paulo ≈ 920 hPa).' },
  KUEHLW_AUSL_TEMP: { hi: 113, note: 'Radiator outlet; lower than engine temperature while the thermostat is closed.' },
  KUEHLW_AUSL_TEMPERATUR: { hi: 113, note: 'Radiator outlet; lower than engine temperature while the thermostat is closed.' },
  // OBD-II (plug-and-play mode, any E46 petrol engine)
  OBD_0C: { lo: 550, hi: 7000, note: 'Warm idle ≈ 650–800 rpm depending on engine.' },
  OBD_05: { lo: 80, hi: 113, warmFrom: 80, note: 'Normal 85–110 °C when warm.' },
  OBD_0F: { lo: -25, hi: 60, note: 'Close to outside temperature; up to ~60 °C after heat soak.' },
  OBD_10: { lo: 2.5, hi: 8, idleOnly: true, note: 'Warm idle ≈ 3–7 g/s for a 1.9–3.0 l six or four (approximate).' },
  OBD_0E: { lo: -5, hi: 25, idleOnly: true, note: 'Warm idle ≈ 0–20° before TDC (approximate).' },
  OBD_04: { lo: 10, hi: 40, idleOnly: true, note: 'Calculated load at warm idle ≈ 15–35 % (approximate).' },
  OBD_06: { lo: -10, hi: 10, note: 'Short term fuel trim: within ±10 % is normal; it moves constantly.' },
  OBD_07: { lo: -10, hi: 10, note: 'Long term fuel trim: within ±10 % is normal. Positive = engine runs lean (air leak, MAF, fuel pressure).' },
  OBD_08: { lo: -10, hi: 10, note: 'Short term fuel trim bank 2: within ±10 % is normal.' },
  OBD_09: { lo: -10, hi: 10, note: 'Long term fuel trim bank 2: within ±10 % is normal.' },
  OBD_42: { lo: 12.4, hi: 14.8, note: 'Engine running 13.5–14.5 V.' },
  // transmission (GS8.60.4)
  GETRIEBETEMPERATUR: { lo: 40, hi: 120, warmFrom: 40, note: 'Transmission oil typically 70–110 °C when warm (approximate).' },
  UBAT: { lo: 12.4, hi: 14.8, note: 'Engine running 13.5–14.5 V.' },
};

/** Default key metrics per module (value bases, in display order). The first 4 numeric ones become dials. */
export const KEY_METRICS: Record<string, string[]> = {
  ms430ds0: ['MOTORDREHZAHL', 'MOTORTEMP', 'OEL_TEMP', 'UBATT', 'AN_LUFTTEMP', 'LMM_MASSE', 'EINSPRITZZEIT', 'ZUENDWINKEL', 'LAMBDA_INTEGRATOR_1', 'LAMBDA_INTEGRATOR_2'],
  gs8604: ['GETRIEBETEMPERATUR', 'STEGDREHZAHL', 'ABTRIEBSDREHZAHL', 'UBAT', 'GANG', 'WAEHLHEBEL_POSITION', 'MOTORTEMPERATUR', 'DKG', 'LAST', 'ADAPT_PROG'],
  'native:12': ['OBD_0C', 'OBD_05', 'OBD_0F', 'OBD_0D', 'OBD_04', 'OBD_10', 'OBD_0E', 'OBD_06', 'OBD_07', 'OBD_11'],
  ascmk20: ['RAD_GESCHW_VL', 'RAD_GESCHW_VR', 'RAD_GESCHW_HL', 'RAD_GESCHW_HR', 'BREMSLICHT_SCHALTER', 'ASC_TASTER'],
};

export function baseKey(name: string) {
  return name
    .toUpperCase()
    .replace(/^(STATUS|STAT|LESEN)_/, '')
    .replace(/_(WERT|EIN|TEXT)$/, '')
    .replace(/_MWB$/, '');
}

export function referenceFor(key: string, unit?: string): Reference | undefined {
  const ref = REFERENCES[baseKey(key)];
  if (ref?.units && unit !== undefined && !ref.units.includes(unit)) return undefined;
  return ref;
}

export interface EngineContext {
  idle: boolean; // engine running at warm idle, car stopped
}

export function evaluate(key: string, value: number | string | undefined, ctx: EngineContext, unit?: string): { state: RefState; ref?: Reference } {
  const ref = referenceFor(key, unit);
  if (!ref || typeof value !== 'number') return { state: 'na', ref };
  if (ref.idleOnly && !ctx.idle) return { state: 'na', ref };
  if (ref.lo !== undefined && value < ref.lo) return { state: ref.warmFrom !== undefined && value < ref.warmFrom ? 'cold' : 'low', ref };
  if (ref.hi !== undefined && value > ref.hi) return { state: 'high', ref };
  return { state: 'ok', ref };
}

/** Detects warm idle from the values of the current read. */
export function engineContext(values: { key: string; value: number | string }[]): EngineContext {
  const get = (b: string) => values.find((v) => baseKey(v.key) === b)?.value;
  const rpm = get('MOTORDREHZAHL') ?? get('OBD_0C');
  const speed = get('GESCHWINDIGKEIT') ?? get('OBD_0D');
  const temp = get('MOTORTEMP') ?? get('MOTORTEMPERATUR') ?? get('OBD_05');
  const idle = typeof rpm === 'number' && rpm > 450 && rpm < 1000 && (typeof speed !== 'number' || speed < 3) && (typeof temp !== 'number' || temp >= 75);
  return { idle };
}
