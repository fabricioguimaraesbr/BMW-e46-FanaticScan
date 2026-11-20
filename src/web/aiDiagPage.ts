// AI Diagnosis screen ("On the road"): reads the values that point at faults (engine every cycle, gearbox
// ~4×/s, slower DME groups and the ABS wheel speeds in turn), records the last 60 minutes by itself (also in
// IndexedDB), runs an optional guided test drive, raises simple live alerts and exports what an AI needs:
// a .zip (ANALYZE.md, car.json, faults.csv, events.csv, summary.csv, session.csv) or one .md file.
// Read-only: value groups and fault memory reads only. Logic in src/core/api/aidiag.ts and aiexport.ts.

import { Alerts, Channel, COND_TEXT, FAULT_MODS, FaultWhen, GuidedTest, ModJobs, Recorder, STEPS, Scheduler, WINDOW_MS, compareFaults, planChannels, type AiMod } from '../core/api/aidiag';
import { ExportInfo, aiReportMd, exportZip } from '../core/api/aiexport';
import { fmtMetric, isBad, METRIC } from '../core/api/telemetry';
import { clearRecording, loadRecording, saveRecording } from './aiStore';
import type { PageCtx } from './ctx';
import { confirmDialog, download, h, stamp, store } from './dom';
import { isNativeApp } from './nativeApp';

const A = {
  rec: new Recorder(),
  test: new GuidedTest(),
  alerts: new Alerts(),
  running: false,
  /** the user pressed Pause: do not start again by itself */
  paused: false,
  loop: null as Promise<void> | null,
  owner: null as unknown,
  status: '' as '' | 'live' | 'retry' | 'nocar' | 'faults',
  msg: '',
  toast: '',
  restored: false,
  restoring: null as Promise<void> | null,
  /** jobs the loop runs between two cycles (fault reads while recording) */
  queue: [] as (() => Promise<void>)[],
  reads: [] as { t: number; mod: AiMod }[],
  lastPaint: 0,
  lastSave: 0,
  allFaults: store.get<boolean>('e46diag.aiAllFaults', false),
  plan: [] as Channel[],
};

