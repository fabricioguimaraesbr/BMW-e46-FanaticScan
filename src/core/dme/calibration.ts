// Reading and editing DME calibration items through a version's definition (src/core/dme/defs.ts). Works on a copy
// of an image in memory; nothing here talks to the car.

import type { DmeAxis, DmeItem, DmeRaw, DmeVersionDef } from './defs';
import type { DmeImageInfo } from './image';

export interface ItemValues {
  item: DmeItem;
  /** values[row][col] in the item's units */
  values: number[][];
  raw: number[][];
  /** column axis (x) and row axis (y) values; a constant has none */
  x?: number[];
  y?: number[];
}

const byteLen = (r: DmeRaw) => r.bits / 8;

function fileOffset(info: DmeImageInfo, def: DmeVersionDef, addr: number): number {
  if (addr < 0 || addr >= def.calSize) throw new Error(`Address 0x${addr.toString(16)} is outside the calibration.`);
  return info.calStart + addr;
}

function readRaw(b: Uint8Array, at: number, r: DmeRaw): number {
  const n = byteLen(r);
  let v = 0;
  for (let i = 0; i < n; i++) v += b[at + (r.lsb ? i : n - 1 - i)] * 2 ** (8 * i);
  if (r.signed && v >= 2 ** (r.bits - 1)) v -= 2 ** r.bits;
  return v;
}

function writeRaw(b: Uint8Array, at: number, r: DmeRaw, v: number) {
  const n = byteLen(r);
  let u = v < 0 ? v + 2 ** r.bits : v;
  for (let i = 0; i < n; i++) {
    b[at + (r.lsb ? i : n - 1 - i)] = u % 256;
    u = Math.floor(u / 256);
  }
}

export function rawLimits(r: DmeRaw): [number, number] {
  return r.signed ? [-(2 ** (r.bits - 1)), 2 ** (r.bits - 1) - 1] : [0, 2 ** r.bits - 1];
}

const round = (v: number) => +v.toPrecision(10);

function readAxis(b: Uint8Array, info: DmeImageInfo, def: DmeVersionDef, a: DmeAxis | undefined): number[] | undefined {
  if (!a) return undefined;
  if (a.labels) return a.labels;
  const r = a.raw!;
  const at = fileOffset(info, def, r.addr);
  return Array.from({ length: a.count }, (_, i) => round(a.scale! * readRaw(b, at + i * byteLen(r), r) + a.offset!));
}

export function readItem(b: Uint8Array, info: DmeImageInfo, def: DmeVersionDef, item: DmeItem): ItemValues {
  const at = fileOffset(info, def, item.raw.addr);
  fileOffset(info, def, item.raw.addr + item.rows * item.cols * byteLen(item.raw) - 1);
  const raw: number[][] = [], values: number[][] = [];
  for (let r = 0; r < item.rows; r++) {
    raw.push([]); values.push([]);
    for (let c = 0; c < item.cols; c++) {
      const v = readRaw(b, at + (r * item.cols + c) * byteLen(item.raw), item.raw);
      raw[r].push(v);
      values[r].push(round(item.scale * v + item.offset));
    }
  }
  return { item, values, raw, x: readAxis(b, info, def, item.x), y: readAxis(b, info, def, item.y) };
}

/** The value a raw step really gives (what the DME will use) for a wanted value. */
export function quantize(item: DmeItem, value: number): { raw: number; value: number } {
  const raw = Math.round((value - item.offset) / item.scale);
  return { raw, value: round(item.scale * raw + item.offset) };
}

export interface EditCheck {
  errors: string[];
}

/** Checks new values for an item: size, range of the stored type, and the definition's own min/max. */
export function checkValues(item: DmeItem, values: number[][]): EditCheck {
  const errors: string[] = [];
  if (values.length !== item.rows || values.some((r) => r.length !== item.cols)) {
    errors.push(`${item.name}: expected ${item.rows}×${item.cols} values.`);
    return { errors };
  }
  const [lo, hi] = rawLimits(item.raw);
  values.forEach((row, r) => row.forEach((v, c) => {
    const where = item.kind === 'const' ? item.name : `${item.name} [${r + 1}, ${c + 1}]`;
    if (!Number.isFinite(v)) { errors.push(`${where}: not a number.`); return; }
    const q = quantize(item, v);
    if (q.raw < lo || q.raw > hi) errors.push(`${where}: ${v} ${item.units} cannot be stored (range ${round(item.scale * lo + item.offset)}…${round(item.scale * hi + item.offset)}).`);
    else if (item.min !== undefined && q.value < item.min - 1e-9) errors.push(`${where}: below the minimum ${item.min} ${item.units}.`);
    else if (item.max !== undefined && q.value > item.max + 1e-9) errors.push(`${where}: above the maximum ${item.max} ${item.units}.`);
  }));
  return { errors };
}

/** Writes new values of one item into a copy of the image; returns the copy and the bytes that changed. */
export function writeItem(b: Uint8Array, info: DmeImageInfo, def: DmeVersionDef, item: DmeItem, values: number[][]): { image: Uint8Array; changed: number[] } {
  const check = checkValues(item, values);
  if (check.errors.length) throw new Error(check.errors.join(' '));
  const img = b.slice();
  const at = fileOffset(info, def, item.raw.addr);
  for (let r = 0; r < item.rows; r++) {
    for (let c = 0; c < item.cols; c++) writeRaw(img, at + (r * item.cols + c) * byteLen(item.raw), item.raw, quantize(item, values[r][c]).raw);
  }
  const changed: number[] = [];
  for (let i = 0; i < img.length; i++) if (img[i] !== b[i]) changed.push(i);
  return { image: img, changed };
}

