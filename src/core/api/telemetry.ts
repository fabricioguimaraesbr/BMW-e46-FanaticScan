// Telemetry centre (car head unit / phone in the dash): the key values of engine and gearbox on one screen.
// Works with the module files (MS43 data block, GS8.60.4 STATUS_IO_LESEN) and in plug-and-play mode (OBD-II PIDs).
// Values are matched by their base name (see baseKey), so other DME/EGS variants work when their names match.

import type { Value } from './DiagSession';
import { baseKey } from './reference';

export type Mod = 'DME' | 'EGS';
/** Kind of value: decides the colour on screen. */
export type Cat = 'rev' | 'cool' | 'rad' | 'oil' | 'vanos' | 'trim' | 'air' | 'pedal' | 'trans' | 'elec' | 'fuel' | 'other';

export interface MetricDef {
  id: string;
  label: string;
  unit: string;
  cat: Cat;
  /** chart and bar scale */
  lo: number;
  hi: number;
  /** normal range (outside = alarm colour) */
  okLo?: number;
  okHi?: number;
  digits: number;
  /** where to look, first match wins: 'DME:MOTORTEMP' (value base in that module) */
  bases: string[];
  /** extra match on the base name when none of the bases is reported */
  match?: { mod: Mod; re: RegExp; not?: RegExp };
}

