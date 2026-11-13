// Telemetry: a full-screen dash for the car's Android head unit (or a phone on the dash).
// Approved layout "24 · FINAL": tachometer and speedometer with amber lighting, coolant and oil arcs around the
// gear display (P R N D S), tiles coloured by kind of value, a drawer with the last 60 s, CSV recording and
// extra values picked from the engine and gearbox. Read-only: it only reads value groups.

import type { Value } from '../core/api/DiagSession';
import { baseKey } from '../core/api/reference';
import { CHART_IDS, Cat, FuelEstimator, Frame, MAIN_TILES, METRIC, Mod, Snapshot, fmtMetric, isBad, snapshot } from '../core/api/telemetry';
import type { PageCtx } from './ctx';
import { download, h, stamp, store } from './dom';
import { isNativeApp } from './nativeApp';

const NS = 'http://www.w3.org/2000/svg';
function sv(tag: string, attrs: Record<string, string | number> = {}, ...kids: (Node | string)[]) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
}

const COLOR: Record<Cat | 'alarm', string> = {
  rev: '#ffb862', cool: '#4290f6', rad: '#5cc8ff', oil: '#ffa033', vanos: '#b36bff', trim: '#41d38a', air: '#2fd3c0',
  pedal: '#e9edf2', trans: '#ff7a45', elec: '#f2cf4a', fuel: '#ffb862', other: '#c9ced6', alarm: '#ff4d3d',
};
const HISTORY_MS = 60_000;
const EXTRAS_KEY = 'e46diag.telemetryExtras';
const RPM_MAX = 8000;
const SPEED_MAX = 260;
const A0 = 135;
const SW = 270;

interface Hist { t: number; v: Record<string, number | undefined> }
interface Refs {
  tachArc: SVGPathElement; tachNeedle: SVGLineElement; tachText: HTMLElement;
  spdArc: SVGPathElement; spdNeedle: SVGLineElement; spdText: HTMLElement;
  arcs: Record<'ect' | 'oil', { fill: SVGPathElement; value: HTMLElement; cell: HTMLElement }>;
  sel: Record<string, HTMLElement>; gear: HTMLElement; mode: HTMLElement; kml: HTMLElement; kmlLabel: HTMLElement; avg: HTMLElement;
  tiles: Map<string, { box: HTMLElement; value: HTMLElement }>;
  charts: Map<string, { box: HTMLElement; value: HTMLElement; line: SVGPolylineElement; min: HTMLElement; max: HTMLElement }>;
  status: HTMLElement; rec: HTMLButtonElement;
}

const T = {
  running: false,
  frame: { DME: new Map<string, Value>(), EGS: new Map<string, Value>() },
  snap: null as Snapshot | null,
  kml: undefined as number | undefined,
  fuel: new FuelEstimator(),
  hist: [] as Hist[],
  rate: 0,
  status: '' as '' | 'live' | 'retry' | 'nocar',
  drawer: false,
  picker: '' as '' | Mod,
  rec: null as { start: number; rows: string[][] } | null,
  toast: '',
  extras: store.get<string[]>(EXTRAS_KEY, []),
  refs: null as Refs | null,
  wake: null as { release(): Promise<void> } | null,
};

export function stopTelemetry() {
  T.running = false;
  void T.wake?.release().catch(() => undefined);
  T.wake = null;
}
/** Forget the car (disconnect). */
export function resetTelemetry() {
  stopTelemetry();
  T.frame = { DME: new Map(), EGS: new Map() };
  T.snap = null;
  T.hist = [];
  T.fuel.reset();
  T.rec = null;
}

