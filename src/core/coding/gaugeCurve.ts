// Coolant temperature gauge curve of the E46 instrument cluster (KOMBI46 / KOMBI46R), as found in the cluster's
// EEPROM. Community findings (E46Fanatics "DIY: Temperature Gauge Buffer Mod", TerraPhantm, SilberVogel, blarf):
//
//   early clusters (up to about 2002, KOMBI46): 6 points "temperature, needle angle" at byte 0x0F0 (word 0x78)
//     0F 00 32 1F 4B 5A 73 5A 7C 94 7D A4   → 15 °C 0°, 50 °C 31°, 75 °C 90°, 115 °C 90°, 124 °C 148°, 125 °C 164°
//     (the needle stays at 90° = 12 o'clock from 75 to 115 °C: the "buffer")
//   later clusters (about 2003+, KOMBI46R): point count, 6 temperatures, then the angles in 2° steps, near byte 0x34D
//     06 0F 32 4B 73 7D 8F 00 10 2D 2D …   → 15, 50, 75, 115, 125, 143 °C at 0°, 32°, 90°, 90°, …
//
// Temperatures are plain °C (0x5A = 90 °C). Nothing here talks to the car: this file finds, decodes and encodes the
// curve, and checks a new curve before anything may be written.

export type CurveFormat = 'pairs' | 'list';

export interface CurvePoint {
  /** °C */
  temp: number;
  /** needle angle in degrees from the bottom stop (90 = 12 o'clock) */
  angle: number;
}

export interface GaugeCurve {
  format: CurveFormat;
  /** byte offset of the curve in the EEPROM image */
  offset: number;
  /** bytes the curve occupies (and the only bytes a write may change) */
  length: number;
  points: CurvePoint[];
  /** angles cannot be changed in this format (they are fixed by the cluster) */
  fixedAngles: boolean;
}

export const POINT_NAMES = ['Gauge start (bottom stop)', 'End of the blue zone', 'Center: buffer start', 'Center: buffer end', 'Start of the red zone', 'End of the scale (red)'];

/** Where each format usually is; used to pick one when the pattern shows up more than once. */
const USUAL_OFFSET: Record<CurveFormat, number[]> = { pairs: [0xf0], list: [0x34d, 0x340] };

const nonDecreasing = (v: number[]) => v.every((x, i) => i === 0 || x >= v[i - 1]);
const increasing = (v: number[]) => v.every((x, i) => i === 0 || x > v[i - 1]);

/** "temperature, angle" × 6. Strict enough not to match random data. */
function readPairs(b: Uint8Array, o: number): CurvePoint[] | null {
  if (o + 12 > b.length) return null;
  const temps = [0, 2, 4, 6, 8, 10].map((k) => b[o + k]);
  const angles = [1, 3, 5, 7, 9, 11].map((k) => b[o + k]);
  if (angles[0] !== 0 || temps[0] > 40 || temps[0] === 0) return null;
  if (!increasing(temps) || !nonDecreasing(angles)) return null;
  if (temps[5] < 90 || temps[5] > 160 || temps[2] < 50) return null;
  if (angles[5] < 0x80 || angles[5] > 0xb4 || angles[2] < 0x30 || angles[2] > 0x80) return null;
  return temps.map((t, i) => ({ temp: t, angle: angles[i] }));
}

/** 06, 6 temperatures, 6 angles in 2° steps. The two last angles are not always plausible: then the usual ones. */
function readList(b: Uint8Array, o: number): { points: CurvePoint[]; length: number } | null {
  if (o + 11 > b.length || b[o] !== 0x06) return null;
  const temps = Array.from(b.subarray(o + 1, o + 7));
  if (temps[0] > 40 || temps[0] === 0 || !increasing(temps) || temps[5] < 90 || temps[5] > 160 || temps[2] < 50) return null;
  const a = Array.from(b.subarray(o + 7, Math.min(o + 13, b.length)));
  if (a[0] !== 0 || a[1] < 0x08 || a[1] > 0x20 || a[2] < 0x20 || a[2] > 0x30 || a[3] < a[2] || a[3] > 0x40) return null;
  const tail = a.length === 6 && nonDecreasing(a) && a[5] <= 0x5a ? a : [...a.slice(0, 4), 0x4f, 0x54];
  return { points: temps.map((t, i) => ({ temp: t, angle: tail[i] * 2 })), length: 7 };
}