export const METRICS: MetricDef[] = [
  { id: 'rpm', label: 'ENGINE SPEED', unit: 'rpm', cat: 'rev', lo: 0, hi: 8000, okHi: 6500, digits: 0, bases: ['DME:MOTORDREHZAHL', 'DME:NMOT', 'DME:OBD_0C', 'EGS:MOTORDREHZAHL'] },
  { id: 'speed', label: 'SPEED', unit: 'km/h', cat: 'rev', lo: 0, hi: 260, digits: 0, bases: ['DME:GESCHWINDIGKEIT', 'DME:FAHRZEUGGESCHWINDIGKEIT', 'DME:V_FZG', 'DME:VFZG', 'DME:OBD_0D', 'EGS:GESCHWINDIGKEIT', 'EGS:FAHRZEUGGESCHWINDIGKEIT'] },
  { id: 'ect', label: 'COOLANT', unit: '°C', cat: 'cool', lo: 40, hi: 130, okLo: 80, okHi: 110, digits: 0, bases: ['DME:MOTORTEMP', 'DME:MOTORTEMPERATUR', 'DME:TMOT', 'DME:OBD_05', 'EGS:MOTORTEMPERATUR'] },
  { id: 'oil', label: 'OIL', unit: '°C', cat: 'oil', lo: 40, hi: 150, okLo: 70, okHi: 130, digits: 0, bases: ['DME:OEL_TEMP', 'DME:OEL_TEMPERATUR', 'DME:TOEL', 'DME:OBD_5C'] },
  { id: 'rad', label: 'RADIATOR OUT', unit: '°C', cat: 'rad', lo: 20, hi: 130, okHi: 113, digits: 0, bases: ['DME:KUEHLW_AUSL_TEMP', 'DME:KUEHLW_AUSL_TEMPERATUR', 'DME:TKA'] },
  { id: 'vin', label: 'VANOS IN', unit: '°KW', cat: 'vanos', lo: 70, hi: 130, okLo: 80, okHi: 120, digits: 0, bases: ['DME:VANOS_NW_LAGE_EINLASS', 'DME:VANOS_NW_LAGE_EINLASS_IST', 'DME:WNWKWE'], match: { mod: 'DME', re: /VANOS.*EINLASS|EINLASS.*VANOS|NW_E(IN)?_IST/, not: /SOLL|REF|ADAPT|SPANN|TV|STROM/ } },
  { id: 'vex', label: 'VANOS EX', unit: '°KW', cat: 'vanos', lo: -110, hi: -70, okLo: -105, okHi: -80, digits: 0, bases: ['DME:VANOS_NW_LAGE_AUSLASS', 'DME:VANOS_NW_LAGE_AUSLASS_IST', 'DME:WNWKWA'], match: { mod: 'DME', re: /VANOS.*AUSLASS|AUSLASS.*VANOS|NW_A(US)?_IST/, not: /SOLL|REF|ADAPT|SPANN|TV|STROM/ } },
  { id: 'stft1', label: 'STFT B1', unit: '%', cat: 'trim', lo: -15, hi: 15, okLo: -10, okHi: 10, digits: 1, bases: ['DME:LAMBDA_INTEGRATOR_1', 'DME:INT', 'DME:FR', 'DME:OBD_06'] },
  { id: 'stft2', label: 'STFT B2', unit: '%', cat: 'trim', lo: -15, hi: 15, okLo: -10, okHi: 10, digits: 1, bases: ['DME:LAMBDA_INTEGRATOR_2', 'DME:INT_2', 'DME:FR2', 'DME:OBD_08'] },
  { id: 'pedal', label: 'PEDAL', unit: '%', cat: 'pedal', lo: 0, hi: 100, digits: 0, bases: ['DME:PWG_WINKEL', 'DME:PWG', 'DME:PEDALWERT', 'DME:WPED', 'DME:OBD_49', 'DME:OBD_11'] },
  { id: 'maf', label: 'AIR MASS', unit: 'g/s', cat: 'air', lo: 0, hi: 110, digits: 1, bases: ['DME:LMM_MASSE', 'DME:LMM', 'DME:LM_HFM', 'DME:MSHFM', 'DME:OBD_10'] },
  { id: 'atf', label: 'GEARBOX OIL', unit: '°C', cat: 'trans', lo: 40, hi: 140, okHi: 120, digits: 0, bases: ['EGS:GETRIEBETEMPERATUR', 'EGS:GETRIEBEOELTEMPERATUR', 'EGS:OELTEMPERATUR'] },
  { id: 'slip', label: 'CONVERTER SLIP', unit: 'rpm', cat: 'trans', lo: 0, hi: 500, digits: 0, bases: ['EGS:WANDLERSCHLUPF', 'EGS:SCHLUPF_WANDLER', 'EGS:SCHLUPF'] },
  { id: 'ubatt', label: 'BATTERY', unit: 'V', cat: 'elec', lo: 11, hi: 15.5, okLo: 12.4, okHi: 14.8, digits: 1, bases: ['DME:UBATT', 'DME:KL15', 'DME:UB', 'DME:OBD_42', 'EGS:UBAT', 'EGS:UBATT'] },
  // used for derived values and offered as extra tiles
  { id: 'turbine', label: 'TURBINE SPEED', unit: 'rpm', cat: 'trans', lo: 0, hi: 8000, digits: 0, bases: ['EGS:TURBINENDREHZAHL', 'EGS:STEGDREHZAHL'] },
  { id: 'iat', label: 'INTAKE AIR', unit: '°C', cat: 'air', lo: -10, hi: 80, okHi: 60, digits: 0, bases: ['DME:AN_LUFTTEMP', 'DME:AN_LUFTTEMPERATUR', 'DME:TANS', 'DME:OBD_0F'] },
  { id: 'ti', label: 'INJECTION', unit: 'ms', cat: 'fuel', lo: 0, hi: 20, digits: 2, bases: ['DME:EINSPRITZZEIT', 'DME:TE', 'DME:TI'] },
];
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.id, m])) as Record<string, MetricDef>;

/** Main tiles under the dials (the extra ones the user picks come after them). */
export const MAIN_TILES = ['rad', 'vin', 'vex', 'stft1', 'stft2', 'pedal', 'maf', 'atf', 'lock', 'slip', 'ubatt'];
/** Values charted in the drawer (last 60 s). */
export const CHART_IDS = ['rpm', 'speed', 'pedal', 'maf', 'kml', 'ect', 'rad', 'oil', 'atf', 'vin', 'vex', 'stft1', 'stft2', 'slip', 'ubatt'];

const num = (v: Value | undefined) => (v && typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : undefined);

