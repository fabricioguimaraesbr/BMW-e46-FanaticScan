// Live data layout: which values are numbers (card with a reference bar) or states (plain box), how they are
// grouped on screen, the scale of each bar, and which values feed the instrument panel on top.
import type { Value } from './DiagSession';
import { KEY_METRICS, baseKey, referenceFor } from './reference';

export type ValueKind = 'num' | 'text';

/** Numbers with a unit (or a reference) get a bar; texts, on/off flags and bare codes get a plain box. */
export function kindOf(v: Value): ValueKind {
  if (typeof v.value === 'string') return 'text';
  const k = v.key.toUpperCase();
  if (/_(EIN|NR|ERK)$/.test(k)) return 'text';
  if ((!v.unit || v.unit === '-') && !referenceFor(v.key, v.unit)) return 'text';
  return 'num';
}

/** On/off flags (…_EIN) read 0/1. */
export const isFlag = (v: Value) => /_EIN$/i.test(v.key) && typeof v.value === 'number';

/** Drops values that only repeat another one: the code behind a text (X_NR next to X) and the number behind X_TEXT. */
export function visibleValues(values: Value[]): Value[] {
  const keys = new Set(values.map((v) => v.key));
  return values.filter((v) => {
    if (/_NR$/.test(v.key) && keys.has(v.key.replace(/_NR$/, ''))) return false;
    if (keys.has(`${v.key}_TEXT`)) return false;
    return true;
  });
}

/**
 * The same reading under another name: STAT_X / STATUS_X, X_MWB_WERT (data block) / X_WERT (single group),
 * …TEMP / …TEMPERATUR. Used to show each reading once.
 */
export function sameValueId(key: string) {
  return key.toUpperCase().replace(/^(STATUS|STAT)_/, '').replace(/_MWB(?=_WERT$|$)/, '').replace(/TEMPERATUR/g, 'TEMP');
}

export const GROUP_ORDER = ['Engine', 'Air & fuel', 'Ignition & VANOS', 'Temperatures', 'Electrical', 'Heaters & A/C', 'Transmission', 'Cruise control', 'Wheels & brakes', 'Other values'] as const;
export type GroupName = (typeof GROUP_ORDER)[number];

// Checked in this order (a fan speed is not engine speed, a wheel speed is not engine speed, …).
const RULES: [GroupName, RegExp][] = [
  ['Cruise control', /TEMPOMAT|FGR|MFL|^VS_|UEBERHOL|BESCHLEUNIGUNGSUEB|DYNAMIKBEGR|HOCHLAUF|UEBERTRETEN|^F_V1$/],
  ['Heaters & A/C', /HEIZ|LUEFTER|GEBLAESE|KLIMA|^KO(_|$)|^AC$/],
  ['Wheels & brakes', /(^|_)RAD|BREMS|^ASC|ABS|DSC|^ESP|DREHRATE|QUERBESCHL|^BLS|BLTS|BTS_BLS/],
  ['Temperatures', /TEMP|^OBD_0[5F]$/],
  ['Ignition & VANOS', /ZUEND|VANOS|KLOPF|NOCKENWELLE|GEBERRAD|^ZSI$|^OBD_0E$/],
  ['Air & fuel', /LMM|LUFT|EINSPRITZ|LAMBDA|INTEGRATOR|^LL_|KRAFTSTOFF|TANK|GEMISCH|SONDE|^LS_|^(INT|ADD|MUL)(_2)?$|^ADAP_B|^TEV$|^EKP|^SCHUB|DISA|^OBD_0[6-9]$|^OBD_10$/],
  ['Electrical', /UBAT|^KL\d|^KL_|SPANNUNG|_MW_|STROM|^CAN$|^OBD_42$/],
  ['Transmission', /^L\d$|SPORT|MAN_GASSE|KURVENFAHRT|EDS|^MV|GANG|SCHALT|STEG|ABTRIEB|WAEHL|PROG|GETRIEBE|STEPTRONIC|KICK|TIP_|SHIFT|ZEITPOS|ADAPT|KOMBI|FAHRSTUFE|EGS/],
  ['Engine', /DREHZAHL|LAST|PEDAL|PWG|DROSSEL|DKG|DKP|^DK_|ENDSTUFE_DK|TPS|^(LL|TL|VL)$|^KUP|^START$|GESCHWINDIGKEIT|^OBD_0[4CD]$|^OBD_11$/],
];

export function groupOf(key: string): GroupName {
  const b = baseKey(key);
  for (const [g, re] of RULES) if (re.test(b)) return g;
  return 'Other values';
}

/** Groups in screen order; the module's key metrics come first inside each group, then the read order. */
export function groupValues(values: Value[], variant: string): { name: GroupName; nums: Value[]; texts: Value[] }[] {
  const want = KEY_METRICS[variant.toLowerCase()] ?? [];
  const rank = (v: Value) => { const i = want.indexOf(baseKey(v.key)); return i < 0 ? want.length : i; };
  const vis = visibleValues(values).map((v, i) => ({ v, i }));
  vis.sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i);
  const out = new Map<GroupName, { name: GroupName; nums: Value[]; texts: Value[] }>();
  for (const { v } of vis) {
    const g = groupOf(v.key);
    const e = out.get(g) ?? out.set(g, { name: g, nums: [], texts: [] }).get(g)!;
    (kindOf(v) === 'num' ? e.nums : e.texts).push(v);
  }
  return GROUP_ORDER.filter((g) => out.has(g)).map((g) => out.get(g)!);
}

