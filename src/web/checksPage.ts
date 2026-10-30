// Guided checks screen: thermostat, gearbox fluid level, VANOS, oxygen sensors, misfires per cylinder.
// Each check reads the module's own value groups in a loop and explains what the values mean.

import type { Value } from '../core/api/DiagSession';
import {
  ATF_MAX, ATF_MIN, AtfSample, CHECKS, CYLINDERS, CheckDef, CheckId, LambdaSample, ThermoSample, VanosSample, Verdict,
  atfVerdict, camStats, lambdaVerdicts, misfireData, misfireVerdicts, pick, pickText, sensorStats, thermostatCheck, vanosVerdicts,
} from '../core/api/checks';
import type { PageCtx } from './ctx';
import { h } from './dom';
import { formatNumber } from './gauge';

type Sample = { t: number; values: Value[] };

const C = {
  owner: null as unknown,
  sel: '' as '' | CheckId,
  running: false,
  error: '',
  t0: 0,
  samples: [] as Sample[],
  once: [] as Value[],
  steps: new Map<CheckId, Set<number>>(),
  avail: new Map<CheckId, { ok: boolean; why: string; group?: string; variant?: string }>(),
  availFor: '',
  rate: 0,
  busy: '',
};

export function resetChecks() {
  C.running = false;
  Object.assign(C, { owner: null, sel: '', error: '', samples: [], once: [], avail: new Map(), availFor: '', busy: '' });
}
export const checksRunning = () => C.running;
export function stopChecks() {
  C.running = false;
}

// ---------------------------------------------------------------- availability

async function resolve(ctx: PageCtx) {
  const sig = ctx.found().map((m) => `${m.def.short}:${m.scan?.variant}`).join('|');
  if (C.availFor === sig) return;
  C.availFor = sig;
  for (const d of CHECKS) {
    const m = ctx.found().find((x) => x.def.short === d.module && x.scan?.variant);
    if (!m) { C.avail.set(d.id, { ok: false, why: `${d.module} did not answer the scan` }); continue; }
    if (m.dtcNA || m.scan!.variant!.startsWith('native:')) { C.avail.set(d.id, { ok: false, why: `Needs the ${d.module} module file (${d.written})` }); continue; }
    const jobs = await ctx.jobs(m.def.group).catch(() => []);
    const ok = d.jobs.every((j) => jobs.some((x) => x.name === j && x.safety === 'read'));
    C.avail.set(d.id, ok ? { ok, why: '', group: m.def.group, variant: m.scan!.variant! } : { ok, why: `Written for ${d.written}; this ${d.module} (${m.scan!.variant!.toUpperCase()}) reports other values` });
  }
  ctx.rerender();
}

// ---------------------------------------------------------------- reading loop

async function start(ctx: PageCtx, d: CheckDef) {
  const a = C.avail.get(d.id);
  const s = ctx.session();
  if (!a?.ok || !s || C.running) return;
  ctx.stopLive();
  C.running = true;
  C.error = '';
  C.samples = [];
  C.once = [];
  C.t0 = Date.now();
  ctx.rerender();
  const alive = () => C.running && C.sel === d.id && ctx.session() === s && !!document.querySelector('.ck-run');
  for (const j of d.once ?? []) {
    const jobs = await ctx.jobs(a.group!);
    if (!jobs.some((x) => x.name === j && x.safety === 'read')) continue;
    const r = await s.readValues(a.variant!, j);
    if (!r.error) C.once.push(...r.values);
  }
  let n = 0;
  let tr = Date.now();
  while (alive()) {
    if (!ctx.cableOk()) { await new Promise((r) => setTimeout(r, 500)); continue; }
    const values: Value[] = [];
    for (const j of d.jobs) {
      const r = await s.readValues(a.variant!, j);
      if (!alive()) break;
      if (r.error) {
        if (j === d.jobs[0]) C.error = `Reading stopped: ${r.error}`;
        continue;
      }
      values.push(...r.values);
    }
    if (C.error) break;
    if (!alive()) break;
    C.samples.push({ t: (Date.now() - C.t0) / 1000, values });
    if (C.samples.length > 3000) C.samples.splice(0, 500);
    n++;
    if (Date.now() - tr > 3000) { C.rate = (n * 1000) / (Date.now() - tr); n = 0; tr = Date.now(); }
    updateLive(ctx, d);
  }
  C.running = false;
  if (C.sel === d.id) ctx.rerender();
}