/** Unit conversions to what the screen shows. */
export function convert(id: string, v: Value): number | undefined {
  const x = num(v);
  if (x === undefined) return undefined;
  const unit = (v.unit ?? '').trim().toLowerCase();
  const base = baseKey(v.key);
  if (id === 'maf') {
    if (unit.includes('g/s')) return x;
    if (unit.includes('kg/h') || /^(LMM_MASSE|LMM|LM_HFM|MSHFM)$/.test(base)) return x / 3.6;
    return x;
  }
  if (id === 'stft1' || id === 'stft2') {
    // the DME reports a factor (1.00 = no correction); OBD-II reports percent
    if (unit === '%') return x;
    if (unit === '' || unit === '-' || (x > 0.4 && x < 1.6)) return (x - 1) * 100;
    return x;
  }
  return x;
}

/** The values of one read cycle, by module. */
export interface Frame {
  DME: Value[];
  EGS: Value[];
}

function findValue(def: MetricDef, f: Frame): [Mod, Value] | undefined {
  for (const b of def.bases) {
    const [mod, base] = b.split(':') as [Mod, string];
    const v = f[mod].find((x) => typeof x.value === 'number' && baseKey(x.key) === base);
    if (v) return [mod, v];
  }
  if (def.match) {
    const { mod, re, not } = def.match;
    const v = f[mod].find((x) => typeof x.value === 'number' && re.test(baseKey(x.key)) && !(not && not.test(baseKey(x.key))));
    if (v) return [mod, v];
  }
  return undefined;
}

export type Selector = 'P' | 'R' | 'N' | 'D' | 'S';
export interface Snapshot {
  /** numeric values by metric id (undefined = not reported by this car / connection) */
  v: Record<string, number | undefined>;
  /** keys that were used, by metric id (to skip them when listing extra values) */
  used: Set<string>;
  gear?: string;
  selector?: Selector;
  mode?: 'DRIVE' | 'SPORT' | 'MANUAL';
  lockup?: boolean;
  /** lock-up and slip worked out from engine and turbine speed (no direct value from the EGS) */
  lockupEstimated?: boolean;
}

const textOf = (vals: Value[], re: RegExp, not?: RegExp) => vals.find((x) => re.test(baseKey(x.key)) && !(not && not.test(baseKey(x.key))));
const truthy = (v: Value | undefined) => {
  if (!v) return false;
  if (typeof v.value === 'number') return v.value !== 0;
  return /^(1|ein|an|on|aktiv|active|ja|yes|true|sport)/i.test(String(v.value).trim());
};

/** Gear from the EGS: a number (1–5), or a text such as "3", "Gang 3", "R", "N". */
export function parseGear(v: Value | undefined): string | undefined {
  if (!v) return undefined;
  if (typeof v.value === 'number') {
    if (!Number.isFinite(v.value)) return undefined;
    return v.value <= 0 ? 'N' : String(Math.round(v.value));
  }
  const t = String(v.value).toUpperCase();
  const d = t.match(/([1-6])/);
  if (d) return d[1];
  const l = t.match(/\b([PRN])\b/);
  return l ? l[1] : undefined;
}

/** Selector lever from the EGS text (P, R, N, D, S/M, 4, 3, 2). */
export function parseSelector(v: Value | undefined): { sel?: Selector; manual?: boolean } {
  if (!v || typeof v.value === 'number') return {};
  const t = String(v.value).toUpperCase().trim();
  if (/\bM\d?\b|MANU|TIP|STEPTRONIC/.test(t)) return { sel: 'S', manual: true };
  if (/\bS\b|SPORT/.test(t)) return { sel: 'S' };
  const m = t.match(/\b([PRND])\b/) ?? t.match(/^([PRND])/);
  if (m) return { sel: m[1] as Selector };
  if (/\b[234]\b/.test(t)) return { sel: 'D' };
  return {};
}

