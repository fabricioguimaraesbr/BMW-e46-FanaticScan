// Data Logger: values from several modules side by side (engine and gearbox together, for example), charted live,
// with presets, up to 20 minutes of history and CSV export. Only read-only value groups are offered.

import type { Value } from '../core/api/DiagSession';
import { baseKey, KEY_METRICS } from '../core/api/reference';
import type { PageCtx } from './ctx';
import { drawChart } from './chart';
import { download, h, promptDialog, stamp, store } from './dom';
import { formatNumber } from './gauge';

interface CatalogEntry {
  job: string;
  key: string;
  label: string;
  unit: string;
}
interface ModCatalog {
  loading?: { done: number; total: number };
  entries: CatalogEntry[];
  error?: string;
}
interface Preset {
  name: string;
  items: { module: string; base: string }[];
}
interface Sample {
  t: number;
  vals: Map<string, number | string>;
}

const HISTORY_MS = 20 * 60 * 1000;
const COLORS = ['#ffa033', '#4290f6', '#41d38a', '#e9ecef', '#e22619', '#b48cff', '#3fd0d4', '#f5d547'];
const PRESET_KEY = 'e46diag.loggerPresets';

const BUILT_IN: Preset[] = [
  { name: 'Engine and gearbox temperatures', items: [
    ...['MOTORTEMP', 'MOTORTEMPERATUR', 'TMOT', 'OEL_TEMP', 'KUEHLW_AUSL_TEMP', 'TKA', 'AN_LUFTTEMP', 'TANS'].map((base) => ({ module: 'DME', base })),
    { module: 'EGS', base: 'GETRIEBETEMPERATUR' },
  ] },
  { name: 'Shifting: engine speed, gear and turbine', items: [
    ...['MOTORDREHZAHL', 'NMOT', 'GESCHWINDIGKEIT', 'VFZG'].map((base) => ({ module: 'DME', base })),
    ...['GANG', 'STEGDREHZAHL', 'ABTRIEBSDREHZAHL'].map((base) => ({ module: 'EGS', base })),
  ] },
  { name: 'Mixture: air mass, injection and fuel trims', items: ['MOTORDREHZAHL', 'NMOT', 'LMM_MASSE', 'MSHFM', 'EINSPRITZZEIT', 'TE', 'LAMBDA_INTEGRATOR_1', 'LAMBDA_INTEGRATOR_2', 'FR', 'FR2', 'OBD_06', 'OBD_07'].map((base) => ({ module: 'DME', base })) },
];

const L = {
  catalog: new Map<string, ModCatalog>(),
  sel: [] as string[], // `${group}|${job}|${key}`
  running: false,
  samples: [] as Sample[],
  rate: 0,
  error: '',
  presetName: '',
};

const selKey = (group: string, e: CatalogEntry) => `${group}|${e.job}|${e.key}`;
const parse = (k: string) => {
  const [group, job, key] = k.split('|');
  return { group, job, key };
};

/** Forget everything when the car changes (disconnect). */
export function resetLogger() {
  L.running = false;
  L.catalog.clear();
  L.sel = [];
  L.samples = [];
  L.error = '';
}
export const loggerRunning = () => L.running;
export function stopLogger() {
  L.running = false;
}

function entry(k: string): (CatalogEntry & { group: string }) | undefined {
  const { group, job, key } = parse(k);
  const e = L.catalog.get(group)?.entries.find((x) => x.job === job && x.key === key);
  return e ? { ...e, group } : undefined;
}

