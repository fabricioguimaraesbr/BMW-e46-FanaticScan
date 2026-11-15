// ECO screen ("On the road"): fuel used right now and why, the overrun fuel cut against engine speed, where the
// trip time went, a fuel health check with references for the connected car and a guided test of the fuel cut.
// Approved layout: panel 27 content inside the new side menu (panel 28), 15/11/2026. Read-only: it only reads
// the DME's main value group (the same one Telemetry reads).

import type { Value } from '../core/api/DiagSession';
import { baseKey } from '../core/api/reference';
import { CheckStatus, EcoTracker, coach, ecoProfile, fmtMin } from '../core/api/eco';
import { Frame, snapshot } from '../core/api/telemetry';
import type { PageCtx } from './ctx';
import { h } from './dom';

const E = {
  running: false,
  owner: null as unknown,
  frame: new Map<string, Value>(),
  eco: new EcoTracker(ecoProfile(null)),
  status: '' as '' | 'live' | 'retry' | 'nocar',
  family: '',
};

export function stopEco() {
  E.running = false;
}
export function resetEco() {
  stopEco();
  E.frame = new Map();
  E.owner = null;
  E.family = '';
  E.eco = new EcoTracker(ecoProfile(null));
  E.status = '';
}

const PEDAL_BASES = /^(PWG_WINKEL|PWG|PEDALWERT|WPED|OBD_49)$/;