// ---------------------------------------------------------------- per-check samples

const lastVals = () => C.samples[C.samples.length - 1]?.values ?? [];
const RPM = /MOTORDREHZAHL(_MWB)?_WERT$/;
const CLT = /MOTORTEMP(_MWB)?_WERT$/;

const thermo = (): ThermoSample[] => C.samples.map((s) => ({ t: s.t, clt: pick(s.values, CLT), out: pick(s.values, /KUEHLW_AUSL_TEMP(_MWB)?_WERT$/), rpm: pick(s.values, RPM), speed: pick(s.values, /GESCHWINDIGKEIT(_MWB)?_WERT$/) }));
const atf = (): AtfSample[] => C.samples.map((s) => ({ t: s.t, temp: pick(s.values, /GETRIEBETEMPERATUR_WERT$/), rpm: pick(s.values, RPM) }));
const vanos = (): VanosSample[] => C.samples.map((s) => ({
  t: s.t, inIst: pick(s.values, /VANOS_NW_LAGE_EINLASS_IST_WERT$/), inSoll: pick(s.values, /VANOS_NW_LAGE_EINLASS_SOLL_WERT$/),
  outIst: pick(s.values, /VANOS_NW_LAGE_AUSLASS_IST_WERT$/), outSoll: pick(s.values, /VANOS_NW_LAGE_AUSLASS_SOLL_WERT$/), rpm: pick(s.values, RPM), clt: pick(s.values, CLT),
}));
const lambda = (): LambdaSample[] => C.samples.map((s) => ({
  t: s.t, v1: pick(s.values, /^STAT_L_SONDE_WERT$/), v2: pick(s.values, /^STAT_L_SONDE_2_WERT$/),
  int1: pick(s.values, /LAMBDA_INTEGRATOR_1(_MWB)?_WERT$/), int2: pick(s.values, /LAMBDA_INTEGRATOR_2(_MWB)?_WERT$/), rpm: pick(s.values, RPM), clt: pick(s.values, CLT),
}));

// ---------------------------------------------------------------- drawing

interface Series { pts: [number, number | undefined][]; cls: string; label: string }

/** Line chart with a fixed value scale and the last `window` seconds (all when 0). */
function lineChart(series: Series[], o: { min: number; max: number; unit: string; window?: number; w?: number; bands?: { from: number; to: number; cls: string }[]; ticks?: number[] }): SVGSVGElement {
  const W = o.w ?? 760, H = o.w ? Math.round(o.w * 0.5) : 220, L = 42, R = 10, T = 12, B = 26;
  const all = series.flatMap((s) => s.pts.map((p) => p[0]));
  const tEnd = Math.max(o.window ?? 0, all.length ? Math.max(...all) : 0, 1);
  const tStart = o.window ? Math.max(0, tEnd - o.window) : 0;
  const x = (t: number) => L + ((t - tStart) / (tEnd - tStart || 1)) * (W - L - R);
  const y = (v: number) => H - B - ((Math.max(o.min, Math.min(o.max, v)) - o.min) / (o.max - o.min)) * (H - B - T);
  const ticks = o.ticks ?? [o.min, (o.min + o.max) / 2, o.max];
  let g = (o.bands ?? []).map((b) => `<rect x="${L}" y="${y(b.to)}" width="${W - L - R}" height="${Math.max(0, y(b.from) - y(b.to))}" class="${b.cls}"/>`).join('');
  for (const v of ticks) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" class="ax y">${formatNumber(v)}</text>`;
  const span = tEnd - tStart;
  const step = span > 1200 ? 300 : span > 300 ? 60 : span > 60 ? 15 : 5;
  for (let t = Math.ceil(tStart / step) * step; t <= tEnd; t += step) g += `<text x="${x(t)}" y="${H - 8}" class="ax">${t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`}</text>`;
  const paths = series.map((s) => {
    const pts = s.pts.filter((p) => p[1] !== undefined && p[0] >= tStart);
    return pts.length > 1 ? `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]!).toFixed(1)}`).join(' ')}" class="ln ${s.cls}"/>` : '';
  }).join('');
  const t = h('template', {});
  t.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="ck-chart" role="img" aria-label="${series.map((s) => s.label).join(', ')} (${o.unit})">${g}<text x="${W - R}" y="${T - 2}" class="ax unit">${o.unit}</text>${paths}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

