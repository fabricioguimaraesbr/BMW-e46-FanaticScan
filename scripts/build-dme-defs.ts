// Builds src/core/dme/defs.json from the TunerPro definition files (XDF) of the MS4X Dev Team
// (https://github.com/ms4x-net/ms42 and https://github.com/ms4x-net/ms43, GPL-3.0, the same licence as this app).
//
// Only the items the app shows are kept (categories in KEEP_CATEGORIES), so the app does not carry the 3.5 MB XDFs.
// Every scaling equation is checked to be linear (value = scale·raw + offset): that is what lets a value typed by the
// user go back to raw bytes exactly. An item whose equation is not linear, or whose layout the app does not
// understand, stops the build instead of being guessed.
//
// Usage: npx tsx scripts/build-dme-defs.ts [MS4X_DIR]   (MS4X_DIR holds clones of ms4x-net/ms42 and ms4x-net/ms43)

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { DmeAxis, DmeDefs, DmeFamily, DmeItem, DmeRaw, DmeVersionDef } from '../src/core/dme/defs';

const MS4X_DIR = process.argv[2] ?? process.env.MS4X_DIR ?? '/home/claude/ms4x-net';
const OUT = join(import.meta.dirname, '../src/core/dme/defs.json');
const KEEP_CATEGORIES = ['eThermostat', 'Coolant Fan'];
/** Kept whatever category the XDF puts them in (the MS42 file files some thermostat items elsewhere). */
const KEEP_NAMES = [
  'id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub', 'c_toil_min_ect', 'c_tam_min_ect', 'c_tia_min_ect', 'c_tco_min_ect',
  'c_tco_sp_toil_min', 'c_toil_max_ect', 'c_tia_max_ect', 'c_tco_ex_max_ect', 'c_tco_sp_tia_max', 'c_tco_sp_tco_ex_max', 'c_tco_bol_ect',
];

/** The calibration-only XDF of each software version (its addresses count from the start of the calibration). */
const SOURCES: { family: DmeFamily; dir: string; match: RegExp }[] = [
  { family: 'MS43', dir: 'ms43/definitions', match: /^Siemens_MS43_MS43(\d{4})_ENG_64K_v[\d.]+\.xdf$/ },
  { family: 'MS42', dir: 'ms42/definitions', match: /^Siemens_MS42_(0110[0-9A-F]{2})_ENG_32K_v[\d.]+\.xdf$/ },
];