/** Finds the coolant gauge curve in a cluster EEPROM image. null: not found (no write is offered then). */
export function findCurve(eeprom: Uint8Array): GaugeCurve | null {
  const found: GaugeCurve[] = [];
  for (let o = 0; o < eeprom.length; o++) {
    const p = readPairs(eeprom, o);
    if (p) found.push({ format: 'pairs', offset: o, length: 12, points: p, fixedAngles: false });
    const l = readList(eeprom, o);
    if (l) found.push({ format: 'list', offset: o, length: l.length, points: l.points, fixedAngles: true });
  }
  if (!found.length) return null;
  if (found.length === 1) return found[0];
  const usual = found.filter((c) => USUAL_OFFSET[c.format].includes(c.offset));
  return usual.length === 1 ? usual[0] : null; // ambiguous: better not to guess where to write
}

/** The bytes of a curve, in the format of the one read from the car. */
export function encodeCurve(format: CurveFormat, points: CurvePoint[]): number[] {
  if (format === 'pairs') return points.flatMap((p) => [p.temp, p.angle]);
  return [0x06, ...points.map((p) => p.temp)]; // angles stay as the cluster has them
}

/** Copy of the EEPROM image with the new curve put in place. */
export function applyCurve(eeprom: Uint8Array, curve: GaugeCurve, points: CurvePoint[]): Uint8Array {
  const out = eeprom.slice();
  out.set(encodeCurve(curve.format, points), curve.offset);
  return out;
}

/** Needle angle for a temperature (straight lines between the points, like the cluster). */
export function needleAngle(points: CurvePoint[], temp: number): number {
  if (temp <= points[0].temp) return points[0].angle;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (temp <= b.temp) return a.angle + ((b.angle - a.angle) * (temp - a.temp)) / (b.temp - a.temp);
  }
  return points[points.length - 1].angle;
}

/** Temperature range in which the needle stays at 12 o'clock (90°), or null when there is no flat part there. */
export function bufferRange(points: CurvePoint[]): [number, number] | null {
  for (let i = 1; i < points.length; i++)
    if (points[i].angle === points[i - 1].angle && Math.abs(points[i].angle - 90) <= 8) return [points[i - 1].temp, points[i].temp];
  return null;
}

export interface CurveCheck {
  /** problems that block the write */
  errors: string[];
  /** allowed, but worth reading before writing */
  warnings: string[];
}

/** Checks a new curve. Writes are offered only without errors. */
export function checkCurve(points: CurvePoint[], format: CurveFormat): CurveCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (points.length !== 6) errors.push('The curve needs exactly 6 points.');
  const t = points.map((p) => p.temp);
  const a = points.map((p) => p.angle);
  if (t.some((x) => !Number.isInteger(x) || x < 1 || x > 150)) errors.push('Temperatures must be whole numbers from 1 to 150 °C.');
  if (!increasing(t)) errors.push('Each temperature must be higher than the one before it (the cluster divides by the difference).');
  if (format === 'pairs') {
    if (a.some((x) => !Number.isInteger(x) || x < 0 || x > 180)) errors.push('Needle angles must be whole numbers from 0 to 180°.');
    if (a[0] !== 0) errors.push('The first point must be at 0° (the bottom stop).');
    if (!nonDecreasing(a)) errors.push('Needle angles cannot go back down.');
  }
  if (!errors.length) {
    if (t[0] > 40) warnings.push('The needle leaves the bottom stop only above 40 °C.');
    const redStart = t[4];
    if (redStart > 125) warnings.push(`The red zone starts at ${redStart} °C: later than the factory 124–125 °C, so less warning of overheating.`);
    if (t[5] > 130) warnings.push(`The needle reaches the end of the scale only at ${t[5]} °C.`);
    if (t[2] < 70) warnings.push(`The needle is already at 12 o'clock at ${t[2]} °C, before the engine is warm.`);
    const buf = bufferRange(points);
    if (!buf) warnings.push('No flat part at 12 o\'clock: the needle moves all the time with the thermostat (about 88–105 °C on an M54). That is the point of the mod, but it can look alarming at first.');
  }
  return { errors, warnings };
}