export function stopAiDiag() {
  A.running = false;
  A.test.stop();
}
export function resetAiDiag() {
  stopAiDiag();
  A.owner = null;
  A.status = '';
  A.plan = [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (ctx: PageCtx, s: unknown) => A.running && ctx.session() === s && !!document.getElementById('ai-body');

function event(type: Parameters<Recorder['event']>[1], text: string) {
  A.rec.event(Date.now(), type, text);
}

// ------------------------------------------------------------------ fault memory
async function readFaults(ctx: PageCtx, when: FaultWhen) {
  const s = ctx.session();
  if (!s) return;
  const mods = ctx.found().filter((m) => m.scan?.variant && (A.allFaults || FAULT_MODS.includes(m.def.short)));
  const prev = A.status;
  A.status = 'faults';
  let n = 0, read = 0, total = 0;
  for (const m of mods) {
    A.msg = `Reading faults: ${m.def.short} (${++n}/${mods.length})…`;
    paint(ctx, true);
    const r = await s.readDtcs(m.scan!.variant!).catch((e: unknown) => ({ dtcs: [], error: String((e as Error)?.message ?? e), notSupported: false }));
    if (r.notSupported) continue;
    A.rec.faults.push({ t: Date.now(), when, mod: m.def.short, name: m.def.name, variant: m.scan!.variant!, dtcs: r.dtcs, error: r.error });
    if (!r.error) read++;
    total += r.dtcs.length;
  }
  event('faults', `fault memory read (${when}): ${read} module(s), ${total} fault(s)`);
  A.msg = '';
  A.status = prev === 'faults' ? 'live' : prev;
}

/** Runs a job now, or between two reading cycles when the recording is running. */
function onLine(ctx: PageCtx, job: () => Promise<void>): Promise<void> {
  if (!A.running || !A.loop) return job().finally(() => paint(ctx, true));
  return new Promise((resolve) => A.queue.push(() => job().finally(resolve)));
}

// ------------------------------------------------------------------ reading loop
async function run(ctx: PageCtx) {
  const s = ctx.session();
  if (!s || A.running) return;
  if (A.loop) await A.loop;
  if (A.restoring) await A.restoring;
  if (A.running) return;
  const mods: ModJobs[] = [];
  for (const short of ['DME', 'EGS', 'ABS'] as AiMod[]) {
    const m = ctx.found().find((x) => x.def.short === short && x.scan?.variant && !x.dtcNA);
    if (!m?.scan?.variant) continue;
    await ctx.jobs(m.def.group).catch(() => []);
    mods.push({ mod: short, variant: m.scan.variant, jobs: ctx.liveJobs(m.def.group) });
  }
  const plan = planChannels(mods);
  if (!plan.some((c) => c.mod === 'DME')) {
    A.status = 'nocar';
    ctx.rerender();
    return;
  }
  // a recording kept from another car (other engine module) is not mixed with this one
  const dmeVar = plan.find((c) => c.mod === 'DME')!.variant;
  if (A.rec.channels.length && !A.rec.channels.some((c) => c.mod === 'DME' && c.variant === dmeVar)) {
    A.rec.clear();
    A.restored = false;
    A.alerts = new Alerts();
    await clearRecording();
  }
  ctx.stopLive();
  A.running = true;
  A.status = 'live';
  A.plan = plan;
  const idx = plan.map((c) => A.rec.channelIndex(c.mod, c.variant, c.job));
  event('start', `recording started: ${plan.map((c) => `${c.mod} ${c.job}${c.periodMs ? ` every ${c.periodMs} ms` : ' every cycle'}`).join('; ')}`);
  A.loop = loop(ctx, s, plan, idx);
  await A.loop;
  A.loop = null;
  A.running = false;
  void saveRecording(A.rec);
}

async function loop(ctx: PageCtx, s: NonNullable<ReturnType<PageCtx['session']>>, plan: Channel[], idx: number[]) {
  if (!A.rec.faults.some((f) => f.when === 'start')) await readFaults(ctx, 'start');
  const sched = new Scheduler(plan);
  let misses = 0;
  while (alive(ctx, s)) {
    while (A.queue.length && alive(ctx, s)) await A.queue.shift()!();
    if (!ctx.cableOk()) {
      A.status = 'retry';
      paint(ctx);
      await sleep(400);
      continue;
    }
    let baseOk = false;
    for (const i of sched.next(Date.now())) {
      const c = plan[i];
      const r = await s.readValues(c.variant, c.job);
      if (!alive(ctx, s)) break;
      const now = Date.now();
      sched.done(i, now);
      if (r.error) {
        if (i === 0) baseOk = false;
        continue;
      }
      if (i === 0) baseOk = true;
      const base = i === 0;
      A.rec.add(now, idx[i], r.values, base, A.test.phase);
      A.reads.push({ t: now, mod: c.mod });
      if (base && A.rec.snap && A.rec.cond) {
        for (const text of A.test.update(now, A.rec.snap.v)) event('phase', text);
        for (const a of A.alerts.update(now, A.rec.snap.v, A.rec.cond)) event('alert', a.text);
      }
    }
    if (!alive(ctx, s)) break;
    if (!baseOk) {
      misses++;
      A.status = 'retry';
      if (misses === 8) event('comm', 'engine module not answering (8 reads in a row)');
      paint(ctx);
      await sleep(Math.min(250 * misses, 1500));
      continue;
    }
    if (misses >= 8) event('comm', 'engine module answering again');
    misses = 0;
    A.status = 'live';
    const now = Date.now();
    while (A.reads.length && now - A.reads[0].t > 3000) A.reads.shift();
    if (now - A.lastSave > 10_000) {
      A.lastSave = now;
      A.rec.prune(now);
      void saveRecording(A.rec, now);
    }
    paint(ctx);
    await sleep(15);
  }
  while (A.queue.length) await A.queue.shift()!();
}

// ------------------------------------------------------------------ export
function exportInfo(ctx: PageCtx): ExportInfo {
  const mode = ctx.mode();
  return {
    app: `v${__APP_VERSION__}`,
    car: ctx.carId(),
    modules: ctx.found().filter((m) => m.scan?.variant).map((m) => ({ short: m.def.short, name: m.def.name, variant: m.scan!.variant!, ident: m.scan!.ident })),
    connection: mode === 'sim' ? 'simulator (test data, not a real car)' : mode === 'remote' ? 'remote session over the internet' : ctx.session()?.kind === 'native' ? 'cable in plug & play mode (OBD-II engine data, no module files)' : 'K+DCAN cable with the BMW module files',
    now: Date.now(),
  };
}

async function doExport(ctx: PageCtx, kind: 'zip' | 'md') {
  if (!A.rec.rows.length) return;
  const recent = A.rec.faults.some((f) => f.when === 'end' && Date.now() - f.t < 60_000);
  if (ctx.session() && !recent) {
    const ok = !A.running || (await confirmDialog('Read the faults again?', 'Before exporting, the app reads the fault memory once more, so the AI can see faults that appeared during the recording. Reading stops for a few seconds.', 'Read and export', false));
    if (ok) await onLine(ctx, () => readFaults(ctx, 'end'));
  }
  const info = exportInfo(ctx);
  const name = `e46-ai-diagnosis-${stamp()}`;
  if (kind === 'zip') download(`${name}.zip`, new Blob([await exportZip(A.rec, info) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  else download(`${name}.md`, aiReportMd(A.rec, info), 'text/markdown');
  event('note', `exported ${kind === 'zip' ? 'zip' : 'single file'}`);
  A.toast = `Saved ${name}.${kind} · ${isNativeApp() ? 'Documents/E46Fanatics' : 'your downloads'}`;
  paint(ctx, true);
  setTimeout(() => { A.toast = ''; paint(ctx, true); }, 6000);
}

async function doClear(ctx: PageCtx) {
  if (!(await confirmDialog('Clear the recording?', 'Deletes the recorded values, the timeline and the fault reads kept on this device. The car is not touched.', 'Clear'))) return;
  A.test.stop();
  A.rec.clear();
  A.alerts = new Alerts();
  A.test = new GuidedTest();
  await clearRecording();
  if (A.running) {
    // the channel numbers belong to the old recording: restart the reading
    A.running = false;
    await A.loop;
    setTimeout(() => void run(ctx), 0);
  }
  paint(ctx, true);
}

// ------------------------------------------------------------------ drawing
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const TILES = ['rpm', 'ect', 'rad', 'iat', 'stft1', 'stft2', 'maf', 'vin', 'vex', 'ubatt', 'atf', 'slip'];

function tiles() {
  const v = A.rec.snap?.v ?? {};
  const wheels = A.rec.wheels().map((w) => w.value as number);
  const spread = wheels.length >= 2 ? Math.max(...wheels) - Math.min(...wheels) : undefined;
  return h('div', { class: 'ai-tiles' },
    TILES.filter((id) => v[id] !== undefined || ['rpm', 'ect', 'stft1', 'maf', 'ubatt'].includes(id)).map((id) =>
      h('div', { class: `ai-tile ${isBad(id, v[id]) ? 'warn' : ''}` }, h('span', {}, METRIC[id].label), h('b', {}, fmtMetric(id, v[id]), h('small', {}, ` ${METRIC[id].unit}`)))),
    wheels.length >= 2 ? h('div', { class: `ai-tile ${(spread ?? 0) > 3 && (v.speed ?? 0) > 20 ? 'warn' : ''}` }, h('span', {}, 'WHEEL SPEED SPREAD'), h('b', {}, spread!.toFixed(1), h('small', {}, ' km/h'))) : null);
}

function recCard() {
  const r = A.rec;
  const rate = (m: AiMod) => A.reads.filter((x) => x.mod === m).length / 3;
  const mods = [...new Set(A.plan.map((c) => c.mod))];
  return h('section', { class: 'ai-card ai-rec' },
    h('div', { class: 'ai-rec-top' },
      h('span', { class: `ai-lamp ${A.running && A.status === 'live' ? 'on' : ''}` }, A.running ? '● REC' : '○ REC'),
      h('div', {}, h('b', {}, `${mmss(r.spanMs)} `, h('small', {}, `of ${WINDOW_MS / 60000}:00 kept`)), h('small', {}, `${r.rows.length.toLocaleString('en')} reads · ${r.events.length} events${A.restored ? ' · restored from this device' : ''}`))),
    h('div', { class: 'ai-rates' }, mods.length ? mods.map((m) => h('span', {}, h('b', {}, m), ` ${rate(m).toFixed(1)}/s`)) : h('span', {}, 'Starts by itself when the car answers.')),
    r.cond ? h('div', { class: 'ai-cond' }, h('span', { class: 'eco-badge info' }, r.cond.replace('_', ' ').toUpperCase()), h('small', {}, COND_TEXT[r.cond])) : null,
    tiles());
}

function testCard(ctx: PageCtx) {
  const g = A.test;
  const cur = g.cur >= 0 ? STEPS[g.cur] : null;
  return h('section', { class: 'ai-card' },
    h('div', { class: 'eco-card-head' }, h('div', {}, h('b', {}, 'GUIDED TEST'), h('small', {}, 'Optional: tells the AI what the car was doing in each part of the recording'))),
    h('ol', { class: 'ai-steps' }, STEPS.map((s, i) =>
      h('li', { class: `ai-step ${g.state[i]}` },
        h('span', { class: 'ai-step-n' }, g.state[i] === 'done' ? '✓' : g.state[i] === 'skipped' ? '–' : String(i + 1)),
        h('div', {}, h('b', {}, s.title, s.driving ? h('small', { class: 'ai-drive' }, ' · driving') : null),
          g.state[i] === 'active' ? h('p', {}, s.how) : null,
          g.state[i] === 'active' ? h('div', { class: 'ai-prog' }, h('i', { style: `width: ${(g.progress(i) * 100).toFixed(0)}%` })) : null),
        h('span', { class: 'ai-step-t' }, s.needS > 5 ? `${Math.round(g.held[i])}/${s.needS} s` : '')))),
    cur?.driving ? h('p', { class: 'msg warn ai-safe' }, 'Driving steps: only where it is safe and legal, eyes on the road. Best with a passenger handling the app; the step finishes by itself.') : null,
    h('div', { class: 'toolbar' },
      g.running
        ? [h('button', { class: 'btn', onclick: () => { for (const t of g.finish()) event('phase', t); paint(ctx, true); } }, 'Step done'),
           h('button', { class: 'btn ghost', onclick: () => { for (const t of g.skip()) event('phase', t); paint(ctx, true); } }, 'Skip step'),
           h('button', { class: 'btn ghost', onclick: () => { for (const t of g.stop()) event('phase', t); paint(ctx, true); } }, 'Stop test')]
        : h('button', { class: 'btn primary', disabled: !A.running, onclick: () => { for (const t of g.start()) event('phase', t); paint(ctx, true); } }, g.state.some((x) => x !== 'todo') ? 'Start again' : 'Start guided test')));
}

function alertsCard() {
  const act = [...A.alerts.active.values()];
  const ev = A.rec.events.filter((e) => e.type !== 'start').slice(-8).reverse();
  return h('section', { class: 'ai-card' },
    h('div', { class: 'eco-card-head' }, h('div', {}, h('b', {}, 'LIVE ALERTS'), h('small', {}, 'Simple rules while recording; the AI looks at much more'))),
    act.length ? h('div', { class: 'ai-alerts' }, act.map((a) => h('div', { class: 'msg warn' }, a))) : h('p', { class: 'ai-fine' }, A.running ? 'Nothing out of range right now.' : '—'),
    ev.length ? h('ul', { class: 'ai-events' }, ev.map((e) => h('li', {}, h('time', {}, new Date(e.t).toLocaleTimeString()), ` ${e.text}`))) : null);
}

function faultsCard(ctx: PageCtx) {
  const lines = compareFaults(A.rec.faults);
  const byMod = new Map<string, { start?: number; end?: number; err?: string }>();
  for (const f of A.rec.faults) {
    const m = byMod.get(f.mod) ?? {};
    if (f.error) m.err = f.error;
    else m[f.when] = f.dtcs.length;
    byMod.set(f.mod, m);
  }
  return h('section', { class: 'ai-card' },
    h('div', { class: 'eco-card-head' }, h('div', {}, h('b', {}, 'FAULT MEMORY'), h('small', {}, 'Read when the recording starts and again when you export'))),
    byMod.size
      ? h('div', { class: 'ai-faults' }, [...byMod].map(([mod, m]) => h('div', {}, h('b', {}, mod), h('span', {}, m.err ? 'not read' : `start ${m.start ?? '—'} · end ${m.end ?? '—'}`))))
      : h('p', { class: 'ai-fine' }, 'Not read yet.'),
    lines.filter((l) => l.status === 'new').length ? h('div', { class: 'msg warn' }, `${lines.filter((l) => l.status === 'new').length} fault(s) appeared during the recording.`) : null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', disabled: !ctx.session() || A.status === 'faults', onclick: () => void onLine(ctx, () => readFaults(ctx, A.rec.faults.some((f) => f.when === 'start') ? 'end' : 'start')) }, 'Read faults now'),
      h('label', { class: 'ai-check' }, h('input', { type: 'checkbox', checked: A.allFaults, onchange: (e: Event) => { A.allFaults = (e.target as HTMLInputElement).checked; store.set('e46diag.aiAllFaults', A.allFaults); } }),
        ' All modules (slower)')));
}

function howCard() {
  return h('section', { class: 'ai-card ai-how' },
    h('div', { class: 'eco-card-head' }, h('div', {}, h('b', {}, 'ANALYSE WITH AN AI'), h('small', {}, 'Claude, ChatGPT, Gemini… with your own account'))),
    h('ol', {},
      h('li', {}, h('b', {}, 'One file for AI (.md)'), ': instructions, car, faults, timeline and statistics in one file. Attach it (or paste it) and ask "Analyse my car".'),
      h('li', {}, h('b', {}, 'Export .zip'), ': the same plus the raw recording (session.csv). If the AI does not take .zip files, unzip and attach all files.'),
      h('li', {}, 'The AI answers in the language you write in. It is guidance from recorded data, not a workshop diagnosis.')));
}

function body(ctx: PageCtx): Node[] {
  return [h('div', { class: 'ai-col' }, recCard(), alertsCard()), h('div', { class: 'ai-col' }, testCard(ctx), faultsCard(ctx), howCard())];
}

function statusText() {
  if (A.status === 'faults') return A.msg || 'Reading faults…';
  return A.status === 'live' ? 'Recording' : A.status === 'retry' ? 'Waiting for the car…' : A.status === 'nocar' ? 'No engine module' : 'Starting…';
}

function paint(ctx: PageCtx, force = false) {
  const now = Date.now();
  if (!force && now - A.lastPaint < 350) return;
  A.lastPaint = now;
  const el = document.getElementById('ai-body');
  if (!el) return;
  el.replaceChildren(...body(ctx));
  const st = document.getElementById('ai-status');
  if (st) st.textContent = ctx.session() ? statusText() : 'Not connected';
  const t = document.getElementById('ai-toast');
  if (t) t.textContent = A.toast;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.ai-export')) b.disabled = !A.rec.rows.length || A.status === 'faults';
}

export function renderAiDiag(ctx: PageCtx): (Node | null)[] {
  const s = ctx.session();
  if (A.owner !== s) {
    A.owner = s;
    A.status = '';
    A.paused = false;
  }
  if (!A.rec.rows.length && !A.restored && !A.restoring)
    A.restoring = loadRecording().then((r) => {
      if (r && !A.rec.rows.length) {
        A.rec = r;
        A.restored = true;
      }
      A.restoring = null;
      paint(ctx, true);
    });
  const head = h('div', { class: 'mh' },
    h('div', {}, h('p', { class: 'kicker' }, 'On the road'), h('h1', {}, 'AI Diagnosis')),
    h('div', { class: 'toolbar mh-tools' },
      h('span', { class: 'lv-status', id: 'ai-status' }, s ? statusText() : 'Not connected'),
      A.running ? h('button', { class: 'btn', onclick: () => { A.paused = true; A.running = false; ctx.rerender(); } }, 'Pause') : h('button', { class: 'btn primary', disabled: !s, onclick: () => { A.paused = false; void run(ctx); setTimeout(() => ctx.rerender(), 50); } }, 'Record'),
      h('button', { class: 'btn ai-export', disabled: !A.rec.rows.length, onclick: () => void doExport(ctx, 'md') }, 'One file for AI (.md)'),
      h('button', { class: 'btn ai-export', disabled: !A.rec.rows.length, onclick: () => void doExport(ctx, 'zip') }, 'Export .zip'),
      h('button', { class: 'btn ghost', disabled: !A.rec.rows.length && !A.rec.faults.length, onclick: () => void doClear(ctx) }, 'Clear')));
  const notes: (Node | null)[] = [];
  if (!s) notes.push(h('div', { class: 'msg info' }, A.rec.rows.length ? 'Not connected: you can still export the recording kept on this device.' : 'Connect the K+DCAN cable (or use the simulator). Recording starts by itself and keeps the last 60 minutes.'));
  else if (A.status === 'nocar') notes.push(h('div', { class: 'msg warn' }, 'The engine module did not answer, so there is nothing to record yet. Check the ignition and press Rescan on a module page.'));
  else if (s.kind === 'native') notes.push(h('div', { class: 'msg info' }, 'Plug & play mode: only the OBD-II engine data is recorded. With the module files the gearbox, ABS and the DME groups (VANOS, adaptations, O2 sensors) are recorded too.'));
  notes.push(h('p', { class: 'ai-fine' }, 'This screen has the cable to itself: Live Data and Telemetry pause while it records. Read-only.'));
  const root = h('div', { class: 'ai-body', id: 'ai-body' }, ...body(ctx));
  const toast = h('div', { class: 'ai-toast', id: 'ai-toast', 'aria-live': 'polite' }, A.toast);
  if (s && !A.running && !A.paused && A.status !== 'nocar') setTimeout(() => void run(ctx), 0);
  return [head, ...notes, root, toast];
}