const legend = (items: [string, string][]) => h('div', { class: 'ck-legend' }, items.map(([cls, label]) => h('span', {}, h('i', { class: `lg ${cls}` }), label)));
const tile = (label: string, v: number | string | undefined, unit = '', cls = '') =>
  h('div', { class: `ck-tile ${cls}` }, h('span', {}, label), h('b', {}, v === undefined ? '—' : typeof v === 'number' ? formatNumber(v) : v, unit && v !== undefined ? h('small', {}, ` ${unit}`) : null));

function verdictList(vs: Verdict[]) {
  return h('div', { class: 'ck-verdicts' }, vs.map((v) => h('div', { class: `ck-verdict ${v.level}` }, h('b', {}, v.title), h('p', {}, v.text))));
}

/** Horizontal temperature scale with the check window, for the gearbox fluid. */
function windowBar(temp: number | undefined) {
  const max = 90;
  const pct = (v: number) => `${(Math.max(0, Math.min(max, v)) / max) * 100}%`;
  return h('div', { class: 'ck-window', role: 'img', 'aria-label': `Fluid temperature ${temp ?? 'unknown'} °C, check between ${ATF_MIN} and ${ATF_MAX} °C` },
    h('div', { class: 'ck-window-track' },
      h('span', { class: 'ck-window-ok', style: `left:${pct(ATF_MIN)};width:calc(${pct(ATF_MAX)} - ${pct(ATF_MIN)})` }),
      temp !== undefined ? h('span', { class: 'ck-window-mark', style: `left:${pct(temp)}` }) : null),
    h('div', { class: 'ck-window-scale' }, [0, ATF_MIN, ATF_MAX, max].map((v) => h('span', { style: `left:${pct(v)}` }, `${v}°`))));
}