// ---------------------------------------------------------------------------------------------- sanity
/**
 * Checks that the definition fits the image before anything is shown as real: the versions agree, every stored
 * axis rises, and the values sit inside the definition's own range. A wrong definition on an image gives
 * axes that jump around, which these checks catch.
 */
export function checkDefinitionFits(b: Uint8Array, info: DmeImageInfo, def: DmeVersionDef, names?: string[]): string[] {
  const problems: string[] = [];
  if (def.family !== info.family || def.version !== info.version) problems.push(`The definition is for ${def.family} ${def.version}, the read is ${info.family} ${info.version}.`);
  if (info.programVersion && info.programVersion !== info.version) problems.push(`The program (${info.programVersion}) and the calibration (${info.version}) are different versions.`);
  for (const item of def.items) {
    if (names && !names.includes(item.name)) continue;
    let v: ItemValues;
    try { v = readItem(b, info, def, item); } catch (e) { problems.push((e as Error).message); continue; }
    for (const [ax, vals] of [[item.x, v.x], [item.y, v.y]] as const) {
      if (!ax?.raw || !vals || vals.length < 2) continue;
      // factory axes may repeat a point (a flat step; an unused table is flat throughout) but never fall
      const rises = vals.every((x, i) => i === 0 || x >= vals[i - 1]);
      if (!rises) problems.push(`${item.name}: axis ${ax.name ?? ''} falls (${vals.join(', ')}).`);
    }
    const flat = v.values.flat();
    if (item.min !== undefined && flat.some((x) => x < item.min! - 1e-6)) problems.push(`${item.name}: values below the defined range.`);
    if (item.max !== undefined && flat.some((x) => x > item.max! + 1e-6)) problems.push(`${item.name}: values above the defined range.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------- engine cooling view
/** What the Engine cooling page shows, in order (an item a version does not have is skipped). */
export const COOLING_GROUPS: { title: string; note: string; items: string[] }[] = [
  {
    title: 'Target coolant temperature maps',
    note: 'Target the e-thermostat works toward once the engine is warm, by engine speed and load.',
    items: ['id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub'],
  },
  {
    title: 'When the maps take over',
    note: 'Until oil, ambient and intake air pass these, the target is "Target before warm-up".',
    items: ['c_toil_min_ect', 'c_tam_min_ect', 'c_tia_min_ect', 'c_tco_min_ect', 'c_tco_sp_toil_min'],
  },
  {
    title: 'Overrides',
    note: 'Fixed targets when it gets too hot or another module asks for a cool engine.',
    items: ['c_toil_max_ect', 'c_tia_max_ect', 'c_tco_ex_max_ect', 'c_tco_sp_tia_max', 'c_tco_sp_tco_ex_max', 'c_tco_bol_ect'],
  },
  {
    title: 'Thermostat control',
    note: 'How hard the thermostat heater is driven (read only).',
    items: ['id_ectpwm_add__n__tco_sp', 'ip_ectpwm_p__tco_dif', 'ip_ectpwm_i__tco_dif'],
  },
  {
    title: 'Electric fan',
    note: 'Minimum fan stage by radiator outlet temperature, and the speed correction.',
    items: ['ip_n_ecf__tco_ex', 'ip_n_ecf_vs_cor__vs'],
  },
];

/** Friendly names for the items above (the XDF names stay visible in the detail). */
export const COOLING_LABELS: Record<string, string> = {
  id_tco_sp_ect__n__maf_sub: 'Target coolant temperature, A/C off',
  id_tco_sp_ect_acin__n__maf_sub: 'Target coolant temperature, A/C on',
  c_toil_min_ect: 'Oil temperature to enable the maps',
  c_tam_min_ect: 'Ambient temperature to enable the maps',
  c_tia_min_ect: 'Intake air temperature to enable the maps',
  c_tco_min_ect: 'Coolant temperature for full thermostat heating',
  c_tco_sp_toil_min: 'Target before warm-up',
  c_toil_max_ect: 'Oil temperature limit',
  c_tia_max_ect: 'Intake air temperature limit',
  c_tco_ex_max_ect: 'Radiator outlet temperature limit',
  c_tco_sp_tia_max: 'Target above the oil / intake air limit',
  c_tco_sp_tco_ex_max: 'Target above the radiator outlet limit',
  c_tco_bol_ect: 'Target on a low-temperature request',
  id_ectpwm_add__n__tco_sp: 'Thermostat heater duty for the target',
  ip_ectpwm_p__tco_dif: 'Thermostat controller P',
  ip_ectpwm_i__tco_dif: 'Thermostat controller I',
  ip_n_ecf__tco_ex: 'Fan minimum stage by radiator outlet temperature',
  ip_n_ecf_vs_cor__vs: 'Fan correction by road speed',
};

/** Items the app may offer to change at all (the rest of the page is read only). */
export const COOLING_EDITABLE = [
  'id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub',
  'c_tco_sp_toil_min', 'c_toil_min_ect', 'c_tam_min_ect', 'c_tia_min_ect',
  'c_toil_max_ect', 'c_tia_max_ect', 'c_tco_ex_max_ect', 'c_tco_sp_tia_max', 'c_tco_sp_tco_ex_max',
];

export function coolingItems(def: DmeVersionDef): { title: string; note: string; items: DmeItem[] }[] {
  return COOLING_GROUPS.map((g) => ({ ...g, items: g.items.map((n) => def.items.find((i) => i.name === n)).filter((i): i is DmeItem => !!i) }))
    .filter((g) => g.items.length);
}