export function snapshot(f: Frame): Snapshot {
  const v: Record<string, number | undefined> = {};
  const used = new Set<string>();
  for (const def of METRICS) {
    const hit = findValue(def, f);
    if (!hit) continue;
    v[def.id] = convert(def.id, hit[1]);
    used.add(`${hit[0]}|${hit[1].key}`);
  }
  const s: Snapshot = { v, used };
  // gear and selector lever (gearbox)
  const gearV = textOf(f.EGS, /^GANG$/) ?? textOf(f.EGS, /^(AKT_)?GANG|^GANG_/, /SOLL|ZIEL|ANZEIGE_SOLL/);
  s.gear = parseGear(gearV);
  const selV = textOf(f.EGS, /WAEHLHEBEL|FAHRSTUFE|POSITION_WH|^WH_POS/);
  const ps = parseSelector(selV);
  const sport = truthy(textOf(f.EGS, /SPORT/));
  const manual = ps.manual || truthy(textOf(f.EGS, /STEPTRONIC|TIPP|MAN_GASSE/));
  s.selector = ps.sel ?? (s.gear === 'R' ? 'R' : s.gear === 'N' ? 'N' : s.gear ? 'D' : undefined);
  if ((sport || manual) && (s.selector === 'D' || s.selector === undefined)) s.selector = 'S';
  s.mode = s.selector === 'S' ? (manual ? 'MANUAL' : 'SPORT') : 'DRIVE';
  if (s.gear === 'R') s.selector = 'R';
  // torque converter: direct value when the EGS reports one, else engine speed − turbine speed
  const lockV = textOf(f.EGS, /WANDLER|^WK_|TCC|UEBERBRUECK/, /SCHLUPF|DRUCK|STROM|TV|ADAPT/);
  const rpm = v.rpm, tur = v.turbine;
  if (v.slip === undefined && rpm !== undefined && tur !== undefined && rpm > 300) v.slip = Math.max(0, rpm - tur);
  if (lockV) s.lockup = truthy(lockV);
  else if (v.slip !== undefined && rpm !== undefined) {
    s.lockup = rpm > 1100 && v.slip < 60;
    s.lockupEstimated = true;
  }
  return s;
}

/** Fuel use worked out from the air mass (the M54 has no fuel flow value): fuel = air / 14.7, corrected by the short term trims. */
export class FuelEstimator {
  private ema?: number;
  private lastT = 0;
  distanceKm = 0;
  fuelL = 0;
  /** litres per hour, last value */
  lph?: number;
  reset() {
    this.ema = undefined;
    this.lastT = 0;
    this.distanceKm = 0;
    this.fuelL = 0;
    this.lph = undefined;
  }
  /** t in ms. Returns km/l now (undefined when stopped or unknown). */
  update(t: number, s: Snapshot): number | undefined {
    const { speed, maf, stft1, stft2, ti, rpm } = s.v;
    if (maf === undefined) return undefined;
    const trim = [stft1, stft2].filter((x): x is number => x !== undefined);
    const corr = trim.length ? 1 + trim.reduce((a, b) => a + b, 0) / trim.length / 100 : 1;
    // overrun fuel cut: no injection with the pedal released at speed
    const cut = (ti !== undefined && ti < 0.3 && (rpm ?? 0) > 1100) || ((s.v.pedal ?? 1) < 0.5 && (rpm ?? 0) > 1500 && (speed ?? 0) > 20 && ti === undefined);
    const gps = cut ? 0 : (maf / 14.7) * corr;
    const lph = (gps * 3600) / 745;
    this.lph = lph;
    const dt = this.lastT ? Math.min(2, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    if (speed !== undefined && dt > 0) {
      this.distanceKm += (speed * dt) / 3600;
      this.fuelL += (lph * dt) / 3600;
    }
    if (speed === undefined || speed < 3) {
      this.ema = undefined;
      return undefined;
    }
    const kml = lph > 0.05 ? Math.min(99.9, speed / lph) : 99.9;
    this.ema = this.ema === undefined ? kml : this.ema + 0.35 * (kml - this.ema);
    return this.ema;
  }
  /** average since the screen opened (or the last reset) */
  get average(): number | undefined {
    return this.fuelL > 0.005 && this.distanceKm > 0.05 ? Math.min(99.9, this.distanceKm / this.fuelL) : undefined;
  }
}

export const isBad = (id: string, x: number | undefined) => {
  const d = METRIC[id];
  if (!d || x === undefined) return false;
  return (d.okLo !== undefined && x < d.okLo) || (d.okHi !== undefined && x > d.okHi);
};

export const fmtMetric = (id: string, x: number | undefined) => {
  if (x === undefined || !Number.isFinite(x)) return '—';
  const d = METRIC[id];
  const s = x.toFixed(d?.digits ?? 1);
  return (id === 'stft1' || id === 'stft2') && x >= 0 ? `+${s}` : s;
};