function liveBody(ctx: PageCtx, d: CheckDef): (Node | null)[] {
  const v = lastVals();
  const rpm = pick(v, RPM);
  if (d.id === 'thermostat') {
    const s = thermo();
    const r = thermostatCheck(s);
    const last = s[s.length - 1];
    return [
      verdictList(r.verdicts),
      h('div', { class: 'ck-tiles' }, tile('Coolant', last?.clt, '°C', 'amber'), tile('Radiator outlet', last?.out, '°C'), tile('Engine', rpm, 'rpm'), tile('Running', r.running ? `${Math.floor(r.running / 60)}:${String(Math.round(r.running % 60)).padStart(2, '0')}` : undefined)),
      lineChart([{ pts: s.map((x) => [x.t, x.clt]), cls: 'a', label: 'Coolant' }, { pts: s.map((x) => [x.t, x.out]), cls: 'b', label: 'Radiator outlet' }], { min: 0, max: 130, unit: '°C', bands: [{ from: 88, to: 110, cls: 'band-ok' }, { from: 115, to: 130, cls: 'band-bad' }], ticks: [0, 40, 80, 110, 130] }),
      legend([['a', 'Coolant (engine)'], ['b', 'Radiator outlet'], ['band', 'Normal when warm']]),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => ctx.goPage('coding') }, 'Coolant gauge curve (Coding)')),
    ];
  }
  if (d.id === 'atf') {
    const s = atf();
    const last = s[s.length - 1];
    return [
      verdictList([atfVerdict(s)]),
      windowBar(last?.temp),
      h('div', { class: 'ck-tiles' }, tile('Fluid temperature', last?.temp, '°C', 'amber'), tile('Engine', rpm, 'rpm'), tile('Gear', pickText(v, /GANG_TEXT$/)?.replace(/\s+/g, ' ').trim())),
      lineChart([{ pts: s.map((x) => [x.t, x.temp]), cls: 'a', label: 'Fluid temperature' }], { min: 0, max: 90, unit: '°C', bands: [{ from: ATF_MIN, to: ATF_MAX, cls: 'band-ok' }], ticks: [0, ATF_MIN, ATF_MAX, 90] }),
    ];
  }
  if (d.id === 'vanos') {
    const s = vanos();
    const last = s[s.length - 1];
    const cam = (name: string, ist: 'inIst' | 'outIst', soll: 'inSoll' | 'outSoll', min: number, max: number) => {
      const st = camStats(s, ist, soll);
      return h('div', { class: 'ck-cam' },
        h('div', { class: 'ck-cam-head' }, h('b', {}, name), h('span', {}, st.n ? `avg. difference ${st.meanDev.toFixed(1)}°` : '')),
        h('div', { class: 'ck-tiles' }, tile('Target', last?.[soll], '°CRK'), tile('Actual', last?.[ist], '°CRK', 'amber'), tile('Difference', last?.[ist] !== undefined && last?.[soll] !== undefined ? Math.abs(last[ist]! - last[soll]!) : undefined, '°')),
        lineChart([{ pts: s.map((x) => [x.t, x[soll]]), cls: 'b', label: 'Target' }, { pts: s.map((x) => [x.t, x[ist]]), cls: 'a', label: 'Actual' }], { min, max, unit: '°CRK', window: 60, w: 380 }));
    };
    const ins = s.map((x) => x.inSoll).filter((n): n is number => n !== undefined);
    const outs = s.map((x) => x.outSoll).filter((n): n is number => n !== undefined);
    const range = (xs: number[], dmin: number, dmax: number): [number, number] => (xs.length ? [Math.floor(Math.min(dmin, ...xs) / 10) * 10, Math.ceil(Math.max(dmax, ...xs) / 10) * 10] : [dmin, dmax]);
    return [
      verdictList(vanosVerdicts(s)),
      h('div', { class: 'ck-tiles' }, tile('Engine', rpm, 'rpm'), tile('Coolant', last?.clt, '°C')),
      h('div', { class: 'ck-cams' }, cam('Intake camshaft', 'inIst', 'inSoll', ...range(ins, 70, 130)), cam('Exhaust camshaft', 'outIst', 'outSoll', ...range(outs, -130, -70))),
      legend([['b', 'Target (what the DME asks)'], ['a', 'Actual']]),
    ];
  }
  if (d.id === 'lambda') {
    const s = lambda();
    const b1 = sensorStats(s, 'v1', 'int1');
    const b2 = sensorStats(s, 'v2', 'int2');
    const ad = (re: RegExp) => pick(C.once, re);
    return [
      verdictList(lambdaVerdicts(s)),
      h('div', { class: 'ck-tiles' },
        tile('Bank 1 now', s[s.length - 1]?.v1, 'V', 'amber'), tile('Bank 1 swings / 10 s', b1.n ? +b1.per10s.toFixed(1) : undefined),
        tile('Bank 2 now', s[s.length - 1]?.v2, 'V', 'amber'), tile('Bank 2 swings / 10 s', b2.n ? +b2.per10s.toFixed(1) : undefined)),
      lineChart([{ pts: s.map((x) => [x.t, x.v1]), cls: 'a', label: 'Bank 1' }, { pts: s.map((x) => [x.t, x.v2]), cls: 'b', label: 'Bank 2' }], { min: 0, max: 1, unit: 'V', window: 30, bands: [{ from: 0.35, to: 0.55, cls: 'band-mid' }], ticks: [0, 0.45, 1] }),
      legend([['a', 'Bank 1 (cyl. 1–3)'], ['b', 'Bank 2 (cyl. 4–6)'], ['band-mid', 'Switching point']]),
      C.once.length
        ? h('div', { class: 'ck-adapt' }, h('b', {}, 'Learned mixture corrections'),
            h('span', {}, `Bank 1: additive ${fmt(ad(/LAMBDA_ADD_1_WERT$/))}, multiplicative ${fmt(ad(/LAMBDA_MUL_1_WERT$/))} %`),
            h('span', {}, `Bank 2: additive ${fmt(ad(/LAMBDA_ADD_2_WERT$/))}, multiplicative ${fmt(ad(/LAMBDA_MUL_2_WERT$/))} %`),
            h('small', {}, 'Additive corrects at idle (air leaks show here), multiplicative across the load range (fuel pressure, air-mass meter). Values far from zero on both banks point to a shared cause.'))
        : null,
    ];
  }
  // misfire
  const md = misfireData(v);
  const vs = misfireVerdicts(md, (rpm ?? 0) > 400);
  const maxR = Math.max(0.5, ...md.rough.map((x) => x ?? 0));
  const sorted = md.rough.map((x) => x ?? 0).sort((a, b) => a - b);
  const median = (sorted[2] + sorted[3]) / 2;
  return [
    verdictList(vs),
    h('div', { class: 'ck-cyls', role: 'img', 'aria-label': 'Rough running per cylinder' },
      CYLINDERS.map((c, i) => {
        const r = md.rough[i] ?? 0;
        const n = md.count[i];
        const hot = r > median * 2 && r > median + 0.15;
        return h('div', { class: `ck-cyl ${hot || (n ?? 0) > 0 ? 'hot' : ''}` },
          h('div', { class: 'ck-cyl-bar' }, h('span', { style: `height:${(r / maxR) * 100}%` })),
          h('b', {}, `Cyl ${c}`), h('small', {}, formatNumber(r)), h('small', { class: 'cnt' }, n !== undefined && n >= 0 && n < 30000 ? `${n} misfires` : '—'));
      })),
    h('p', { class: 'note' }, 'Bars: rough-running value of each cylinder (lower is smoother). Below: misfires the DME counted. Bank 1 is cylinders 1–3, bank 2 is 4–6.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: !!C.busy || (rpm ?? 0) < 400, onclick: () => startDmeCheck(ctx) }, C.busy === 'misfire' ? 'Starting…' : 'Start DME misfire check'),
      h('span', { class: 'note' }, ctx.isService() ? 'Restarts the DME’s own rough-running count.' : 'Needs “Unlock tests & resets”.')),
  ];
}