/** Reads every supported value group of a module once to list its values. */
async function listValues(ctx: PageCtx, group: string) {
  const m = ctx.found().find((x) => x.def.group === group);
  const s = ctx.session();
  if (!m?.scan?.variant || !s) return;
  await ctx.jobs(group).catch(() => []);
  const jobs = ctx.liveJobs(group);
  const cat: ModCatalog = { loading: { done: 0, total: jobs.length }, entries: [] };
  L.catalog.set(group, cat);
  ctx.rerender();
  const seen = new Set<string>();
  for (let i = 0; i < jobs.length; i++) {
    if (!ctx.cableOk()) break;
    const r = await s.readValues(m.scan.variant, jobs[i]);
    cat.loading = { done: i + 1, total: jobs.length };
    if (!r.error)
      for (const v of r.values) {
        if (typeof v.value !== 'number' && jobs.length > 1 && /TEXT$/.test(v.key)) continue;
        const id = baseKey(v.key);
        if (seen.has(id)) continue;
        seen.add(id);
        cat.entries.push({ job: jobs[i], key: v.key, label: v.label, unit: v.unit });
      }
    updateLoading(group, cat);
  }
  cat.loading = undefined;
  if (!cat.entries.length) cat.error = jobs.length ? 'No values answered.' : 'This module has no live values.';
  ctx.rerender();
}
function updateLoading(group: string, c: ModCatalog) {
  const el = document.querySelector(`[data-lg="${group}"]`);
  if (el && c.loading) el.textContent = `Reading value groups… ${c.loading.done}/${c.loading.total}`;
}

async function applyPreset(ctx: PageCtx, p: Preset) {
  for (const short of [...new Set(p.items.map((i) => i.module))]) {
    const m = ctx.found().find((x) => x.def.short === short);
    if (m && !L.catalog.get(m.def.group)?.entries.length) await listValues(ctx, m.def.group);
  }
  const picked: string[] = [];
  for (const it of p.items) {
    const m = ctx.found().find((x) => x.def.short === it.module);
    const e = m && L.catalog.get(m.def.group)?.entries.find((x) => baseKey(x.key) === it.base);
    if (!m || !e || picked.includes(selKey(m.def.group, e))) continue;
    // the same quantity from another value group (MS43 data block and single job): keep the first one
    if (picked.some((k) => parse(k).group === m.def.group && entry(k)?.label === e.label)) continue;
    picked.push(selKey(m.def.group, e));
  }
  L.sel = picked.slice(0, 16);
  L.presetName = p.name;
  L.samples = [];
  ctx.rerender();
}

function builtIns(ctx: PageCtx): Preset[] {
  const dme = ctx.found().find((m) => m.def.short === 'DME');
  const key = (dme?.scan?.variant ?? '').toLowerCase();
  const vitals: Preset = { name: 'Engine vitals', items: (KEY_METRICS[key] ?? KEY_METRICS['native:12']).slice(0, 8).map((base) => ({ module: 'DME', base })) };
  return [vitals, ...BUILT_IN];
}
const userPresets = () => store.get<Preset[]>(PRESET_KEY, []);

async function savePreset(ctx: PageCtx) {
  if (!L.sel.length) return;
  const name = await promptDialog('Save preset', 'The selected values, to pick again with one click.', L.presetName || 'My values', 'Save');
  if (!name) return;
  const items = L.sel.map((k) => {
    const { group, key } = parse(k);
    return { module: ctx.found().find((m) => m.def.group === group)?.def.short ?? group, base: baseKey(key) };
  });
  const list = userPresets().filter((p) => p.name !== name);
  list.push({ name, items });
  store.set(PRESET_KEY, list);
  L.presetName = name;
  ctx.rerender();
}

async function start(ctx: PageCtx) {
  const s = ctx.session();
  if (!s || L.running || !L.sel.length) return;
  ctx.stopLive();
  L.running = true;
  L.error = '';
  ctx.rerender();
  const reads = [...new Set(L.sel.map((k) => `${parse(k).group}|${parse(k).job}`))].map((x) => {
    const [group, job] = x.split('|');
    return { group, job, variant: ctx.found().find((m) => m.def.group === group)?.scan?.variant ?? '' };
  });
  let n = 0;
  let t0 = Date.now();
  let built = 0;
  while (L.running && ctx.session() === s) {
    if (!ctx.cableOk()) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const vals = new Map<string, number | string>();
    for (const r of reads) {
      const res = await s.readValues(r.variant, r.job);
      if (!L.running) break;
      if (res.error) continue;
      const byKey = new Map<string, Value>(res.values.map((v) => [v.key, v]));
      for (const k of L.sel) {
        const p = parse(k);
        if (p.group === r.group && p.job === r.job && byKey.has(p.key)) vals.set(k, byKey.get(p.key)!.value);
      }
    }
    if (!L.running) break;
    const now = Date.now();
    L.samples.push({ t: now, vals });
    while (L.samples.length && now - L.samples[0].t > HISTORY_MS) L.samples.shift();
    n++;
    if (now - t0 > 2000) {
      L.rate = (n * 1000) / (now - t0);
      n = 0;
      t0 = now;
    }
    if (!built || !document.querySelector('.lg-table')) {
      built = 1;
      ctx.rerender();
    } else update();
  }
  L.running = false;
  ctx.rerender();
}