// ---------------------------------------------------------------------------------------------- equations
/** Evaluates a TunerPro equation (numbers, X, + - * / and parentheses) for one X. */
function evalEquation(eq: string, x: number): number {
  const src = eq.replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  const num = (): number => {
    if (peek() === '(') { i++; const v = sum(); if (src[i++] !== ')') throw new Error(`")" missing in ${eq}`); return v; }
    if (peek() === '-') { i++; return -num(); }
    if (peek() === '+') { i++; return num(); }
    if (peek() === 'X') { i++; return x; }
    const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`unexpected "${src.slice(i)}" in ${eq}`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const product = (): number => {
    let v = num();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = num(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = sum();
  if (i !== src.length) throw new Error(`could not read the end of ${eq}`);
  return v;
}

/** scale and offset of a linear equation, or an error when it is not linear. */
function linear(eq: string, where: string): { scale: number; offset: number } {
  const f0 = evalEquation(eq, 0), f1 = evalEquation(eq, 1);
  const scale = f1 - f0, offset = f0;
  for (const x of [2, 100, 255, 1000]) {
    if (Math.abs(evalEquation(eq, x) - (scale * x + offset)) > 1e-6 * Math.max(1, Math.abs(scale * x))) {
      throw new Error(`${where}: equation "${eq}" is not linear`);
    }
  }
  return { scale: +scale.toPrecision(10), offset: +offset.toPrecision(10) };
}

// ---------------------------------------------------------------------------------------------- XDF
type Node = Record<string, any>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const hexnum = (s: string | number | undefined) => (s === undefined ? undefined : typeof s === 'number' ? s : parseInt(s, s.startsWith('0x') || s.startsWith('0X') ? 16 : 10));
const entities = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const text = (v: unknown) => entities(v === undefined || v === null ? '' : String(typeof v === 'object' ? (v as Node)['#text'] ?? '' : v)).trim();

function rawOf(ed: Node, where: string, defaults: { lsb: boolean; signed: boolean }): DmeRaw {
  const flags = hexnum(ed['@_mmedtypeflags']);
  if (flags !== undefined && flags & ~0x03) throw new Error(`${where}: type flags 0x${flags.toString(16)} not supported`);
  for (const s of ['@_mmedmajorstridebits', '@_mmedminorstridebits']) {
    if (ed[s] !== undefined && Number(ed[s]) !== 0) throw new Error(`${where}: strides not supported`);
  }
  const bits = Number(ed['@_mmedelementsizebits'] ?? 8);
  if (![8, 16, 32].includes(bits)) throw new Error(`${where}: ${bits}-bit elements not supported`);
  const addr = hexnum(ed['@_mmedaddress']);
  if (addr === undefined) throw new Error(`${where}: no address`);
  return {
    addr,
    bits: bits as 8 | 16 | 32,
    signed: flags === undefined ? defaults.signed : !!(flags & 1),
    lsb: flags === undefined ? defaults.lsb : !!(flags & 2),
  };
}

function convert(file: string, family: DmeFamily, version: string): DmeVersionDef {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false, parseTagValue: false, trimValues: false });
  const root: Node = parser.parse(readFileSync(file, 'utf8')).XDFFORMAT;
  const header: Node = root.XDFHEADER;
  const d: Node = header.DEFAULTS ?? {};
  const defaults = { lsb: d['@_lsbfirst'] === '1', signed: d['@_signed'] === '1' };
  const cats = new Map<number, string>();
  for (const c of arr<Node>(header.CATEGORY)) cats.set(hexnum(c['@_index'])! + 1, c['@_name']);
  const all: Node[] = [...arr<Node>(root.XDFCONSTANT), ...arr<Node>(root.XDFTABLE)];
  const byId = new Map<number, Node>();
  for (const e of all) if (e['@_uniqueid'] !== undefined) byId.set(hexnum(e['@_uniqueid'])!, e);
  const region = arr<Node>(header.REGION)[0];

  const axisOf = (ax: Node, where: string): DmeAxis => {
    const units = text(ax.units);
    const link = ax.embedinfo?.['@_linkobjid'];
    if (link !== undefined) {
      const lt = byId.get(hexnum(link)!);
      if (!lt) throw new Error(`${where}: axis table ${link} missing`);
      const z = arr<Node>(lt.XDFAXIS).find((a) => a['@_id'] === 'z')!;
      const count = Number(ax.indexcount);
      const zr = Number(z.EMBEDDEDDATA['@_mmedrowcount'] ?? 1) * Number(z.EMBEDDEDDATA['@_mmedcolcount'] ?? 1);
      if (zr !== count) throw new Error(`${where}: axis has ${count} points, its table ${zr}`);
      return { units, count, raw: rawOf(z.EMBEDDEDDATA, where + ' axis', defaults), ...linear(z.MATH['@_equation'], where + ' axis'), name: text(lt.title) };
    }
    const labels = arr<Node>(ax.LABEL).map((l) => Number(l['@_value']));
    const count = Number(ax.indexcount ?? labels.length);
    if (labels.length === count) return { units, count, labels };
    // the XDF gives the point count but not where the axis values are: show the points by number only
    return { units: '', count, labels: Array.from({ length: count }, (_, i) => i + 1), unknown: true };
  };

  const items: DmeItem[] = [];
  for (const e of all) {
    const cat = cats.get(Number(e.CATEGORYMEM?.['@_category'] ?? -1));
    const name = text(e.title);
    if (!KEEP_NAMES.includes(name) && (!cat || !KEEP_CATEGORIES.includes(cat))) continue;
    const where = `${version} ${name}`;
    const common = { name, desc: text(e.description), category: cat ?? '' };
    if (e.EMBEDDEDDATA) {
      const r = rawOf(e.EMBEDDEDDATA, where, defaults);
      const lo = e.rangelow !== undefined ? Number(text(e.rangelow)) : undefined;
      const hi = e.rangehigh !== undefined ? Number(text(e.rangehigh)) : undefined;
      items.push({
        ...common, kind: 'const', raw: r, rows: 1, cols: 1, units: text(e.units), decimals: Number(text(e.decimalpl) || 2),
        ...linear(e.MATH['@_equation'], where), min: lo, max: hi,
      });
    } else {
      const axes = arr<Node>(e.XDFAXIS);
      const z = axes.find((a) => a['@_id'] === 'z')!;
      const x = axisOf(axes.find((a) => a['@_id'] === 'x')!, where + ' x');
      const y = axisOf(axes.find((a) => a['@_id'] === 'y')!, where + ' y');
      const rows = Number(z.EMBEDDEDDATA['@_mmedrowcount'] ?? 1), cols = Number(z.EMBEDDEDDATA['@_mmedcolcount'] ?? 1);
      if (rows !== y.count || cols !== x.count) throw new Error(`${where}: ${rows}×${cols} values but axes ${y.count}×${x.count}`);
      items.push({
        ...common, kind: 'table', raw: rawOf(z.EMBEDDEDDATA, where, defaults), rows, cols, units: text(z.units),
        decimals: Number(text(z.decimalpl) || 2), ...linear(z.MATH['@_equation'], where),
        min: z.min !== undefined ? Number(text(z.min)) : undefined, max: z.max !== undefined ? Number(text(z.max)) : undefined, x, y,
      });
    }
  }
  // The XDF min/max are a display hint and sometimes in raw units (the MS42 file gives 0…255 for values like
  // -6.25…6.2). Keep them only when they lie inside what the stored type can represent.
  for (const it of items) {
    const lo = it.raw.signed ? -(2 ** (it.raw.bits - 1)) : 0, hi = it.raw.signed ? 2 ** (it.raw.bits - 1) - 1 : 2 ** it.raw.bits - 1;
    const a = it.scale * lo + it.offset, b = it.scale * hi + it.offset;
    const vmin = Math.min(a, b), vmax = Math.max(a, b), tol = Math.abs(it.scale);
    const outside = (v?: number) => v !== undefined && (v < vmin - tol || v > vmax + tol);
    // one limit out of range means the pair is in other units: drop both
    if (outside(it.min) || outside(it.max) || (it.min !== undefined && it.max !== undefined && it.min >= it.max)) it.min = it.max = undefined;
    if (it.min === undefined) delete it.min;
    if (it.max === undefined) delete it.max;
  }
  // one entry per name (a few XDFs list an item twice)
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true))).sort((a, b) => a.name.localeCompare(b.name));
  return {
    family,
    version,
    xdf: file.split('/').pop()!,
    xdfVersion: text(header.fileversion),
    calSize: hexnum(region?.['@_size']) ?? 0,
    items: unique,
  };
}

const versions: DmeVersionDef[] = [];
for (const s of SOURCES) {
  for (const f of readdirSync(join(MS4X_DIR, s.dir)).sort()) {
    const m = s.match.exec(f);
    if (!m) continue;
    const version = s.family === 'MS43' ? '43' + m[1] : m[1];
    versions.push(convert(join(MS4X_DIR, s.dir, f), s.family, version));
  }
}
const out: DmeDefs = {
  source: 'MS4X Dev Team definition files (https://github.com/ms4x-net/ms42, https://github.com/ms4x-net/ms43), GPL-3.0',
  categories: KEEP_CATEGORIES,
  versions,
};
writeFileSync(OUT, JSON.stringify(out));
for (const v of versions) console.log(`${v.family} ${v.version}: ${v.items.length} items (${v.xdf})`);
console.log(`wrote ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(0)} kB)`);