const fmt = (n: number | undefined) => (n === undefined ? '—' : formatNumber(n));

async function startDmeCheck(ctx: PageCtx) {
  const a = C.avail.get('misfire');
  const s = ctx.session();
  if (!a?.ok || !s) return;
  if (!ctx.isService()) {
    await ctx.unlockService();
    if (!ctx.isService()) return;
  }
  C.busy = 'misfire';
  const r = await s.run(a.variant!, 'START_SYSTEMCHECK_LAUFUNRUHE');
  C.busy = '';
  ctx.log(r.error ? 'tx' : 'info', `DME misfire check: ${r.error?.text ?? 'started'}`);
  if (r.error) C.error = r.error.text;
}

function updateLive(ctx: PageCtx, d: CheckDef) {
  const el = document.querySelector('#ck-live');
  if (!el) return;
  el.replaceChildren(...liveBody(ctx, d).filter((x): x is Node => !!x));
  const st = document.querySelector('#ck-status');
  if (st) st.textContent = C.running ? `Reading · ${C.rate ? `${C.rate.toFixed(1)} reads/s · ` : ''}${C.samples.length} samples` : C.samples.length ? `Stopped · ${C.samples.length} samples` : 'Not started';
}

// ---------------------------------------------------------------- screen

export function renderChecks(ctx: PageCtx): (Node | null)[] {
  const s = ctx.session();
  if (C.owner !== s) { resetChecks(); C.owner = s; }
  void resolve(ctx);
  const head = (title: string, kicker: string, tools: Node | null = null) => h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, kicker), h('h1', {}, title)), tools);
  const d = CHECKS.find((x) => x.id === C.sel);
  if (!d) {
    const groups: [string, CheckDef[]][] = [['Engine (DME)', CHECKS.filter((x) => x.module === 'DME')], ['Automatic gearbox (EGS)', CHECKS.filter((x) => x.module === 'EGS')]];
    return [
      head('Guided checks', 'Workshop'),
      h('p', { class: 'lede-sm' }, 'Step-by-step checks that follow the live values and tell you what they mean. They only read; nothing in the car is changed.'),
      ...groups.map(([name, list]) => h('section', { class: 'panel-sec' },
        h('div', { class: 'sec-head' }, h('h2', {}, name)),
        h('div', { class: 'ck-grid' }, list.map((c) => {
          const a = C.avail.get(c.id);
          return h('button', { class: `ck-card ${a && !a.ok ? 'off' : ''}`, onclick: () => { C.sel = c.id; C.samples = []; C.error = ''; ctx.rerender(); } },
            h('div', { class: 'ck-card-head' }, h('b', {}, c.title), h('span', { class: `chip-mini ${!a ? '' : a.ok ? 'ok' : 'warn'}` }, !a ? '…' : a.ok ? 'Ready' : 'Not available')),
            h('span', {}, c.summary),
            a && !a.ok ? h('small', { class: 'muted' }, a.why) : null);
        })))),
      ctx.mode() === 'remote' ? h('p', { class: 'refnote' }, 'Remote car: each reading crosses the internet, so the checks update more slowly than at the car.') : null,
    ];
  }
  const a = C.avail.get(d.id);
  const done = C.steps.get(d.id) ?? C.steps.set(d.id, new Set()).get(d.id)!;
  const tools = h('div', { class: 'toolbar mh-tools' },
    h('span', { class: 'lv-status', id: 'ck-status' }, C.running ? 'Reading…' : C.samples.length ? `Stopped · ${C.samples.length} samples` : 'Not started'),
    C.running
      ? h('button', { class: 'btn', onclick: () => { C.running = false; ctx.rerender(); } }, 'Stop')
      : h('button', { class: 'btn primary', disabled: !a?.ok || ctx.busy() || ctx.scanning() || !ctx.cableOk(), onclick: () => void start(ctx, d) }, C.samples.length ? 'Start again' : 'Start'));
  const body = h('div', { class: 'ck-live', id: 'ck-live' }, ...liveBody(ctx, d).filter((x): x is Node => !!x));
  return [
    h('div', { class: 'toolbar' }, h('button', { class: 'btn ghost', onclick: () => { C.running = false; C.sel = ''; ctx.rerender(); } }, '← All checks')),
    head(d.title, `Guided check · ${d.module}`, tools),
    a && !a.ok ? h('div', { class: 'msg warn' }, a.why) : null,
    C.error ? h('div', { class: 'msg err' }, C.error) : null,
    h('div', { class: 'ck-run' },
      h('aside', { class: 'ck-steps' },
        h('p', {}, d.summary),
        h('h3', {}, 'Steps'),
        h('ol', {}, d.steps.map((t, i) => h('li', {}, h('label', {}, h('input', { type: 'checkbox', checked: done.has(i), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) done.add(i); else done.delete(i); } }), h('span', {}, t))))),
        h('p', { class: 'refnote' }, `Written for ${d.written}. Thresholds come from general E46 workshop experience: confirm with a measurement before replacing parts.`)),
      body),
  ];
}