export interface CurvePreset {
  id: string;
  name: string;
  note: string;
  format: CurveFormat;
  points: CurvePoint[];
}

const P = (temps: number[], angles: number[]): CurvePoint[] => temps.map((t, i) => ({ temp: t, angle: angles[i] }));
const ANG_PAIRS = [0, 31, 90, 90, 148, 164];
const ANG_LIST = [0, 32, 90, 90, 158, 168];

/** Curves from the E46Fanatics guide. The factory one is what BMW ships; "restore" uses your own backup instead. */
export const PRESETS: CurvePreset[] = [
  { id: 'factory', name: 'Factory (BMW)', note: 'Buffer 75–115 °C: the needle sits at 12 o\'clock across the whole normal range.', format: 'pairs', points: P([15, 50, 75, 115, 124, 125], ANG_PAIRS) },
  { id: 'rev1', name: 'Revision #1: buffer 90–100 °C', note: 'The guide\'s main revision. 12 o\'clock from 90 to 100 °C, red from 110 °C, end of scale at 115 °C.', format: 'pairs', points: P([15, 65, 90, 100, 110, 115], ANG_PAIRS) },
  { id: 'rev2', name: 'Revision #2: no buffer', note: 'Almost linear in the upper half: 12 o\'clock at 95 °C, third mark at 105 °C, red at 115 °C, end at 120 °C.', format: 'pairs', points: P([15, 65, 95, 105, 115, 120], [0, 31, 90, 124, 148, 164]) },
  { id: 'factory', name: 'Factory (BMW)', note: 'Buffer 75–115 °C: the needle sits at 12 o\'clock across the whole normal range.', format: 'list', points: P([15, 50, 75, 115, 125, 143], ANG_LIST) },
  { id: 'rev1', name: 'Revised: buffer 90–100 °C', note: 'The guide\'s revision for 2003+ clusters. Red from 110 °C, end of scale at 115 °C.', format: 'list', points: P([15, 65, 90, 100, 110, 115], ANG_LIST) },
  { id: 'rev1b', name: 'Revised, end at 120 °C', note: 'Same buffer 90–100 °C, end of the scale at 120 °C (used by several members in the thread).', format: 'list', points: P([15, 65, 90, 100, 110, 120], ANG_LIST) },
  { id: 'm3', name: 'E46 M3 curve: buffer 85–95 °C', note: 'What BMW put in the M3 cluster. Red from 105 °C.', format: 'list', points: P([15, 60, 85, 95, 105, 115], ANG_LIST) },
];

export const presetsFor = (format: CurveFormat) => PRESETS.filter((p) => p.format === format);

/** Same temperatures (and angles when they can change)? */
export function sameCurve(a: CurvePoint[], b: CurvePoint[], format: CurveFormat): boolean {
  return a.length === b.length && a.every((p, i) => p.temp === b[i].temp && (format === 'list' || p.angle === b[i].angle));
}

/** Gives a preset the angles of the curve read from the car when the format keeps them fixed. */
export function withCarAngles(preset: CurvePoint[], car: GaugeCurve): CurvePoint[] {
  return car.fixedAngles ? preset.map((p, i) => ({ temp: p.temp, angle: car.points[i].angle })) : preset.map((p) => ({ ...p }));
}

/** Hex dump line(s) like PA Soft: "0F0: 0F 00 32 …". */
export function hexLine(bytes: ArrayLike<number>, offset: number): string {
  return `${offset.toString(16).toUpperCase().padStart(3, '0')}: ${Array.from(bytes, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`;
}