// ------------------------------------------------------------------ bar scale
const UNIT_SCALE: Record<string, [number, number]> = {
  rpm: [0, 7000], '1/min': [0, 7000], 'km/h': [0, 250], '%': [0, 100], V: [0, 16], Volt: [0, 16], '°C': [-40, 150],
  ms: [0, 10], hPa: [700, 1100], mbar: [700, 1100], 'kg/h': [0, 600], 'g/s': [0, 150], mA: [0, 1200], Nm: [0, 400],
};

function niceStep(span: number) {
  if (!(span > 0)) return 1;
  return Math.pow(10, Math.floor(Math.log10(span)) - 1) * 5;
}

/**
 * Ends of the bar. With a reference the normal band sits in the middle with room on both sides, kept inside the
 * unit's physical range; without one the unit's range, or else a range that grows with the highest value seen.
 */
export function barScale(v: Value, hist: number[] = []): { min: number; max: number } {
  const ref = referenceFor(v.key, v.unit);
  const unit = UNIT_SCALE[v.unit];
  const num = typeof v.value === 'number' ? v.value : 0;
  let min: number;
  let max: number;
  if (ref?.lo !== undefined && ref.hi !== undefined) {
    const span = ref.hi - ref.lo || Math.abs(ref.hi) || 1;
    min = ref.lo - span * 0.6;
    max = ref.hi + span * 0.6;
    if (unit) { min = Math.max(min, unit[0]); max = Math.min(max, unit[1]); }
  } else if (ref?.hi !== undefined) {
    min = unit ? Math.max(unit[0], 0) : Math.min(0, num);
    max = ref.hi + Math.abs(ref.hi - min) * 0.25;
  } else if (ref?.lo !== undefined) {
    min = ref.lo - Math.abs(ref.lo) * 0.25;
    max = unit ? unit[1] : Math.max(ref.lo * 2, num);
  } else if (unit) {
    [min, max] = unit;
  } else {
    const all = hist.length ? hist : [num];
    min = Math.min(0, ...all);
    max = Math.max(...all);
    if (max <= min) max = min + 1;
    max = max + (max - min) * 0.2;
  }
  const step = niceStep(max - min);
  return { min: Math.floor(min / step + 1e-9) * step, max: Math.ceil(max / step - 1e-9) * step };
}

// ------------------------------------------------------------------ instrument panel
/** Values the instrument panel looks for (value bases, first one found wins). */
export const PANEL = {
  tacho: ['MOTORDREHZAHL', 'OBD_0C'],
  speed: ['GESCHWINDIGKEIT', 'FAHRZEUGGESCHWINDIGKEIT', 'V_FZG', 'OBD_0D'],
  gear: ['GANG'],
  readout: [
    ['UBATT', 'Battery'], ['UBAT', 'Battery'], ['KL15', 'Battery'], ['OBD_42', 'Battery'],
    ['AN_LUFTTEMP', 'Intake air'], ['OBD_0F', 'Intake air'],
    ['EINSPRITZZEIT', 'Injection'], ['LMM_MASSE', 'Air mass'], ['OBD_10', 'Air mass'], ['OBD_04', 'Load'],
    ['STEGDREHZAHL', 'Turbine'], ['ABTRIEBSDREHZAHL', 'Output shaft'], ['DKG', 'Throttle'], ['LAST', 'Load'], ['LUFTDRUCK', 'Air pressure'],
  ] as [string, string][],
  bars: [
    ['COOLANT', ['MOTORTEMP', 'MOTORTEMPERATUR', 'OBD_05'], 40, 130],
    ['OIL', ['OEL_TEMP', 'OEL_TEMPERATUR'], 40, 150],
    ['GEARBOX OIL', ['GETRIEBETEMPERATUR'], 0, 150],
  ] as [string, string[], number, number][],
};

export interface PanelPick {
  tacho?: string;
  speed?: string;
  gear?: string;
  readout: { key: string; label: string }[];
  bars: { key: string; label: string; min: number; max: number }[];
}

/** Picks the keys for the panel from what this module reports. Undefined when there is too little to show. */
export function pickPanel(values: Value[]): PanelPick | undefined {
  const nums = values.filter((v) => typeof v.value === 'number' && kindOf(v) === 'num');
  const find = (bases: string[], pool = nums) => { for (const b of bases) { const v = pool.find((x) => baseKey(x.key) === b); if (v) return v.key; } return undefined; };
  const used = new Set<string>();
  const take = (k?: string) => { if (k) used.add(k); return k; };
  const tacho = take(find(PANEL.tacho));
  const speed = take(find(PANEL.speed));
  const gearText = values.find((v) => /_TEXT$/.test(v.key) && baseKey(v.key) === 'GANG');
  const gear = take(gearText?.key ?? find(PANEL.gear, values));
  const bars: PanelPick['bars'] = [];
  for (const [label, bases, min, max] of PANEL.bars) {
    const k = find(bases);
    if (k && !used.has(k) && bars.length < 2) { used.add(k); bars.push({ key: k, label, min, max }); }
  }
  const readout: PanelPick['readout'] = [];
  const labels = new Set<string>();
  for (const [b, label] of PANEL.readout) {
    if (readout.length >= 4) break;
    const k = find([b]);
    if (k && !used.has(k) && !labels.has(label)) { used.add(k); labels.add(label); readout.push({ key: k, label }); }
  }
  if (!tacho && (speed ? 1 : 0) + bars.length + readout.length < 3) return undefined;
  return { tacho, speed, gear, readout, bars };
}