function exportCsv() {
  const keys = L.sel;
  const head = ['time', ...keys.map((k) => {
    const e = entry(k);
    return e ? `${e.label}${e.unit && e.unit !== '-' ? ` (${e.unit})` : ''}` : k;
  })];
  const rows = [head, ...L.samples.map((s) => [new Date(s.t).toISOString(), ...keys.map((k) => String(s.vals.get(k) ?? ''))])];
  const csv = rows.map((r) => r.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  download(`e46-log-${stamp()}.csv`, csv, 'text/csv');
}

const fmt = (v: number | string | undefined) => (v === undefined ? '—' : typeof v === 'number' ? formatNumber(v) : v);

function series(k: string) {
  return L.samples.map((s) => s.vals.get(k)).filter((v): v is number => typeof v === 'number');
}

function update() {
  const last = L.samples[L.samples.length - 1];
  document.querySelectorAll<HTMLElement>('[data-lk]').forEach((el) => {
    const k = el.dataset.lk!;
    const data = series(k);
    const cur = last?.vals.get(k);
    el.querySelector('.lg-cur')!.textContent = fmt(cur);
    el.querySelector('.lg-min')!.textContent = data.length ? formatNumber(Math.min(...data)) : '—';
    el.querySelector('.lg-max')!.textContent = data.length ? formatNumber(Math.max(...data)) : '—';
  });
  const c = document.querySelector<HTMLCanvasElement>('.lg-chart canvas');
  if (c) drawChart(c, L.sel.filter((k) => typeof last?.vals.get(k) === 'number' || series(k).length).slice(0, COLORS.length).map((k, i) => ({ data: series(k).slice(-300), color: COLORS[i] })));
  const st = document.querySelector('#lg-status');
  if (st) st.textContent = statusText();
}
const statusText = () => {
  const mins = L.samples.length ? (L.samples[L.samples.length - 1].t - L.samples[0].t) / 60000 : 0;
  return `${L.running ? 'Logging' : 'Stopped'} · ${L.sel.length} values${L.running && L.rate ? ` · ${L.rate.toFixed(1)} reads/s` : ''} · ${L.samples.length} rows (${mins.toFixed(1)} min of 20)`;
};

export function renderLogger(ctx: PageCtx): (Node | null)[] {
  const mods = ctx.found().filter((m) => !m.dtcNA);
  const presets = [...builtIns(ctx), ...userPresets()];
  const toolbar = h('div', { class: 'toolbar' },
    L.running
      ? h('button', { class: 'btn', onclick: () => { L.running = false; } }, 'Stop')
      : h('button', { class: 'btn primary', disabled: !L.sel.length || !ctx.cableOk() || ctx.busy(), onclick: () => start(ctx) }, L.samples.length ? 'Continue' : 'Start logging'),
    h('button', { class: 'btn', disabled: !L.samples.length, onclick: exportCsv }, 'Save CSV'),
    h('button', { class: 'btn', disabled: !L.samples.length || L.running, onclick: () => { L.samples = []; ctx.rerender(); } }, 'Clear'),
    h('select', { 'aria-label': 'Presets', disabled: L.running, onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; const p = presets.find((x) => x.name === v); if (p) void applyPreset(ctx, p); } },
      h('option', { value: '' }, 'Presets…'), presets.map((p) => h('option', { value: p.name, selected: p.name === L.presetName }, p.name))),
    h('button', { class: 'btn', disabled: !L.sel.length || L.running, onclick: () => savePreset(ctx) }, 'Save preset'),
    userPresets().some((p) => p.name === L.presetName) ? h('button', { class: 'btn ghost', disabled: L.running, onclick: () => { store.set(PRESET_KEY, userPresets().filter((p) => p.name !== L.presetName)); L.presetName = ''; ctx.rerender(); } }, 'Delete preset') : null,
    h('span', { class: 'note', id: 'lg-status' }, statusText()));
  const picker = h('div', { class: 'lg-mods' }, mods.map((m) => {
    const cat = L.catalog.get(m.def.group);
    return h('section', { class: 'lg-mod' },
      h('div', { class: 'lg-mod-head' }, h('b', {}, m.def.short), h('span', {}, m.def.name),
        !cat ? h('button', { class: 'btn', disabled: L.running || !ctx.cableOk() || ctx.busy(), onclick: () => listValues(ctx, m.def.group) }, 'List values') : null),
      cat?.loading ? h('div', { class: 'msg info', 'data-lg': m.def.group }, `Reading value groups… ${cat.loading.done}/${cat.loading.total}`) : null,
      cat?.error ? h('p', { class: 'availnote' }, cat.error) : null,
      cat?.entries.length ? h('div', { class: 'lg-values' }, cat.entries.map((e) => {
        const k = selKey(m.def.group, e);
        const on = L.sel.includes(k);
        return h('label', { class: `lg-val ${on ? 'on' : ''}`, title: e.key },
          h('input', { type: 'checkbox', checked: on, disabled: L.running || (!on && L.sel.length >= 16), onchange: () => { L.sel = on ? L.sel.filter((x) => x !== k) : [...L.sel, k]; L.presetName = ''; L.samples = []; ctx.rerender(); } }),
          h('span', {}, e.label), e.unit && e.unit !== '-' ? h('small', {}, e.unit) : null);
      })) : null);
  }));
  const last = L.samples[L.samples.length - 1];
  const numeric = L.sel.filter((k) => typeof last?.vals.get(k) === 'number' || series(k).length).slice(0, COLORS.length);
  const table = L.sel.length
    ? h('table', { class: 'res lg-table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Value'), h('th', {}, 'Module'), h('th', {}, 'Now'), h('th', {}, 'Min'), h('th', {}, 'Max'))),
        h('tbody', {}, L.sel.map((k) => {
          const e = entry(k);
          const ci = numeric.indexOf(k);
          const mod = ctx.found().find((m) => m.def.group === parse(k).group)?.def.short ?? '';
          return h('tr', { 'data-lk': k },
            h('td', {}, ci >= 0 ? h('i', { class: 'lg-dot', style: `background:${COLORS[ci]}` }) : null),
            h('td', {}, e?.label ?? parse(k).key), h('td', {}, mod),
            h('td', { class: 'num' }, h('b', { class: 'lg-cur' }, '—'), h('small', {}, e?.unit && e.unit !== '-' ? ` ${e.unit}` : '')),
            h('td', { class: 'num lg-min' }, '—'), h('td', { class: 'num lg-max' }, '—'));
        })))
    : h('div', { class: 'empty slim' }, h('strong', {}, 'Pick values to log'), 'List the values of one or more modules on the left, or choose a preset.');
  setTimeout(update, 0);
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Several modules at once'), h('h1', {}, 'Data logger'))),
    toolbar,
    L.error ? h('div', { class: 'msg err' }, L.error) : null,
    !mods.length ? h('div', { class: 'empty' }, h('strong', {}, 'No module with live values'), 'Scan the car first. Modules identified without their file have no values to log.') : null,
    h('div', { class: 'lg-layout' }, picker,
      h('div', { class: 'lg-right' },
        numeric.length ? h('div', { class: 'chart lg-chart' }, h('canvas', {})) : null,
        table,
        h('p', { class: 'refnote' }, 'Each line in the chart has its own scale. The K-line is shared, so more values and more modules mean fewer reads per second.'))),
  ];
}