// ------------------------------------------------------------------ geometry
function pt(cx: number, cy: number, r: number, a: number): [number, number] {
  const q = (a * Math.PI) / 180;
  return [cx + r * Math.cos(q), cy + r * Math.sin(q)];
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
  if (!ccw && a1 - a0 < 0.5) a1 = a0 + 0.5;
  if (ccw && a0 - a1 < 0.5) a1 = a0 - 0.5;
  const p0 = pt(cx, cy, r, a0), p1 = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A${r} ${r} 0 ${large} ${ccw ? 0 : 1} ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function dial(kind: 'tach' | 'speed') {
  const max = kind === 'tach' ? RPM_MAX : SPEED_MAX;
  const minor = kind === 'tach' ? 250 : 10;
  const major = kind === 'tach' ? 1000 : 20;
  const svg = sv('svg', { viewBox: '0 0 400 380', class: 'tm-dial', role: 'img', 'aria-label': kind === 'tach' ? 'Engine speed' : 'Vehicle speed' });
  const fid = `tmglow-${kind}`;
  svg.append(sv('defs', {}, sv('filter', { id: fid, x: '-30%', y: '-30%', width: '160%', height: '160%' },
    sv('feGaussianBlur', { stdDeviation: 3, result: 'b' }), sv('feMerge', {}, sv('feMergeNode', { in: 'b' }), sv('feMergeNode', { in: 'SourceGraphic' })))));
  svg.append(sv('circle', { cx: 200, cy: 200, r: 180, class: 'tm-face' }));
  svg.append(sv('path', { d: arc(200, 200, 168, A0, A0 + SW), class: 'tm-track' }));
  if (kind === 'tach') svg.append(sv('path', { d: arc(200, 200, 168, A0 + (SW * 6500) / RPM_MAX, A0 + SW), class: 'tm-red' }));
  const valArc = sv('path', { d: arc(200, 200, 168, A0, A0 + 0.5), class: 'tm-valarc', filter: `url(#${fid})` }) as SVGPathElement;
  svg.append(valArc);
  for (let v = 0; v <= max; v += minor) {
    const a = A0 + (SW * v) / max, big = v % major === 0;
    const o = pt(200, 200, 160, a), q = pt(200, 200, big ? 140 : 150, a);
    svg.append(sv('line', { x1: o[0].toFixed(1), y1: o[1].toFixed(1), x2: q[0].toFixed(1), y2: q[1].toFixed(1), class: `tm-tick ${big ? 'big' : ''} ${kind === 'tach' && v >= 6500 ? 'redline' : ''}`, filter: `url(#${fid})` }));
    if (big) {
      const l = pt(200, 200, 116, a);
      svg.append(sv('text', { x: l[0].toFixed(1), y: l[1].toFixed(1), class: `tm-num ${kind}`, filter: `url(#${fid})` }, String(kind === 'tach' ? v / 1000 : v)));
    }
  }
  // the readout is HTML over the dial (an SVG filter on text can hide it in some WebViews)
  const text = h('span', { class: 'tm-digital' }, '—');
  const needle = sv('line', { x1: 200, y1: 200, x2: 338, y2: 200, class: 'tm-needle' }) as SVGLineElement;
  needle.style.transform = `rotate(${A0}deg)`;
  svg.append(needle, sv('circle', { cx: 200, cy: 200, r: 16, class: 'tm-hub' }));
  const wrap = h('div', { class: 'tm-dialwrap' }, svg, h('div', { class: 'tm-readout' }, text, h('span', { class: 'tm-unit' }, kind === 'tach' ? 'RPM' : 'KM/H')));
  return { svg: wrap, valArc, needle, text };
}

/** Coolant (left) and oil (right) arcs around the gear display. */
const TEMP_ARC = {
  ect: { lo: 40, hi: 130, okLo: 80, okHi: 110, range: '80–110 °C' },
  oil: { lo: 40, hi: 150, okLo: 70, okHi: 130, range: '70–130 °C' },
};
function tempGeom(id: 'ect' | 'oil') {
  const left = id === 'ect';
  const r = TEMP_ARC[id];
  const cx = left ? 230 : -138, cy = 130;
  const f = (y: number) => clamp01((y - r.lo) / (r.hi - r.lo));
  const ang = left ? (y: number) => 140 + 80 * f(y) : (y: number) => 40 - 80 * f(y);
  return { cx, cy, ang, ccw: !left, r };
}
function tempArc(id: 'ect' | 'oil') {
  const g = tempGeom(id);
  const svg = sv('svg', { viewBox: '0 0 92 260', class: 'tm-tarc', role: 'img', 'aria-label': `${METRIC[id].label} temperature` },
    sv('path', { d: arc(g.cx, g.cy, 200, g.ang(g.r.lo), g.ang(g.r.hi), g.ccw), class: 'tm-ttrack' }),
    sv('path', { d: arc(g.cx, g.cy, 214, g.ang(g.r.okLo), g.ang(g.r.okHi), g.ccw), class: 'tm-tband' }));
  const fill = sv('path', { d: arc(g.cx, g.cy, 200, g.ang(g.r.lo), g.ang(g.r.lo) + (g.ccw ? -0.5 : 0.5), g.ccw), class: 'tm-tfill' }) as SVGPathElement;
  svg.append(fill);
  const value = h('span', { class: 'tm-tval' }, '—', h('small', {}, ' °C'));
  const cell = h('div', { class: `tm-tcell ${id === 'ect' ? 'left' : 'right'}`, style: `--c:${COLOR[METRIC[id].cat]}` },
    h('span', { class: 'tm-tlabel' }, METRIC[id].label), value, svg, h('span', { class: 'tm-trange' }, g.r.range));
  return { cell, fill, value };
}

// ------------------------------------------------------------------ extra values (picked by the user)
const extraId = (mod: Mod, key: string) => `${mod}|${baseKey(key)}`;
function extraValue(id: string): Value | undefined {
  const [mod, base] = id.split('|') as [Mod, string];
  for (const v of T.frame[mod].values()) if (baseKey(v.key) === base) return v;
  return undefined;
}
function extraLabel(id: string) {
  const v = extraValue(id);
  return (v?.label ?? id.split('|')[1]).toUpperCase();
}

// ------------------------------------------------------------------ reading
async function run(ctx: PageCtx) {
  const s = ctx.session();
  if (!s || T.running) return;
  ctx.stopLive();
  T.running = true;
  T.status = 'live';
  const mods: { mod: Mod; group: string; variant: string }[] = [];
  for (const short of ['DME', 'EGS'] as Mod[]) {
    const m = ctx.found().find((x) => x.def.short === short && x.scan?.variant && !x.dtcNA);
    if (m?.scan?.variant) mods.push({ mod: short, group: m.def.group, variant: m.scan.variant });
  }
  if (!mods.length) {
    T.running = false;
    T.status = 'nocar';
    ctx.rerender();
    return;
  }
  for (const m of mods) await ctx.jobs(m.group).catch(() => []);
  const plan = mods.map((m) => {
    const jobs = ctx.liveJobs(m.group);
    return { ...m, main: jobs[0], side: [] as string[], all: jobs };
  }).filter((p) => p.main);
  if ('wakeLock' in navigator) {
    try { T.wake = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen'); } catch { /* not allowed here */ }
  }
  let firstPass = true;
  let turn = 0;
  let misses = 0;
  let n = 0;
  let t0 = Date.now();
  const alive = () => T.running && ctx.session() === s && !!document.querySelector('.tm-root');
  while (alive()) {
    if (!ctx.cableOk()) {
      T.status = 'retry';
      updateStatus();
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    let ok = false;
    for (const p of plan) {
      const r = await s.readValues(p.variant, p.main);
      if (!alive()) break;
      if (r.error) continue;
      ok = true;
      for (const v of r.values) T.frame[p.mod].set(v.key, v);
    }
    // a slower group in turn each cycle (VANOS target/actual when the data block has no VANOS)
    const sides = plan.flatMap((p) => p.side.map((j) => ({ p, j })));
    if (sides.length && alive()) {
      const { p, j } = sides[turn++ % sides.length];
      const r = await s.readValues(p.variant, j);
      if (!r.error) for (const v of r.values) T.frame[p.mod].set(v.key, v);
    }
    if (!alive()) break;
    if (!ok) {
      misses++;
      T.status = 'retry';
      updateStatus();
      await new Promise((r) => setTimeout(r, Math.min(250 * misses, 1500)));
      continue;
    }
    misses = 0;
    T.status = 'live';
    const frame: Frame = { DME: [...T.frame.DME.values()], EGS: [...T.frame.EGS.values()] };
    const snap = snapshot(frame);
    if (firstPass) {
      firstPass = false;
      const dme = plan.find((p) => p.mod === 'DME');
      if (dme && (snap.v.vin === undefined || snap.v.vex === undefined)) dme.side = dme.all.filter((j) => /VANOS_NW_LAGE/.test(j));
    }
    const now = Date.now();
    T.snap = snap;
    T.kml = T.fuel.update(now, snap);
    T.hist.push({ t: now, v: { ...snap.v, kml: T.kml } });
    while (T.hist.length && now - T.hist[0].t > HISTORY_MS) T.hist.shift();
    if (T.rec) T.rec.rows.push(csvRow(now, snap));
    n++;
    if (now - t0 > 2000) {
      T.rate = (n * 1000) / (now - t0);
      n = 0;
      t0 = now;
    }
    if (!T.refs || !document.contains(T.refs.status)) ctx.rerender();
    else update();
  }
  T.running = false;
}

// ------------------------------------------------------------------ CSV
const CSV_IDS = ['rpm', 'speed', 'kml', 'ect', 'oil', 'rad', 'vin', 'vex', 'stft1', 'stft2', 'pedal', 'maf', 'atf', 'slip', 'ubatt', 'iat', 'ti'];
function csvHead() {
  const head: string[] = ['time', ...CSV_IDS.map((id) => (id === 'kml' ? 'Fuel now (km/l)' : `${METRIC[id].label.toLowerCase()} (${METRIC[id].unit})`)), 'gear', 'selector', 'converter', ...T.extras.map((x) => extraLabel(x).toLowerCase())];
  return head;
}
function csvRow(t: number, s: Snapshot): string[] {
  const v: Record<string, number | undefined> = { ...s.v, kml: T.kml };
  return [new Date(t).toISOString(), ...CSV_IDS.map((id) => (v[id] === undefined ? '' : String(Math.round(v[id]! * 1000) / 1000))), s.gear ?? '', s.selector ?? '', s.lockup === undefined ? '' : s.lockup ? 'locked' : 'open',
    ...T.extras.map((x) => { const e = extraValue(x); return e ? String(e.value) : ''; })];
}
function toggleRec(ctx: PageCtx) {
  if (!T.rec) {
    T.rec = { start: Date.now(), rows: [] };
  } else {
    const rows = [csvHead(), ...T.rec.rows];
    const csv = rows.map((r) => r.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const name = `telemetry-${stamp()}.csv`;
    download(name, csv, 'text/csv');
    T.toast = `Saved ${name} · ${T.rec.rows.length} rows · ${isNativeApp() ? 'Documents/E46Fanatics' : 'your downloads'}`;
    T.rec = null;
    setTimeout(() => { T.toast = ''; document.querySelector('.tm-toast')?.remove(); }, 5000);
    ctx.rerender();
    return;
  }
  updateRec();
}

// ------------------------------------------------------------------ updating the screen
function rpmGlow(rpm: number) {
  const e = Math.pow(clamp01(rpm / RPM_MAX), 2.2);
  const a = 0.12 + 0.88 * e;
  return `drop-shadow(0 0 ${(1 + 9 * e).toFixed(1)}px rgba(255,77,26,${a.toFixed(2)})) drop-shadow(0 0 ${(2 + 26 * e).toFixed(1)}px rgba(255,77,26,${(a * 0.8).toFixed(2)}))`;
}
function setTile(t: { box: HTMLElement; value: HTMLElement }, text: string, color: string, bad: boolean, dim = false) {
  t.value.firstChild!.textContent = text;
  t.box.style.setProperty('--c', bad ? COLOR.alarm : color);
  t.box.classList.toggle('bad', bad);
  t.box.classList.toggle('dim', dim);
}
function updateStatus() {
  const r = T.refs;
  if (!r) return;
  r.status.className = `tm-status ${T.status}`;
  r.status.textContent = T.status === 'live' ? `LIVE${T.rate ? ` · ${T.rate.toFixed(1)} Hz` : ''}` : T.status === 'retry' ? 'RECONNECTING…' : T.status === 'nocar' ? 'NO ENGINE / GEARBOX' : 'STARTING…';
}
function updateRec() {
  const b = T.refs?.rec;
  if (!b) return;
  if (T.rec) {
    const secs = Math.floor((Date.now() - T.rec.start) / 1000);
    b.textContent = `■ STOP ${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    b.classList.add('on');
  } else {
    b.textContent = '● REC CSV';
    b.classList.remove('on');
  }
}

function update() {
  const r = T.refs, s = T.snap;
  updateStatus();
  updateRec();
  if (!r || !s) return;
  const v = s.v;
  // dials
  const rpm = v.rpm ?? 0, spd = v.speed ?? 0;
  const ra = A0 + SW * clamp01(rpm / RPM_MAX), sa = A0 + SW * clamp01(spd / SPEED_MAX);
  r.tachArc.setAttribute('d', arc(200, 200, 168, A0, ra));
  r.tachNeedle.style.transform = `rotate(${ra.toFixed(1)}deg)`;
  r.tachNeedle.style.filter = rpmGlow(rpm);
  r.tachText.textContent = v.rpm === undefined ? '—' : String(Math.round(v.rpm / 10) * 10);
  r.spdArc.setAttribute('d', arc(200, 200, 168, A0, sa));
  r.spdNeedle.style.transform = `rotate(${sa.toFixed(1)}deg)`;
  r.spdText.textContent = v.speed === undefined ? '—' : String(Math.round(v.speed));
  // coolant and oil arcs
  for (const id of ['ect', 'oil'] as const) {
    const x = v[id], a = r.arcs[id], g = tempGeom(id);
    const bad = x !== undefined && x > g.r.okHi;
    a.cell.style.setProperty('--c', bad ? COLOR.alarm : COLOR[METRIC[id].cat]);
    a.cell.classList.toggle('bad', bad);
    a.value.firstChild!.textContent = fmtMetric(id, x);
    a.fill.setAttribute('d', x === undefined ? '' : arc(g.cx, g.cy, 200, g.ang(g.r.lo), g.ang(Math.max(g.r.lo + 0.6, x)), g.ccw));
  }
  // selector, gear, fuel
  for (const [k, el] of Object.entries(r.sel)) el.className = `tm-sel ${s.selector === k ? (k === 'S' ? 'on sport' : 'on') : ''}`;
  r.gear.textContent = s.gear ?? (s.selector && s.selector !== 'D' && s.selector !== 'S' ? s.selector : '—');
  r.mode.textContent = s.selector === undefined ? 'NO GEARBOX DATA' : s.mode ?? 'DRIVE';
  const idle = T.kml === undefined && v.speed !== undefined && v.speed < 3 && T.fuel.lph !== undefined;
  r.kmlLabel.textContent = idle ? 'L/H' : 'KM/L';
  r.kml.textContent = idle ? T.fuel.lph!.toFixed(1) : T.kml === undefined ? '—' : T.kml >= 99.9 ? '99+' : T.kml.toFixed(1);
  const avg = T.fuel.average;
  r.avg.textContent = avg === undefined ? '—' : avg.toFixed(1);
  // tiles
  for (const id of MAIN_TILES) {
    const t = r.tiles.get(id);
    if (!t) continue;
    if (id === 'lock') {
      setTile(t, s.lockup === undefined ? '—' : s.lockup ? 'LOCKED' : 'OPEN', COLOR.trans, false, !s.lockup);
      continue;
    }
    setTile(t, fmtMetric(id, v[id]), COLOR[METRIC[id].cat], isBad(id, v[id]), v[id] === undefined);
  }
  for (const id of T.extras) {
    const t = r.tiles.get(id);
    if (!t) continue;
    const e = extraValue(id);
    const text = !e ? '—' : typeof e.value === 'number' ? (Math.abs(e.value) >= 100 ? e.value.toFixed(0) : String(Math.round(e.value * 100) / 100)) : String(e.value);
    setTile(t, text, e && /^EGS/.test(id) ? COLOR.trans : COLOR.other, false, !e);
  }
  if (T.drawer) updateCharts();
}

function updateCharts() {
  const r = T.refs;
  if (!r) return;
  for (const id of CHART_IDS) {
    const c = r.charts.get(id);
    if (!c) continue;
    const pts = T.hist.filter((x) => x.v[id] !== undefined);
    const now = Date.now();
    const lo = id === 'kml' ? 0 : METRIC[id].lo, hi = id === 'kml' ? 25 : METRIC[id].hi;
    c.line.setAttribute('points', pts.map((x) => `${(200 - ((now - x.t) / HISTORY_MS) * 200).toFixed(1)},${(58 - clamp01((x.v[id]! - lo) / (hi - lo)) * 56).toFixed(1)}`).join(' '));
    const vals = pts.map((x) => x.v[id]!);
    const last = vals[vals.length - 1];
    const color = id === 'kml' ? COLOR.fuel : COLOR[METRIC[id].cat];
    const bad = id !== 'kml' && isBad(id, last);
    c.box.style.setProperty('--c', bad ? COLOR.alarm : color);
    c.value.textContent = id === 'kml' ? (last === undefined ? '—' : last.toFixed(1)) : fmtMetric(id, last);
    c.min.textContent = vals.length ? (id === 'kml' ? Math.min(...vals).toFixed(1) : fmtMetric(id, Math.min(...vals))) : '—';
    c.max.textContent = vals.length ? (id === 'kml' ? Math.max(...vals).toFixed(1) : fmtMetric(id, Math.max(...vals))) : '—';
  }
}

// ------------------------------------------------------------------ building the screen
function tile(id: string, label: string, unit: string, color: string) {
  const value = h('span', { class: 'tm-tv' }, '—', unit ? h('small', {}, ` ${unit}`) : null);
  const box = h('div', { class: 'tm-tile dim', style: `--c:${color}` }, h('span', { class: 'tm-tl' }, label), value);
  T.refs!.tiles.set(id, { box, value });
  return box;
}

function chartCard(id: string) {
  const label = id === 'kml' ? 'FUEL NOW' : METRIC[id].label;
  const d = id === 'kml' ? undefined : METRIC[id];
  const value = h('span', { class: 'tm-cv' }, '—');
  const min = h('span', {}, '—'), max = h('span', {}, '—');
  const svg = sv('svg', { viewBox: '0 0 200 60', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (d && (d.okLo !== undefined || d.okHi !== undefined)) {
    const y = (x: number) => 58 - clamp01((x - d.lo) / (d.hi - d.lo)) * 56;
    const top = y(Math.min(d.hi, d.okHi ?? d.hi)), bot = y(Math.max(d.lo, d.okLo ?? d.lo));
    svg.append(sv('rect', { x: 0, y: top.toFixed(1), width: 200, height: (bot - top).toFixed(1), class: 'tm-cband' }));
  }
  const line = sv('polyline', { points: '', class: 'tm-cline' }) as SVGPolylineElement;
  svg.append(line);
  const box = h('div', { class: 'tm-chart', style: `--c:${id === 'kml' ? COLOR.fuel : COLOR[METRIC[id].cat]}` },
    h('div', { class: 'tm-ch' }, h('span', {}, label), value), svg, h('div', { class: 'tm-cf' }, h('span', {}, 'min ', min), h('span', {}, 'max ', max)));
  T.refs!.charts.set(id, { box, value, line, min, max });
  return box;
}

function picker(ctx: PageCtx, mod: Mod) {
  const used = T.snap?.used ?? new Set<string>();
  const vals = [...T.frame[mod].values()].filter((v) => !used.has(`${mod}|${v.key}`) && (typeof v.value === 'number' || !/_TEXT$/.test(v.key) || !T.frame[mod].has(v.key.replace(/_TEXT$/, '_WERT'))));
  const seen = new Set<string>();
  const list = vals.filter((v) => { const id = extraId(mod, v.key); if (seen.has(id)) return false; seen.add(id); return true; });
  const toggle = (id: string) => {
    T.extras = T.extras.includes(id) ? T.extras.filter((x) => x !== id) : [...T.extras, id];
    store.set(EXTRAS_KEY, T.extras);
    ctx.rerender();
  };
  return h('section', { class: 'tm-sheet', role: 'dialog', 'aria-label': 'More metrics' },
    h('div', { class: 'tm-sheet-head' },
      h('h2', {}, 'More metrics'),
      h('span', {}, `${T.extras.length} added · only what your car reports is listed`),
      h('div', { class: 'tm-sp' }),
      h('button', { class: 'tm-btn primary', onclick: () => { T.picker = ''; ctx.rerender(); } }, 'Done')),
    h('div', { class: 'tm-sheet-tabs' },
      (['DME', 'EGS'] as Mod[]).map((m) => h('button', { class: `tm-pill ${T.picker === m ? 'on' : ''}`, onclick: () => { T.picker = m; ctx.rerender(); } }, m === 'DME' ? 'Engine' : 'Transmission'))),
    list.length
      ? h('div', { class: 'tm-sheet-list' }, list.map((v) => {
          const id = extraId(mod, v.key);
          const on = T.extras.includes(id);
          return h('button', { class: `tm-pick ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => toggle(id) },
            h('span', { class: 'tm-check' }, on ? '✓' : ''),
            h('span', { class: 'tm-pick-l' }, h('b', {}, v.label), h('small', {}, v.key)),
            h('span', { class: 'tm-pick-v' }, typeof v.value === 'number' ? String(Math.round(v.value * 100) / 100) : String(v.value), v.unit && v.unit !== '-' ? ` ${v.unit}` : ''));
        }))
      : h('p', { class: 'tm-sheet-empty' }, T.frame[mod].size ? 'Every value of this module is already on the screen.' : mod === 'EGS' ? 'The gearbox did not answer (or this car has a manual gearbox).' : 'No engine values yet.'));
}