async function run(ctx: PageCtx) {
  const s = ctx.session();
  if (!s || E.running) return;
  const dme = ctx.found().find((x) => x.def.short === 'DME' && x.scan?.variant && !x.dtcNA);
  if (!dme?.scan?.variant) {
    E.status = 'nocar';
    return;
  }
  ctx.stopLive();
  E.running = true;
  E.status = 'live';
  await ctx.jobs(dme.def.group).catch(() => []);
  const job = ctx.liveJobs(dme.def.group)[0];
  if (!job) {
    E.running = false;
    E.status = 'nocar';
    ctx.rerender();
    return;
  }
  let misses = 0;
  const alive = () => E.running && ctx.session() === s && !!document.getElementById('eco-body');
  while (alive()) {
    if (!ctx.cableOk()) {
      E.status = 'retry';
      paint(ctx);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const r = await s.readValues(dme.scan.variant, job);
    if (!alive()) break;
    if (r.error) {
      misses++;
      E.status = 'retry';
      paint(ctx);
      await new Promise((res) => setTimeout(res, Math.min(250 * misses, 1500)));
      continue;
    }
    misses = 0;
    E.status = 'live';
    for (const v of r.values) E.frame.set(v.key, v);
    const vals = [...E.frame.values()];
    const frame: Frame = { DME: vals, EGS: [] };
    const sn = snapshot(frame).v;
    const fs = vals.find((v) => baseKey(v.key) === 'OBD_03');
    E.eco.update({
      t: Date.now(), rpm: sn.rpm, speed: sn.speed, pedal: sn.pedal, ti: sn.ti, ect: sn.ect, maf: sn.maf, stft1: sn.stft1, stft2: sn.stft2, ubatt: sn.ubatt,
      fuelStatus: fs && typeof fs.value === 'string' ? fs.value : undefined,
      pedalIsThrottle: !vals.some((v) => PEDAL_BASES.test(baseKey(v.key))) && vals.some((v) => baseKey(v.key) === 'OBD_11'),
    });
    paint(ctx);
    // the data block is fast; give the K-line a short breath on slow adapters
    await new Promise((res) => setTimeout(res, 20));
  }
  E.running = false;
}

// ------------------------------------------------------------------ drawing
const BADGE: Record<CheckStatus, string> = { OK: 'ok', WATCH: 'watch', CHECK: 'bad', INFO: 'info', '—': 'wait' };
const f1 = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const RPM_LO = 600, RPM_HI = 3000;
const pos = (r: number) => `${Math.max(0, Math.min(100, ((r - RPM_LO) / (RPM_HI - RPM_LO)) * 100)).toFixed(1)}%`;

function tile(label: string, value: string, unit: string, cls: string, note: string, warn = false) {
  return h('div', { class: `eco-tile ${cls} ${warn ? 'warn' : ''}` },
    h('span', { class: 'eco-tile-l' }, label),
    h('b', {}, value, h('small', {}, unit ? ` ${unit}` : '')),
    h('span', { class: 'eco-tile-n' }, note));
}

function refName(ctx: PageCtx) {
  const c = ctx.carId();
  return [c.model ? `E46 ${c.model}` : 'this E46', c.engine, c.family === 'unknown' ? '' : c.family, c.gearbox === 'unknown' ? '' : c.gearbox].filter(Boolean).join(' · ');
}

function body(ctx: PageCtx): Node[] {
  const e = E.eco, p = e.profile, s = e.last;
  const stopped = !s || (s.speed ?? 0) < 3;
  const big = e.cut ? 'CUT' : stopped ? f1(e.lph) : f1(e.kml);
  const bigUnit = e.cut ? '' : stopped ? 'L/H' : 'KM/L';
  const c = coach(e);
  const sp = e.split();
  const checks = e.checks();
  const travel = e.pedalTravel(s?.pedal);
  const rest = e.pedalRest;
  const T = e.test;
  const lcd = h('div', { class: 'eco-lcd' },
    h('div', { class: 'eco-lcd-row' }, h('span', {}, 'FUEL NOW'), h('span', {}, e.state === 'cut' || e.state === 'coast' ? 'COASTING' : e.state === 'idle' ? 'STOPPED' : e.state === 'drive' ? 'DRIVING' : '—')),
    h('div', { class: 'eco-big' }, big, h('small', {}, bigUnit)),
    h('div', { class: 'eco-lamp-row' }, h('span', { class: `eco-lamp ${e.cut ? 'on' : ''}` }, e.cut ? '● FUEL CUT' : '○ INJECTING')),
    h('div', { class: 'eco-lcd-row line' }, h('span', {}, 'L/H'), h('b', {}, f1(e.lph, 2))));
  const trip = h('div', { class: 'eco-trip' },
    [['TRIP AVG', f1(e.average), 'km/l'], ['FUEL USED', f1(e.fuelL, 2), 'L'], ['IDLE TIME', e.time.total > 1 ? String(Math.round(sp.idle)) : '—', '%']].map(([l, v, u]) =>
      h('div', { class: 'eco-mini' }, h('span', {}, l), h('b', {}, v, h('small', {}, ` ${u}`)))));
  const coachBox = h('div', { class: `eco-coach ${c.tone}` }, h('span', { class: 'eco-coach-k' }, 'ECO COACH'), h('b', {}, c.title), h('p', {}, c.text));

  const rpm = s?.rpm ?? 0;
  const bar = h('div', { class: 'eco-card' },
    h('div', { class: 'eco-card-head' }, h('span', {}, 'ENGINE SPEED vs FUEL CUT'), h('b', { class: 'eco-rpm' }, String(Math.round(rpm / 10) * 10), h('small', {}, ' rpm'))),
    h('div', { class: 'eco-bar' },
      h('div', { class: 'eco-bar-track' }),
      h('div', { class: 'eco-bar-zone', style: `left: ${pos(p.cutRpm)}` }),
      h('div', { class: `eco-bar-fill ${e.cut ? 'cut' : ''}`, style: `width: ${pos(rpm)}` }),
      h('div', { class: 'eco-bar-mark resume', style: `left: ${pos(p.resumeRpm)}` }),
      h('div', { class: 'eco-bar-mark cut', style: `left: ${pos(p.cutRpm)}` })),
    h('div', { class: 'eco-bar-scale' },
      h('span', { class: 'resume', style: `left: ${pos(p.resumeRpm)}` }, `resume ${p.resumeRpm}`),
      h('span', { class: 'cut', style: `left: ${pos(p.cutRpm)}` }, `cut ${p.cutRpm}`),
      h('span', { style: 'right: 0; left: auto; transform: none' }, String(RPM_HI))),
    h('p', { class: 'eco-fine' }, `Fuel is cut only with the pedal released, a warm engine and the engine above the cut line. Lines: ${p.source}. Fuel cut from ${e.cutSource === 'injection' ? 'the DME injection time' : e.cutSource === 'obd' ? 'the OBD-II fuel status' : 'pedal and engine speed (estimated)'}.`));
  const tiles = h('div', { class: 'eco-tiles' },
    tile(s?.pedalIsThrottle ? 'THROTTLE (OBD)' : 'PEDAL (DME)', f1(travel, 0), '%', 'pedal', rest !== undefined && rest > 1 ? `rest ${rest.toFixed(0)} % counted as 0` : 'must be 0 % to cut fuel'),
    tile('INJECTION', f1(s?.ti, 1), 'ms', 'fuel', s?.ti === undefined ? 'not on this connection' : '0.0 = fuel cut'),
    tile('COOLANT', f1(s?.ect, 0), '°C', 'cool', p.targetC ? `map target ${p.targetC} °C` : `warm from ${p.warmC} °C`, checks.find((k) => k.id === 'ect')?.status === 'WATCH'),
    tile('AIR MASS', f1(s?.maf, 1), 'g/s', 'air', `idle ref ${p.idleMaf[0]}–${p.idleMaf[1]}`, stopped && s?.maf !== undefined && s.maf > p.idleMaf[1]),
    tile('STFT B1', s?.stft1 === undefined ? '—' : `${s.stft1 >= 0 ? '+' : ''}${s.stft1.toFixed(1)}`, '%', 'trim', 'ok ±10 %', Math.abs(s?.stft1 ?? 0) > 10),
    tile('STFT B2', s?.stft2 === undefined ? '—' : `${s.stft2 >= 0 ? '+' : ''}${s.stft2.toFixed(1)}`, '%', 'trim', 'ok ±10 %', Math.abs(s?.stft2 ?? 0) > 10));
  const segs: [string, number, string][] = [['Driving (pedal on)', sp.drive, 'drive'], ['Coasting · fuel cut', sp.cut, 'cut'], ['Coasting · fuel on', sp.coast, 'coast'], ['Idle (stopped)', sp.idle, 'idle']];
  const split = h('div', { class: 'eco-card grow' },
    h('div', { class: 'eco-card-head' }, h('span', {}, 'THIS TRIP · WHERE THE TIME WENT'), h('small', {}, fmtMin(e.time.total))),
    h('div', { class: 'eco-split' }, segs.map(([, v, k]) => h('div', { class: `seg ${k}`, style: `width: ${v.toFixed(1)}%` }))),
    h('div', { class: 'eco-legend' }, segs.map(([l, v, k]) => h('div', {}, h('i', { class: k }), h('span', {}, l), h('b', {}, `${Math.round(v)}%`)))),
    h('div', { class: 'eco-missed' }, h('span', {}, 'Lift-offs below the cut line'), h('b', {}, `${e.missed} of ${e.liftOffs}`)));
  const health = h('section', { class: 'eco-health' },
    h('div', { class: 'eco-card-head' }, h('div', {}, h('b', {}, 'HEALTH CHECK'), h('small', {}, `References for ${refName(ctx)}`))),
    h('div', { class: 'eco-checks' }, checks.map((k) =>
      h(k.id === 'more' ? 'button' : 'div', { class: `eco-check ${k.id === 'more' ? 'link' : ''}`, title: k.why ?? '', onclick: k.id === 'more' ? () => ctx.goPage('checks') : undefined },
        h('span', { class: `eco-badge ${BADGE[k.status]}` }, k.status),
        h('div', { class: 'eco-check-t' }, h('b', {}, k.label), h('small', {}, k.why ?? k.ref)),
        h('span', { class: 'eco-check-v' }, k.id === 'more' ? 'Open ›' : k.value)))),
    h('div', { class: 'eco-test' },
      h('div', {}, h('b', {}, 'Guided test · overrun fuel cut'), h('small', {}, T.state === 'off' ? 'Confirms the DME cuts fuel when you lift off above the cut line.' : T.text)),
      h('button', { class: `btn ${T.state === 'pass' ? 'ok' : T.state === 'off' || T.state === 'fail' ? '' : 'ghost'}`, disabled: !E.running, onclick: () => { E.eco.startTest(); paint(ctx); } },
        T.state === 'off' ? 'Start' : T.state === 'pass' || T.state === 'fail' ? 'Again' : 'Waiting…')));
  return [h('div', { class: 'eco-col' }, lcd, trip, coachBox), h('div', { class: 'eco-col' }, bar, tiles, split), health];
}

function paint(ctx: PageCtx) {
  const el = document.getElementById('eco-body');
  if (!el) return;
  el.replaceChildren(...body(ctx));
  const st = document.getElementById('eco-status');
  if (st) st.textContent = E.status === 'live' ? 'Live' : E.status === 'retry' ? 'Waiting for the car…' : E.status === 'nocar' ? 'No engine module' : 'Starting…';
}

export function renderEco(ctx: PageCtx): (Node | null)[] {
  const s = ctx.session();
  const car = ctx.carId();
  if (E.owner !== s) {
    resetEco();
    E.owner = s;
  }
  if (E.family !== car.family) {
    E.family = car.family === 'unknown' ? '' : car.family;
    E.eco.profile = ecoProfile(car);
  }
  const head = h('div', { class: 'mh' },
    h('div', {}, h('p', { class: 'kicker' }, 'On the road'), h('h1', {}, 'ECO')),
    h('div', { class: 'toolbar mh-tools' },
      h('span', { class: 'lv-status', id: 'eco-status' }, E.running ? 'Live' : s ? 'Starting…' : 'Not connected'),
      E.running ? h('button', { class: 'btn', onclick: () => { stopEco(); ctx.rerender(); } }, 'Stop') : h('button', { class: 'btn primary', disabled: !s, onclick: () => { void run(ctx); setTimeout(() => ctx.rerender(), 50); } }, 'Start'),
      h('button', { class: 'btn ghost', onclick: () => { E.eco.reset(); paint(ctx); } }, 'Reset trip')));
  const notes: (Node | null)[] = [];
  if (!s) notes.push(h('div', { class: 'msg info' }, 'Connect the cable or the adapter (or use the simulator) to see fuel use live.'));
  else if (E.status === 'nocar') notes.push(h('div', { class: 'msg warn' }, 'The engine module did not answer, so there is nothing to read yet. Check the ignition and press Rescan on a module page.'));
  if (car.family === 'DDE') notes.push(h('div', { class: 'msg info' }, 'Diesel engine: the fuel figures here are worked out from the air mass and do not apply to a diesel. The checks still show the values.'));
  else if (car.info?.support === 'obd') notes.push(h('div', { class: 'msg info' }, `${car.family}: read over OBD-II, so the fuel cut comes from the OBD-II fuel status and the references are typical values.`));
  const root = h('div', { class: 'eco-body', id: 'eco-body' }, ...body(ctx));
  if (s && !E.running && E.status !== 'nocar') setTimeout(() => void run(ctx).then(() => undefined), 0);
  return [head, ...notes, root];
}