export function renderTelemetry(ctx: PageCtx): (Node | null)[] {
  T.refs = { tiles: new Map(), charts: new Map(), sel: {} } as unknown as Refs;
  const refs = T.refs;
  const tach = dial('tach'), spd = dial('speed');
  Object.assign(refs, { tachArc: tach.valArc, tachNeedle: tach.needle, tachText: tach.text, spdArc: spd.valArc, spdNeedle: spd.needle, spdText: spd.text });
  const ect = tempArc('ect'), oil = tempArc('oil');
  refs.arcs = { ect, oil };
  const sel = h('div', { class: 'tm-selrow', 'aria-label': 'Selector position' }, (['P', 'R', 'N', 'D', 'S'] as const).map((k) => (refs.sel[k] = h('span', { class: 'tm-sel' }, k))));
  refs.gear = h('div', { class: 'tm-gear' }, '—');
  refs.mode = h('span', {}, 'DRIVE');
  refs.kml = h('b', {}, '—');
  refs.kmlLabel = h('span', {}, 'KM/L');
  refs.avg = h('b', { class: 'small' }, '—');
  const lcd = h('div', { class: 'tm-center' }, sel,
    h('div', { class: 'tm-lcd' },
      h('div', { class: 'tm-lcd-row' }, h('span', {}, 'GEAR'), refs.mode),
      refs.gear,
      h('div', { class: 'tm-lcd-row line' }, refs.kmlLabel, refs.kml),
      h('div', { class: 'tm-lcd-row' }, h('span', {}, 'AVG'), refs.avg)));
  refs.status = h('span', { class: 'tm-status' }, 'STARTING…');
  refs.rec = h('button', { class: 'tm-btn rec', onclick: () => toggleRec(ctx) }, '● REC CSV');

  const tiles = h('div', { class: 'tm-tiles' },
    MAIN_TILES.map((id) => id === 'lock' ? tile('lock', 'CONVERTER', '', COLOR.trans) : tile(id, METRIC[id].label, METRIC[id].unit, COLOR[METRIC[id].cat])),
    T.extras.map((id) => tile(id, extraLabel(id), extraValue(id)?.unit && extraValue(id)!.unit !== '-' ? extraValue(id)!.unit : '', /^EGS/.test(id) ? COLOR.trans : COLOR.other)),
    h('button', { class: 'tm-add', onclick: () => { T.picker = 'DME'; ctx.rerender(); } }, '+ Add metric'));

  const stage = h('div', { class: 'tm-stage' },
    h('header', { class: 'tm-head' },
      h('button', { class: 'tm-btn ghost', onclick: () => { stopTelemetry(); ctx.goPage('overview'); }, 'aria-label': 'Back to the menu' }, '‹ Menu'),
      h('b', { class: 'tm-brand' }, 'E46FANATICS'), h('span', { class: 'tm-sub' }, 'TELEMETRY'),
      h('div', { class: 'tm-sp' }),
      refs.status,
      h('span', { class: 'tm-car' }, ctx.carTitle())),
    h('main', { class: 'tm-main' },
      h('div', { class: 'tm-row' }, tach.svg, h('div', { class: 'tm-mid' }, ect.cell, lcd, oil.cell), spd.svg),
      tiles),
    T.drawer ? h('section', { class: 'tm-drawer' },
      h('div', { class: 'tm-drawer-head' }, h('b', {}, 'CHARTS · LAST 60 s'), h('span', {}, 'shaded band = normal range'), h('div', { class: 'tm-sp' }),
        h('button', { class: 'tm-btn', onclick: () => { T.fuel.reset(); update(); } }, 'Reset average'),
        h('button', { class: 'tm-btn', onclick: () => { T.drawer = false; ctx.rerender(); } }, 'Close')),
      h('div', { class: 'tm-charts' }, CHART_IDS.map(chartCard))) : null,
    T.picker ? picker(ctx, T.picker) : null,
    T.toast ? h('div', { class: 'tm-toast', role: 'status' }, T.toast) : null,
    h('nav', { class: 'tm-nav' },
      h('button', { class: 'tm-tab on' }, 'TELEMETRY'),
      h('button', { class: 'tm-tab', onclick: () => { T.picker = 'DME'; ctx.rerender(); } }, 'ENGINE METRICS'),
      h('button', { class: 'tm-tab', onclick: () => { T.picker = 'EGS'; ctx.rerender(); } }, 'TRANSMISSION METRICS'),
      h('div', { class: 'tm-sp' }),
      h('button', { class: `tm-btn amber ${T.drawer ? 'on' : ''}`, onclick: () => { T.drawer = !T.drawer; ctx.rerender(); } }, 'Charts · 60 s'),
      refs.rec));
  const root = h('div', { class: 'tm-root' }, stage);
  fit(stage);
  setTimeout(() => { fit(stage); update(); }, 0);
  if (!T.running && ctx.session()) setTimeout(() => void run(ctx), 0);
  return [root];
}

/** The screen is drawn at 1280 × 720 and scaled to the display (head units are 1024 × 600, 1280 × 720, 1920 × 720…). */
function fit(stage: HTMLElement) {
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  stage.style.transform = `scale(${s})`;
}
window.addEventListener('resize', () => {
  const st = document.querySelector<HTMLElement>('.tm-stage');
  if (st) fit(st);
});
