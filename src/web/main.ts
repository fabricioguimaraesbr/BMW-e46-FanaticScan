import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import '@fontsource/jetbrains-mono/400.css';
import { Availability, BLOCKED_CODE, DiagSession, Dtc, Session, JobListEntry, ScanEntry, Value, isLiveGroup, jobStatus } from '../core/api/DiagSession';
import { HybridSession } from '../core/api/HybridSession';
import { EQUIPMENT_LABEL, EquipmentKey, isHiddenByEquipment } from '../core/api/equipment';
import { SAFETY_LABEL } from '../core/api/safety';
import { E46_MODULES, ModuleDef } from '../core/api/modules';
import { EngineContext, KEY_METRICS, RefState, baseKey, engineContext, evaluate } from '../core/api/reference';
import type { JobResponse } from '../core/ediabas/Ediabas';
import { createE46 } from '../core/sim/e46';
import { NativeSession } from '../core/native/NativeSession';
import { SimChannel } from '../core/sim/SimChannel';
import type { ByteChannel } from '../core/transport/ByteChannel';
import { ObdInterface } from '../core/transport/ObdInterface';
import { toHex } from '../core/util/numbers';
import { BrowserFileProvider } from './BrowserFileProvider';
import { drawChart } from './chart';
import { Gauge, formatNumber } from './gauge';
import logoSvg from './assets/e46fanatics.svg?raw';
import { WebSerialChannel, watchCable, webSerialAvailable } from './WebSerialChannel';

// ------------------------------------------------------------------ tiny DOM helper
type Child = Node | string | number | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Child | Child[] | Child[][])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(2) as Child[]) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const nodes = (xs: (Node | null | false | undefined)[]) => xs.filter((x): x is Node => !!x);

// ------------------------------------------------------------------ state
/** Sections of the side menu. Module pages (faults, live, functions) show the module tabs on top. */
type Page = 'overview' | 'faults' | 'live' | 'functions' | 'report' | 'log';
const MODULE_PAGES: Page[] = ['faults', 'live', 'functions'];
interface ModState {
  scan?: ScanEntry;
  dtcs?: Dtc[];
  dtcError?: string;
  dtcMsg?: { kind: 'ok' | 'err'; text: string };
  jobs?: JobListEntry[];
  avail?: Availability;
  availProgress?: { done: number; total: number };
  availError?: string;
  /** plug-and-play mode: this module can only be identified (no fault memory without module files) */
  dtcNA?: string;
}

const files = new BrowserFileProvider();
const S = {
  session: null as Session | null,
  channel: null as ByteChannel | null,
  mode: null as 'cable' | 'sim' | null,
  busy: '' as string,
  scanning: false,
  selected: null as string | null, // module group, null = vehicle overview
  page: 'overview' as Page,
  mods: new Map<string, ModState>(),
  log: [] as { cls: string; text: string }[],
  connError: '',
  live: { running: false, job: '', values: [] as Value[], extra: [] as string[], hist: new Map<string, number[]>(), rate: 0, rec: null as string[][] | null, recKeys: [] as string[] },
  jobSel: '',
  jobFilter: '',
  jobResult: null as JobResponse | null,
};
const modState = (g: string) => S.mods.get(g) ?? S.mods.set(g, {}).get(g)!;
const moduleDef = (g: string) => E46_MODULES.find((m) => m.group === g)!;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const dtcCode = (d: Dtc) => d.label ?? hex2(d.code);
const app = document.getElementById('app')!;
let gauges: Gauge[] = [];

function log(cls: string, text: string) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  S.log.push({ cls, text: `${time}  ${text}` });
  if (S.log.length > 1500) S.log.splice(0, 500);
  const el = document.querySelector('.log');
  if (el) {
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.append(h('div', { class: cls }, S.log[S.log.length - 1].text));
    if (atEnd) el.scrollTop = el.scrollHeight;
  }
}

// ------------------------------------------------------------------ connection & status
type CablePill = 'none' | 'detected' | 'connected' | 'unplugged' | 'reconnecting' | 'sim';
const link = { lastAnswer: 0, lastNoAnswer: 0, scanStart: 0 };
let preCable = { present: false, name: '' };

function cableState(): CablePill {
  if (!S.session) return preCable.present ? 'detected' : 'none';
  const st = (S.channel as unknown as { state?: string }).state ?? 'connected';
  if (S.mode === 'sim' && st === 'connected') return 'sim';
  return st as CablePill;
}
function carState(): 'ok' | 'noanswer' | 'idle' {
  const c = cableState();
  if (c !== 'connected' && c !== 'sim') return 'idle';
  // A module that is not fitted (or is on a line the cable does not reach) does not answer; that must not
  // turn the car red while other modules are answering. During a scan, any answer since it started counts.
  if (S.scanning && link.lastAnswer >= link.scanStart && link.lastAnswer) return 'ok';
  if (link.lastAnswer && Date.now() - link.lastAnswer < 30000) return 'ok';
  if (link.lastNoAnswer > link.lastAnswer) return 'noanswer';
  return link.lastAnswer ? 'ok' : 'idle';
}
const CABLE_TEXT: Record<CablePill, [string, string]> = {
  none: ['off', 'No cable'],
  detected: ['ok', 'Cable plugged in'],
  connected: ['ok', 'Cable connected'],
  unplugged: ['fault', 'Cable unplugged'],
  reconnecting: ['busy', 'Reconnecting…'],
  sim: ['ok', 'Simulator'],
};
const CAR_TEXT = { ok: ['ok', 'Car responding'], noanswer: ['warn', 'Car not responding'], idle: ['off', 'Car —'] } as const;

function statusPills() {
  const [cc, ct] = CABLE_TEXT[cableState()];
  const [rc, rt] = CAR_TEXT[carState()];
  const simToggle = S.mode === 'sim' ? () => { const ch = S.channel as SimChannel; if (ch.state === 'connected') ch.unplug(); else void ch.plug(); } : undefined;
  return h('div', { class: 'pills', id: 'pills' },
    h(simToggle ? 'button' : 'span', { class: `pill ${cc}`, onclick: simToggle, title: simToggle ? 'Simulator: click to unplug / plug the virtual cable' : S.session ? S.channel?.name ?? '' : preCable.name || 'Connect the cable to the USB port' }, h('span', { class: `led ${cc}` }), ct),
    S.session ? h('span', { class: `pill ${rc}`, title: 'K-line: whether the car answers. No answer usually means the ignition is off. On the E46 the K+DCAN cable must join OBD pins 7 and 8 (switch position for older cars), otherwise only the engine and transmission answer.' }, h('span', { class: `led ${rc}` }), rt) : null,
  );
}
function updatePills() {
  document.getElementById('pills')?.replaceWith(statusPills());
}
setInterval(updatePills, 2000);

async function connect(mode: 'cable' | 'sim') {
  S.connError = '';
  try {
    const ch = mode === 'sim' ? new SimChannel(createE46()) : await WebSerialChannel.request();
    const iface = new ObdInterface(ch, {
      onTraffic: (d, b) => log(d, `${d === 'tx' ? '→' : d === 'rx' ? '←' : '·'} ${typeof b === 'string' ? b : toHex(b)}`),
      onLink: (s) => {
        if (s === 'answer') link.lastAnswer = Date.now();
        else if (s === 'noanswer') link.lastNoAnswer = Date.now();
        updatePills();
      },
    });
    await iface.connect();
    (ch as unknown as { onState: ((s: string) => void) | null }).onState = (s) => {
      log(s === 'connected' ? 'info' : 'tx', s === 'unplugged' ? 'Cable unplugged' : s === 'connected' ? 'Cable connected again' : 'Reconnecting cable…');
      link.lastAnswer = 0;
      updatePills();
      renderMain();
    };
    S.channel = ch;
    S.mode = mode;
    link.lastAnswer = link.lastNoAnswer = 0;
    const onJob = (r: JobResponse, ms: number) => log('job', `${r.sgbd}.${r.job} — ${r.error ? r.error.text : jobStatus(r.resultSets) || 'OK'} (${ms} ms)`);
    const native = new NativeSession({
      channel: ch,
      iface,
      onJob,
      onTraffic: (d, b) => log(d, `${d === 'tx' ? '→' : d === 'rx' ? '←' : '·'} ${typeof b === 'string' ? b : toHex(b)}`),
      onLink: (st) => {
        if (st === 'answer') link.lastAnswer = Date.now();
        else if (st === 'noanswer') link.lastNoAnswer = Date.now();
        updatePills();
      },
    });
    // module files for what is in the "modulos" folder, plug & play for anything missing
    S.session = files.count ? new HybridSession(new DiagSession({ files, iface, onJob }), native, () => iface.resetLine()) : native;
    log('info', `Connected: ${ch.name} · ${S.session.kind === 'native' ? 'plug-and-play mode (no module files)' : `${files.count} module files, plug & play for the rest`}`);
    render();
    scan();
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    if (!/No port selected|cancel/i.test(m)) S.connError = `Could not open the cable: ${m}. Close INPA or BMW Scanner if they are using the port.`;
    render();
  }
}

async function disconnect() {
  stopLive();
  S.session?.abort();
  if (S.session instanceof NativeSession) S.session.iso.stopKeepAlive();
  if (S.session instanceof HybridSession) S.session.native.iso.stopKeepAlive();
  (S.channel as unknown as { dispose?: () => void }).dispose?.();
  await S.channel?.close().catch(() => undefined);
  S.session = null;
  S.channel = null;
  S.mode = null;
  S.mods.clear();
  S.selected = null;
  S.page = 'overview';
  render();
}

const cableOk = () => !!S.channel?.isOpen;

async function scan() {
  if (!S.session || S.scanning) return;
  const session = S.session;
  S.scanning = true;
  link.scanStart = Date.now();
  S.mods.clear();
  render();
  await session.scan(E46_MODULES, (e) => {
    modState(e.module.group).scan = e;
    if (!S.live.running) renderMain();
  });
  S.scanning = false;
  render();
  const found = E46_MODULES.filter((m) => modState(m.group).scan?.variant);
  for (const m of found) if (!S.live.running && S.session === session) await readDtcs(m.group, false);
  for (const m of found) if (S.session === session) await checkAvailability(m.group);
}

// ------------------------------------------------------------------ what the car has
const availKey = (st: ModState) => `e46diag.avail.${st.scan!.variant}.${st.scan!.ident.ID_BMW_NR ?? ''}.${S.mode}`;

async function checkAvailability(group: string, force = false) {
  const st = modState(group);
  const session = S.session;
  if (!st.scan?.variant || !session) return;
  if (!force) {
    try {
      const cached = localStorage.getItem(availKey(st));
      if (cached) {
        st.avail = JSON.parse(cached) as Availability;
        renderAll();
        return;
      }
    } catch {
      /* storage unavailable */
    }
  }
  st.availProgress = { done: 0, total: 0 };
  st.availError = undefined;
  renderAll();
  const a = await session.checkAvailability(st.scan.variant, st.scan.ident, (done, total) => {
    st.availProgress = { done, total };
    updateAvailProgress(group);
  }, () => S.session !== session || !cableOk());
  st.availProgress = undefined;
  if (S.session !== session) return;
  if (!cableOk() || a.jobs.length + a.unavailable.length === 0) {
    st.availError = 'Check interrupted';
  } else {
    st.avail = a;
    try {
      localStorage.setItem(availKey(st), JSON.stringify(a));
    } catch {
      /* ignore */
    }
  }
  renderAll();
}
function renderAll() {
  renderRail();
  renderMain();
}
function updateAvailProgress(group: string) {
  const st = modState(group);
  document.querySelectorAll(`[data-avail="${group}"]`).forEach((el) => {
    const p = st.availProgress;
    if (p) el.textContent = `Checking supported data… ${p.done}/${p.total || '?'}`;
  });
}


// ------------------------------------------------------------------ actions
async function readDtcs(group: string, rerender = true) {
  const st = modState(group);
  if (st.dtcNA) return;
  S.busy = 'dtc';
  if (rerender) render();
  const r = await S.session!.readDtcs(st.scan?.variant ?? group);
  if (r.notSupported) {
    st.dtcNA = r.error;
    st.dtcs = undefined;
    st.dtcError = undefined;
  } else {
    st.dtcs = r.dtcs;
    st.dtcError = r.error;
  }
  S.busy = '';
  render();
}

async function clearDtcs(group: string) {
  const st = modState(group);
  const n = st.dtcs?.length ?? 0;
  const obd = st.scan?.variant === 'native:12';
  const ok = await confirmDialog(
    'Clear fault memory?',
    `${n} ${n === 1 ? 'fault' : 'faults'} stored in ${moduleDef(group).short} will be erased. Faults that are still present will come back.${obd ? ' Over OBD-II this also resets the emission readiness monitors; the car sets them again after some driving.' : ''}`,
    'Clear faults',
  );
  if (!ok) return;
  S.busy = 'clear';
  render();
  const r = await S.session!.clearDtcs(st.scan?.variant ?? group);
  st.dtcMsg = r.ok ? { kind: 'ok', text: 'Fault memory cleared.' } : { kind: 'err', text: `Could not clear faults: ${r.error}` };
  S.busy = '';
  await readDtcs(group);
}

async function runJob(variant: string, job: JobListEntry, args: string) {
  if (job.safety === 'test' || job.safety === 'reset') {
    const ok = await confirmDialog(
      job.safety === 'test' ? 'Run actuator test?' : 'Reset learned values?',
      job.safety === 'test' ? `${job.comment || job.name} drives a real component. Car parked, selector in P, handbrake on.` : `${job.comment || job.name} erases learned values in the module. The car re-learns them while driving.`,
      job.safety === 'test' ? 'Run test' : 'Reset',
    );
    if (!ok) return;
  }
  S.busy = 'job';
  S.jobResult = null;
  renderMain();
  S.jobResult = await S.session!.run(variant, job.name, args || undefined);
  S.busy = '';
  renderMain();
}

// ------------------------------------------------------------------ live data
const COLORS = ['#ffa033', '#4290f6', '#41d38a', '#e9ecef'];

/** Key metrics for the current variant: the configured list matched to the values read, else the first 10 values. */
function keyMetrics(variant: string): string[] {
  const vals = S.live.values;
  const want = KEY_METRICS[variant.toLowerCase()];
  let keys: string[] = [];
  if (want) for (const b of want) { const v = vals.find((x) => baseKey(x.key) === b); if (v) keys.push(v.key); }
  if (!keys.length) keys = vals.slice(0, 10).map((v) => v.key);
  return keys.slice(0, 10);
}
function splitKey(keys: string[]) {
  const byKey = new Map(S.live.values.map((v) => [v.key, v]));
  const dials = keys.filter((k) => typeof byKey.get(k)?.value === 'number').slice(0, 4);
  return { dials, tiles: keys.filter((k) => !dials.includes(k)) };
}

async function startLive(group: string) {
  const st = modState(group);
  const variant = st.scan?.variant;
  if (!variant || !S.session || !S.live.job) return;
  S.live.running = true;
  S.live.hist.clear();
  renderMain();
  let n = 0;
  let t0 = Date.now();
  while (S.live.running && S.selected === group) {
    const r = await S.session.readValues(variant, S.live.job);
    if (!S.live.running) break;
    if (r.error && !cableOk()) {
      // cable pulled: pause and resume by itself when it is plugged back in
      document.querySelector('#live-msg')?.replaceChildren(h('div', { class: 'msg warn' }, 'Cable unplugged. Reading is paused and continues as soon as the cable is plugged back in.'));
      while (S.live.running && S.selected === group && !cableOk()) await new Promise((res) => setTimeout(res, 400));
      document.querySelector('#live-msg')?.replaceChildren();
      continue;
    }
    if (r.error) {
      S.live.running = false;
      renderMain();
      document.querySelector('#live-msg')?.replaceChildren(h('div', { class: 'msg err' }, `Reading stopped: ${r.error}`));
      return;
    }
    const first = !S.live.values.length;
    const eq = st.avail?.equipment;
    S.live.values = r.values.filter((v) => !isHiddenByEquipment(v.key, eq));
    for (const v of r.values) {
      if (typeof v.value !== 'number') continue;
      const a = S.live.hist.get(v.key) ?? S.live.hist.set(v.key, []).get(v.key)!;
      a.push(v.value);
      if (a.length > 300) a.shift();
    }
    if (S.live.rec) {
      if (!S.live.recKeys.length) {
        S.live.recKeys = r.values.map((v) => v.key);
        S.live.rec.push(['time', ...r.values.map((v) => `${v.label}${v.unit ? ` (${v.unit})` : ''}`)]);
      }
      const byKey = new Map(r.values.map((v) => [v.key, v.value]));
      S.live.rec.push([new Date().toISOString(), ...S.live.recKeys.map((k) => String(byKey.get(k) ?? ''))]);
    }
    n++;
    if (Date.now() - t0 > 2000) {
      S.live.rate = (n * 1000) / (Date.now() - t0);
      n = 0;
      t0 = Date.now();
    }
    if (first) renderMain();
    updateLive();
  }
  S.live.running = false;
  renderMain();
}
function stopLive() {
  S.live.running = false;
}
function toggleRecord() {
  if (S.live.rec) {
    const csv = S.live.rec.map((r) => r.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `e46-${S.live.job.toLowerCase()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` }).click();
    S.live.rec = null;
    S.live.recKeys = [];
  } else S.live.rec = [];
  renderMain();
}
function toggleExtra(key: string, on: boolean) {
  S.live.extra = S.live.extra.filter((k) => k !== key);
  if (on) S.live.extra.push(key);
  renderMain();
}

const STATE_TEXT: Record<RefState, string> = { ok: 'Normal', low: 'Low', high: 'High', cold: 'Warming up', na: '' };

function metricTile(key: string, removable = false) {
  return h('div', { class: 'tile', 'data-k': key },
    h('div', { class: 't-head' }, h('span', { class: 't-label' }), removable ? h('button', { class: 't-x', title: 'Remove', 'aria-label': 'Remove from additional metrics', onclick: () => toggleExtra(key, false) }, '×') : null),
    h('div', { class: 't-val' }),
    h('div', { class: 't-bar' }, h('span', { class: 't-band' }), h('span', { class: 't-mark' })),
    h('div', { class: 't-foot' }, h('span', { class: 't-state' }), h('span', { class: 't-range' })),
  );
}

function updateTile(el: Element, v: Value | undefined, ctx: EngineContext) {
  const { state, ref } = evaluate(v?.key ?? '', v?.value, ctx);
  el.className = `tile ${state}`;
  el.querySelector('.t-label')!.textContent = v?.label ?? '—';
  el.querySelector('.t-val')!.replaceChildren(fmt(v?.value), h('small', {}, v?.unit === '-' ? '' : v?.unit ?? ''));
  const bar = el.querySelector<HTMLElement>('.t-bar')!;
  const num = typeof v?.value === 'number' ? v.value : NaN;
  if (ref && (ref.lo !== undefined || ref.hi !== undefined) && !Number.isNaN(num)) {
    const lo = ref.lo ?? Math.min(0, num);
    const hi = ref.hi ?? Math.max(lo + 1, num);
    const span = hi - lo || 1;
    const min = lo - span * 0.5;
    const max = hi + span * 0.5;
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - min) / (max - min)) * 100));
    bar.style.display = '';
    (bar.querySelector('.t-band') as HTMLElement).style.cssText = `left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%`;
    (bar.querySelector('.t-mark') as HTMLElement).style.left = `${pct(num)}%`;
    el.querySelector('.t-range')!.textContent = `${ref.lo !== undefined ? formatNumber(ref.lo) : '…'} – ${ref.hi !== undefined ? formatNumber(ref.hi) : '…'}${ref.idleOnly ? ' at idle' : ''}`;
    el.setAttribute('title', ref.note);
  } else {
    bar.style.display = 'none';
    el.querySelector('.t-range')!.textContent = ref?.idleOnly ? 'checked at idle' : '';
    if (ref) el.setAttribute('title', ref.note);
  }
  el.querySelector('.t-state')!.textContent = ref?.idleOnly && !ctx.idle ? '' : STATE_TEXT[state];
}

function updateLive() {
  if (!S.live.values.length || !document.querySelector('.dials, .tiles')) return;
  const st = S.selected ? modState(S.selected) : null;
  const keys = keyMetrics(st?.scan?.variant ?? '');
  const { dials } = splitKey(keys);
  const byKey = new Map(S.live.values.map((v) => [v.key, v]));
  const ctx = engineContext(S.live.values);
  dials.forEach((k, i) => {
    const v = byKey.get(k);
    const { state, ref } = evaluate(k, v?.value, ctx);
    gauges[i]?.update(k, v?.label ?? k, v?.value, v?.unit ?? '', S.live.hist.get(k) ?? [], ref && !(ref.idleOnly && !ctx.idle) ? ref : ref?.idleOnly ? undefined : ref, state);
  });
  document.querySelectorAll('.tile[data-k]').forEach((el) => updateTile(el, byKey.get(el.getAttribute('data-k')!), ctx));
  for (const v of S.live.values) {
    const el = document.querySelector(`[data-v="${CSS.escape(v.key)}"]`);
    if (el) el.replaceChildren(fmt(v.value), h('small', {}, v.unit === '-' ? '' : v.unit));
  }
  const chart = document.querySelector<HTMLCanvasElement>('.chart canvas');
  if (chart) drawChart(chart, dials.map((k, i) => ({ data: S.live.hist.get(k) ?? [], color: COLORS[i] })));
  const out = keys.concat(S.live.extra).filter((k) => { const s = evaluate(k, byKey.get(k)?.value, ctx).state; return s === 'low' || s === 'high'; });
  const ctxEl = document.querySelector('#engine-ctx');
  if (ctxEl) {
    ctxEl.className = `ctx ${out.length ? 'bad' : ''}`;
    ctxEl.textContent = `${ctx.idle ? 'Engine at warm idle' : 'Idle-only checks paused'} · ${out.length ? `${out.length} ${out.length === 1 ? 'value' : 'values'} out of range` : 'All checked values in range'}`;
  }
  const rate = document.querySelector('#rate');
  if (rate) rate.textContent = `${S.live.rate.toFixed(1)} reads/s${S.live.rec ? ` · recording, ${S.live.rec.length - 1} rows` : ''}`;
}


const fmt = (v: number | string | undefined) => (v === undefined ? '—' : typeof v === 'number' ? formatNumber(v) : v);

// ------------------------------------------------------------------ dialogs
function confirmDialog(title: string, text: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const d = h('dialog', {},
      h('h2', {}, title),
      h('p', {}, text),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { d.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { d.close(); resolve(true); } }, action),
      ),
    );
    d.addEventListener('cancel', () => resolve(false));
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => d.remove());
  });
}

// ------------------------------------------------------------------ rendering
function render() {
  const top = renderTop();
  if (!S.session) {
    app.replaceChildren(top, renderSetup(), renderLog());
    return;
  }
  app.replaceChildren(top, h('div', { class: 'layout' }, h('nav', { class: 'rail', 'aria-label': 'Sections' }), h('main', {})));
  renderRail();
  renderMain();
}

/** Describes the connected car from what the scan found (engine code from the DME, transmission and brake modules). */
function carTitle() {
  const dme = S.mods.get('d_0012')?.scan;
  const motor = String(dme?.ident.ID_MOTOR ?? '').split('_')[0];
  return motor ? `BMW E46 · ${motor}` : 'BMW E46';
}
const variantLabel = (v: string) => (v === 'native:12' ? 'OBD-II + DS2' : v.startsWith('native:') ? 'DS2' : v.toUpperCase());
function carSummary() {
  const parts = ['d_0012', 'd_0032', 'd_0056'].map((g) => S.mods.get(g)?.scan?.variant).filter((v): v is string => !!v).map(variantLabel);
  if (S.session?.kind === 'native') return 'Plug & play · OBD-II + DS2';
  return [...new Set(parts)].join(' · ');
}

function logo(cls = '') {
  const t = h('template', {});
  t.innerHTML = logoSvg.trim();
  const svg = t.content.firstElementChild as SVGElement;
  if (cls) svg.classList.add(cls);
  return svg;
}

function renderTop() {
  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, logo(), h('div', { class: 'prod' }, h('b', {}, 'Scan'), h('small', {}, 'BMW E46 diagnostics'))),
    h('div', { class: 'spacer' }),
    S.session && S.mods.size ? null : h('span', { class: 'meta' }, files.count ? `${files.count} module files` : 'Plug & play'),
    S.session && S.mods.size ? h('div', { class: 'car' }, h('b', {}, carTitle()), h('small', {}, carSummary())) : null,
    statusPills(),
    S.session ? h('button', { class: 'btn ghost', onclick: disconnect }, 'Disconnect') : null,
  );
}

function renderSetup() {
  const hasSerial = webSerialAvailable();
  return h('section', { class: 'setup' },
    logo('hero-logo'),
    h('h1', {}, 'BMW E46 diagnostics'),
    h('p', { class: 'lede' }, 'Read and clear fault codes, watch live data and run module tests with your K+DCAN or BMW Scanner cable.'),
    h('ol', { class: 'steps' },
      h('li', { class: files.count ? 'done' : '' },
        h('h2', {}, 'Module files'),
        files.count
          ? h('p', {}, `${files.count} module files loaded from the `, h('code', {}, 'modulos'), ' folder: fault memory, live data and tests for every module that has its file. Modules without a file still work in plug & play mode.')
          : h('p', {}, 'None loaded: plug & play mode. The engine is read over OBD-II (faults, live data) and every module is identified. To read every module, put the module files in the ', h('code', {}, 'modulos'), ' folder and open the app with “Abrir no Windows” or “Abrir no Mac”.'),
      ),
      h('li', {},
        h('h2', {}, 'Connect to the car'),
        h('p', {}, `Plug the cable into the OBD port and turn the key to position 2. On a K+DCAN cable, use K-line mode (switch or bridge pins 7 and 8). ${files.count ? 'Full mode with module files.' : 'Plug-and-play mode: engine over OBD-II, all modules identified.'}`),
        S.connError ? h('div', { class: 'msg err' }, S.connError) : null,
        !hasSerial ? h('div', { class: 'msg warn' }, 'This browser cannot access USB ports. Use Chrome or Edge on Mac or Windows to connect the cable. The simulator works in any browser.') : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !hasSerial, onclick: () => connect('cable') }, 'Connect cable'),
          h('button', { class: 'btn', onclick: () => connect('sim') }, 'Use simulator'),
        ),
      ),
    ),
  );
}

function statusOf(st: ModState | undefined): { cls: string; text: string } {
  if (!st?.scan) return { cls: 'idle', text: S.scanning ? 'scanning' : '' };
  if (!st.scan.variant) return { cls: 'off', text: '' };
  if (st.dtcNA) return { cls: 'idle', text: 'ID only' };
  if (st.dtcs === undefined) return { cls: st.dtcError ? 'fault' : 'idle', text: st.dtcError ? 'read error' : '' };
  return st.dtcs.length ? { cls: 'fault', text: `${st.dtcs.length} ${st.dtcs.length === 1 ? 'fault' : 'faults'}` } : { cls: 'ok', text: 'OK' };
}

const PAGES: [Page, string][] = [['overview', 'Overview'], ['faults', 'Faults'], ['live', 'Live Data'], ['functions', 'Tests & Functions'], ['report', 'Report'], ['log', 'Log']];
const foundModules = () => E46_MODULES.filter((m) => S.mods.get(m.group)?.scan?.variant);

/** Side menu: sections of the app, safety state at the bottom. */
function renderRail() {
  const rail = document.querySelector('.rail');
  if (!rail) return;
  const faults = foundModules().reduce((n, m) => n + (S.mods.get(m.group)?.dtcs?.length ?? 0), 0);
  const service = S.session?.safetyMode === 'service';
  rail.replaceChildren(
    ...PAGES.map(([p, label]) =>
      h('button', { class: 'nav', 'aria-current': S.page === p ? 'page' : 'false', onclick: () => go(p) },
        label, p === 'faults' && faults ? h('span', { class: 'count' }, String(faults)) : null)),
    h('div', { class: `rail-foot ${service ? 'unlocked' : ''}` },
      h('span', { class: `led ${service ? 'warn' : 'ok'}` }),
      h('div', {}, h('b', {}, service ? 'Tests & resets unlocked' : 'Read-only mode'), h('small', {}, 'Coding & programming blocked'))),
  );
}

function go(p: Page) {
  if (p !== 'live') stopLive();
  if (MODULE_PAGES.includes(p) && !S.selected) S.selected = foundModules()[0]?.group ?? null;
  S.page = p;
  renderRail();
  renderMain();
}

function select(g: string) {
  if (S.selected !== g) {
    stopLive();
    S.live.values = [];
    S.live.extra = [];
    S.live.job = '';
    S.jobSel = '';
    S.jobResult = null;
    S.jobFilter = '';
  }
  S.selected = g;
  if (!MODULE_PAGES.includes(S.page)) S.page = 'faults';
  renderRail();
  renderMain();
}

/** Module tabs along the top of the module pages. */
function renderChips() {
  const found = foundModules();
  const missing = E46_MODULES.filter((m) => S.mods.get(m.group)?.scan && !S.mods.get(m.group)!.scan!.variant).length;
  return h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Modules' },
    found.map((m) => {
      const s = statusOf(S.mods.get(m.group));
      return h('button', { class: `chip ${s.cls}`, role: 'tab', 'aria-selected': S.selected === m.group ? 'true' : 'false', onclick: () => select(m.group) },
        h('span', { class: `led ${s.cls}` }), h('b', {}, m.short), h('small', {}, s.text || m.name));
    }),
    S.scanning ? h('span', { class: 'chip ghost' }, h('span', { class: 'led busy' }), h('b', {}, 'Scanning…')) : null,
    !S.scanning ? h('button', { class: 'chip ghost', onclick: scan, title: missing ? `${missing} modules did not respond: not fitted to this car, or (if only engine and transmission answer) the cable switch is not joining OBD pins 7 and 8` : '' }, h('b', {}, 'Rescan'), missing ? h('small', {}, `${missing} not responding`) : null) : null,
  );
}

function renderMain() {
  const main = document.querySelector('main');
  if (!main) return;
  gauges = [];
  if (S.page === 'overview') return main.replaceChildren(...nodes(renderOverview()));
  if (S.page === 'report') return main.replaceChildren(...nodes(renderReport()));
  if (S.page === 'log') return main.replaceChildren(...nodes(renderLogPage()));
  if (!S.selected || !modState(S.selected).scan?.variant) S.selected = foundModules()[0]?.group ?? null;
  if (!S.selected) {
    return main.replaceChildren(renderChips(),
      h('div', { class: 'empty' }, h('strong', {}, S.scanning ? 'Looking for modules…' : 'No module responded'), S.scanning ? 'This takes a few seconds.' : 'Check the ignition is in position 2 and the cable is in K-line mode with OBD pins 7 and 8 joined, then press Rescan.'));
  }
  const m = moduleDef(S.selected);
  const st = modState(m.group);
  if (!st.scan?.variant) return;
  const id = st.scan.ident;
  const idItem = (label: string, v: unknown) => (v !== undefined && v !== '' ? h('div', {}, h('dt', {}, label), h('dd', {}, String(v))) : null);
  const title = S.page === 'faults' ? 'Fault memory' : S.page === 'live' ? 'Live data' : 'Tests & functions';
  main.replaceChildren(...nodes([
    renderChips(),
    h('div', { class: 'mh' },
      h('div', {}, h('p', { class: 'kicker' }, `${m.name} · ${variantLabel(st.scan.variant)} · 0x${hex2(m.address)}`), h('h1', {}, `${title} · ${m.short}`)),
      h('dl', { class: 'ident' },
        idItem('BMW part no.', id.ID_BMW_NR), idItem('Hardware', id.ID_HW_NR), idItem('Software', id.ID_SW_NR),
        idItem('Coding index', id.ID_COD_INDEX), idItem('Diag index', id.ID_DIAG_INDEX),
        id.ID_DATUM_KW !== undefined ? idItem('Built (wk/yr)', `${id.ID_DATUM_KW}/${id.ID_DATUM_JAHR}`) : null),
    ),
    ...(S.page === 'faults' ? renderDtcTab(m) : S.page === 'live' ? renderLiveTab(m) : renderJobsTab(m)),
  ]));
  if (S.page === 'live' && document.querySelector('.dials, .tiles')) updateLive();
  if (S.page === 'functions' && !st.jobs) S.session!.listJobs(st.scan.variant).then((j) => { st.jobs = j; renderMain(); });
}

function renderDtcTab(m: ModuleDef): (Node | null)[] {
  const st = modState(m.group);
  const busy = !!S.busy || S.live.running;
  if (st.dtcNA)
    return [
      h('div', { class: 'empty' },
        h('strong', {}, 'Identification only in plug-and-play mode'),
        'This module talks BMW’s own DS2 protocol, and its fault codes are specific to it. Reading them needs its module file in the modulos folder (then open the app again with “Abrir no Windows” or “Abrir no Mac”).'),
    ];
  const obd = st.scan?.variant === 'native:12';
  return [
    obd ? h('p', { class: 'availnote' }, 'Read over OBD-II / EOBD: standard fault codes with standard descriptions. BMW-specific codes (P1xxx) show their number; their exact meaning needs the module files.') : null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', disabled: busy, onclick: () => readDtcs(m.group) }, S.busy === 'dtc' ? 'Reading…' : 'Read faults'),
      h('button', { class: 'btn danger', disabled: busy || !st.dtcs?.length, onclick: () => clearDtcs(m.group) }, S.busy === 'clear' ? 'Clearing…' : 'Clear faults'),
    ),
    st.dtcMsg ? h('div', { class: `msg ${st.dtcMsg.kind}` }, st.dtcMsg.text) : null,
    st.dtcError ? h('div', { class: 'msg err' }, `Read failed: ${st.dtcError}`) : null,
    st.dtcs === undefined
      ? h('div', { class: 'empty' }, h('strong', {}, 'Fault memory not read yet'), 'Press Read faults.')
      : !st.dtcs.length
        ? h('div', { class: 'empty clean' }, h('strong', {}, 'No faults stored'), 'The fault memory of this module is empty.')
        : h('div', { class: 'dtcs' }, st.dtcs.map(dtcItem)),
  ];
}

function dtcItem(d: Dtc) {
  const tags = [d.present === true ? 'Present' : d.present === false ? 'Not present now' : '', d.frequency !== null ? `Seen ${d.frequency}×` : ''].filter(Boolean);
  return h('details', { class: 'dtc' },
    h('summary', {},
      h('span', { class: 'code' }, dtcCode(d)),
      h('span', { class: 'txt' }, h('b', {}, d.text || 'Fault without description'), d.details.length ? h('span', {}, d.details.join(', ')) : null),
      h('span', { class: 'tags' }, tags.map((t) => h('span', { class: `tag ${t === 'Present' ? 'hot' : ''}` }, t))),
    ),
    h('div', { class: 'dtc-body' },
      d.env.length
        ? h('div', { class: 'env' }, d.env.map((e) => h('div', {}, h('span', {}, e.name), h('b', {}, `${fmt(Number.isNaN(+e.value) || e.value === '' ? e.value : +e.value)} ${e.unit}`))))
        : null,
      h('p', { class: 'orig' }, d.textOriginal ? `Original text: ${d.textOriginal} · raw ${d.hex}` : `OBD-II standard code · raw ${d.hex}`),
    ),
  );
}

function hiddenEquipment(a: Availability): string[] {
  return (Object.keys(a.equipment) as EquipmentKey[]).filter((k) => a.equipment[k] === false).map((k) => EQUIPMENT_LABEL[k]);
}

function renderLiveTab(m: ModuleDef): (Node | null)[] {
  const st = modState(m.group);
  if (st.dtcNA) return [h('div', { class: 'empty' }, h('strong', {}, 'No live data in plug-and-play mode'), 'Live data for this module needs its module file in the modulos folder. The engine has live data over OBD-II.')];
  if (!st.jobs) {
    S.session!.listJobs(st.scan!.variant!).then((j) => { st.jobs = j; renderMain(); });
    return [h('div', { class: 'empty' }, 'Loading value groups…')];
  }
  const avail = st.avail;
  const statusJobs = st.jobs.filter((j) => isLiveGroup(j) && !isHiddenByEquipment(j.name, avail?.equipment) && (!avail || avail.jobs.includes(j.name)));
  if (S.live.job && !statusJobs.some((j) => j.name === S.live.job)) S.live.job = '';
  if (!S.live.job) S.live.job = statusJobs.find((j) => /MESSWERTEBLOCK|MESSWERTE$/.test(j.name))?.name ?? statusJobs.find((j) => j.name === 'STATUS_IO_LESEN')?.name ?? statusJobs[0]?.name ?? '';
  const sel = h('select', { class: 'select', 'aria-label': 'Value group', disabled: S.live.running, onchange: (e: Event) => { S.live.job = (e.target as HTMLSelectElement).value; S.live.values = []; S.live.extra = []; renderMain(); } },
    statusJobs.map((j) => h('option', { value: j.name, selected: j.name === S.live.job }, j.comment || j.name)));
  const toolbar = h('div', { class: 'toolbar' },
    sel,
    S.live.running
      ? h('button', { class: 'btn primary', onclick: stopLive }, 'Stop')
      : h('button', { class: 'btn primary', disabled: !S.live.job || !!S.busy, onclick: () => startLive(m.group) }, 'Start'),
    h('button', { class: `btn ${S.live.rec ? 'rec' : ''}`, disabled: !S.live.running && !S.live.rec, onclick: toggleRecord }, S.live.rec ? 'Stop & save CSV' : 'Record CSV'),
    h('span', { class: 'note', id: 'rate' }),
  );
  const availNote = st.availProgress
    ? h('div', { class: 'msg info', 'data-avail': m.group }, `Checking supported data… ${st.availProgress.done}/${st.availProgress.total || '?'}`)
    : avail
      ? h('p', { class: 'availnote' }, `${statusJobs.length} value ${statusJobs.length === 1 ? 'group' : 'groups'} supported by this ${m.short}${avail.unavailable.length ? ` · ${avail.unavailable.length} not supported (hidden)` : ''}${hiddenEquipment(avail).length ? ` · not fitted: ${hiddenEquipment(avail).join(', ')}` : ''}.`)
      : null;
  if (!S.live.values.length) {
    return [toolbar, availNote, h('div', { id: 'live-msg' }),
      h('div', { class: 'empty' }, h('strong', {}, 'Press Start to read live data'), m.short === 'DME' ? 'The 10 key engine values are shown with their normal range for a warm M54. Values outside the range turn red.' : 'The key values of this module are shown first; add any other value to Additional metrics.')];
  }
  const keys = keyMetrics(st.scan!.variant!);
  const { dials, tiles } = splitKey(keys);
  gauges = dials.map(() => new Gauge());
  const byKey = new Map(S.live.values.map((v) => [v.key, v]));
  const extras = S.live.extra.filter((k) => byKey.has(k) && !keys.includes(k));
  const others = S.live.values.filter((v) => !keys.includes(v.key));
  return [
    toolbar,
    availNote,
    h('div', { id: 'live-msg' }),
    h('section', { class: 'zone' },
      h('div', { class: 'zone-head' }, h('h2', {}, 'Key metrics'), h('span', { class: 'ctx', id: 'engine-ctx' })),
      dials.length ? h('div', { class: 'dials' }, gauges.map((g) => h('div', { class: 'dw' }, g.root))) : null,
      tiles.length ? h('div', { class: 'tiles' }, tiles.map((k) => metricTile(k))) : null,
      m.short === 'DME'
        ? h('p', { class: 'refnote' }, st.scan?.variant === 'native:12'
            ? 'Standard OBD-II values. Normal ranges are typical for a warm E46 petrol engine. Ranges marked “at idle” are only checked at warm idle with the car stopped. Values refresh about once per second: OBD-II on the K-line is slow by design.'
            : 'Normal ranges are reference values for a warm M54 with the MS43. Ranges marked “at idle” are only checked at warm idle with the car stopped. Hover a value for details.')
        : null,
    ),
    dials.length ? h('div', { class: 'chart' }, h('canvas', {}), h('div', { class: 'legend' }, dials.map((k, i) => h('span', {}, h('i', { style: `background:${COLORS[i]}` }), byKey.get(k)?.label ?? k)))) : null,
    h('section', { class: 'zone' },
      h('div', { class: 'zone-head' }, h('h2', {}, 'Additional metrics'), h('span', { class: 'ctx' }, extras.length ? `${extras.length} selected` : '')),
      extras.length
        ? h('div', { class: 'tiles' }, extras.map((k) => metricTile(k, true)))
        : h('div', { class: 'empty slim' }, 'Tick any value in the list below to follow it here.'),
    ),
    others.length
      ? h('section', { class: 'zone' },
          h('div', { class: 'zone-head' }, h('h2', {}, `All values · ${others.length}`)),
          h('div', { class: 'values' }, others.map((v) =>
            h('label', { class: `vrow ${S.live.extra.includes(v.key) ? 'pinned' : ''}`, title: v.key },
              h('input', { type: 'checkbox', checked: S.live.extra.includes(v.key), onchange: (e: Event) => toggleExtra(v.key, (e.target as HTMLInputElement).checked) }),
              h('span', { class: 'k' }, v.label),
              h('span', { class: 'v', 'data-v': v.key }, fmt(v.value), h('small', {}, v.unit === '-' ? '' : v.unit))))))
      : null,
  ];
}



type JobGroup = 'test' | 'reset' | 'status' | 'dtc' | 'ident' | 'other';
const GROUP_LABEL: Record<JobGroup, string> = { test: 'Actuator tests', reset: 'Resets & adaptations', status: 'Readings', dtc: 'Fault memory', ident: 'Identification', other: 'Other readings' };
const groupOf = (j: JobListEntry): JobGroup => (j.safety === 'test' ? 'test' : j.safety === 'reset' ? 'reset' : j.kind === 'control' ? 'other' : (j.kind as JobGroup));

async function unlockService() {
  const ok = await confirmDialog(
    'Unlock tests & resets?',
    'Actuator tests drive real parts (fuel pump, injectors, fan, VANOS, ABS valves) and resets erase learned values that the car then re-learns. Only use them when parked: selector in P, handbrake on, engine off unless the test needs it running. Coding and programming stay blocked.',
    'Unlock',
  );
  if (ok && S.session) S.session.safetyMode = 'service';
  renderRail();
  renderMain();
}
function lockService() {
  if (S.session) S.session.safetyMode = 'read';
  renderRail();
  renderMain();
}

function renderJobsTab(m: ModuleDef): (Node | null)[] {
  const st = modState(m.group);
  if (st.dtcNA) return [h('div', { class: 'empty' }, h('strong', {}, 'No functions in plug-and-play mode'), 'Tests and functions of this module need its module file in the modulos folder.')];
  if (!st.jobs) return [h('div', { class: 'empty' }, 'Loading module functions…')];
  const service = S.session?.safetyMode === 'service';
  const eq = st.avail?.equipment;
  const visible = st.jobs.filter((j) => j.safety !== 'write' && !isHiddenByEquipment(j.name, eq) && !/^(INITIALISIERUNG|INFO|DIAGNOSE_\w+)$/.test(j.name));
  const blocked = st.jobs.filter((j) => j.safety === 'write').length;
  const notFitted = st.jobs.filter((j) => j.safety !== 'write' && isHiddenByEquipment(j.name, eq)).length;
  const f = S.jobFilter.toLowerCase();
  const list = visible.filter((j) => !f || j.name.toLowerCase().includes(f) || j.comment.toLowerCase().includes(f));
  const sel = visible.find((j) => j.name === S.jobSel);
  const filter = h('input', {
    type: 'search', placeholder: `Search ${visible.length} functions`, value: S.jobFilter, 'aria-label': 'Search functions',
    oninput: (e: Event) => {
      const t = e.target as HTMLInputElement;
      S.jobFilter = t.value;
      const pos = t.selectionStart;
      renderMain();
      const n = document.querySelector<HTMLInputElement>('.joblist input');
      n?.focus();
      n?.setSelectionRange(pos, pos);
    },
  });
  const order: JobGroup[] = ['status', 'dtc', 'ident', 'other', 'test', 'reset'];
  const groups = order.map((k) => [k, list.filter((j) => groupOf(j) === k)] as const).filter(([, l]) => l.length);
  const argInputs: HTMLInputElement[] = [];
  const locked = (j: JobListEntry) => (j.safety === 'test' || j.safety === 'reset') && !service;
  const safetyBar = service
    ? h('div', { class: 'safety unlocked' },
        h('span', { class: 'led warn' }),
        h('div', {}, h('b', {}, 'Tests & resets unlocked'), h('span', {}, 'Actuator tests and adaptation resets can be run until you lock again or disconnect.')),
        h('button', { class: 'btn', onclick: lockService }, 'Lock again'))
    : h('div', { class: 'safety' },
        h('span', { class: 'led ok' }),
        h('div', {}, h('b', {}, 'Read-only mode'), h('span', {}, 'Only readings and clearing fault memory. Nothing in the car is changed.')),
        h('button', { class: 'btn', onclick: unlockService }, 'Unlock tests & resets'));
  return [
    safetyBar,
    blocked || notFitted
      ? h('p', { class: 'availnote' }, [blocked ? `${blocked} coding/programming functions are hidden: they write permanently to the module and are not supported.` : '', notFitted ? `${notFitted} functions for equipment this car does not have are hidden.` : ''].filter(Boolean).join(' '))
      : null,
    h('div', { class: 'jobs' },
      h('div', { class: 'joblist' }, filter,
        groups.map(([k, l]) => [
          h('div', { class: 'jobgroup' }, `${GROUP_LABEL[k]} · ${l.length}${(k === 'test' || k === 'reset') && !service ? ' · locked' : ''}`),
          ...l.map((j) => h('button', { class: `job ${locked(j) ? 'locked' : ''}`, 'aria-current': j.name === S.jobSel ? 'true' : 'false', onclick: () => { S.jobSel = j.name; S.jobResult = null; renderMain(); } }, h('b', {}, j.name), j.comment ? h('span', {}, j.comment) : null)),
        ]),
      ),
      h('div', { class: 'jobdetail' },
        !sel
          ? h('div', { class: 'empty' }, h('strong', {}, 'Pick a function'), 'Readings return values and are always safe. Actuator tests and resets are locked until you unlock them above.')
          : h('div', {},
              h('div', { class: 'jd-head' }, h('h3', {}, sel.name), h('span', { class: `tag safety-${sel.safety}` }, SAFETY_LABEL[sel.safety])),
              h('p', { class: 'desc' }, sel.comment || 'No description in the ECU file.'),
              sel.safety === 'test' ? h('div', { class: 'msg warn' }, 'Drives a real component. Car parked, selector in P, handbrake on. Engine off unless the test needs it running.') : null,
              sel.safety === 'reset' ? h('div', { class: 'msg warn' }, 'Erases learned values. The car re-learns them while driving; idle and shifting may feel different for a while.') : null,
              sel.args.length
                ? h('div', { class: 'args' }, sel.args.map((a) => {
                    const i = h('input', { placeholder: a.type, disabled: locked(sel) });
                    argInputs.push(i);
                    return h('label', {}, h('b', {}, a.name), a.comment ? h('span', {}, a.comment) : null, i);
                  }))
                : null,
              locked(sel)
                ? h('button', { class: 'btn', onclick: unlockService }, 'Unlock tests & resets to run')
                : h('button', { class: 'btn primary', disabled: !!S.busy || S.live.running || !cableOk(), onclick: () => runJob(st.scan!.variant!, sel, argInputs.map((i) => i.value.trim()).join(';')) }, S.busy === 'job' ? 'Running…' : 'Run'),
              S.jobResult ? renderResult(S.jobResult) : null,
            ),
      ),
    ),
  ];
}

function renderResult(r: JobResponse) {
  const rows: Node[] = [];
  r.resultSets.slice(1).forEach((s, i) => {
    let first = true;
    for (const [k, v] of s) {
      const val = v.value instanceof Uint8Array ? toHex(v.value) : typeof v.value === 'number' ? formatNumber(v.value) : String(v.value);
      rows.push(h('tr', { class: first && i > 0 ? 'set' : '' }, h('td', {}, k), h('td', {}, val)));
      first = false;
    }
  });
  return h('div', { class: 'result' },
    r.error ? h('div', { class: 'msg err' }, r.error.text) : null,
    rows.length ? h('table', { class: 'res' }, h('tbody', {}, rows)) : !r.error ? h('p', { class: 'desc' }, 'The function returned no values.') : null,
  );
}

function reportLines() {
  const lines = [`E46Fanatics Scan report — ${new Date().toLocaleString('en-GB')}`, `${carTitle()} · ${carSummary()}`, ''];
  for (const m of foundModules()) {
    const st = S.mods.get(m.group)!;
    const id = st.scan!.ident;
    lines.push(`${m.short} ${m.name} (${variantLabel(st.scan!.variant!)}) — part ${id.ID_BMW_NR ?? '-'}, HW ${id.ID_HW_NR ?? '-'}, SW ${id.ID_SW_NR ?? '-'}`);
    for (const d of st.dtcs ?? []) lines.push(`   ${dtcCode(d)}  ${d.text}${d.details.length ? ` (${d.details.join(', ')})` : ''}${d.textOriginal ? `   [${d.textOriginal}]` : ''}`);
    if (st.dtcNA) lines.push('   identified only (no module file)');
    else if (st.dtcs && !st.dtcs.length) lines.push('   no faults');
    else if (!st.dtcs) lines.push('   fault memory not read');
    lines.push('');
  }
  return lines;
}
function saveReport() {
  h('a', { href: URL.createObjectURL(new Blob([reportLines().join('\n')], { type: 'text/plain' })), download: `e46-report-${new Date().toISOString().slice(0, 10)}.txt` }).click();
}

function renderReport(): (Node | null)[] {
  const found = foundModules();
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Vehicle report'), h('h1', {}, 'Report'))),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', disabled: !found.length, onclick: saveReport }, 'Save as text file'),
      h('button', { class: 'btn', disabled: !found.length || S.scanning || !!S.busy, onclick: async () => { for (const m of found) await readDtcs(m.group, false); } }, 'Read all faults again'),
      h('span', { class: 'note' }, 'Identification and fault memory of every module, to keep or send.')),
    found.length ? h('pre', { class: 'report' }, reportLines().join('\n')) : h('div', { class: 'empty' }, h('strong', {}, 'Nothing to report yet'), 'Scan the car first.'),
  ];
}

function renderLogPage(): (Node | null)[] {
  const box = h('div', { class: 'log log-page' }, S.log.map((l) => h('div', { class: l.cls }, l.text)));
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'K-line traffic'), h('h1', {}, 'Communication log'))),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => { void navigator.clipboard?.writeText(S.log.map((l) => l.text).join('\n')); } }, 'Copy log'),
      h('button', { class: 'btn', onclick: () => h('a', { href: URL.createObjectURL(new Blob([S.log.map((l) => l.text).join('\n')], { type: 'text/plain' })), download: `e46-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt` }).click() }, 'Save log'),
      h('span', { class: 'note' }, 'If something does not work, send this log.')),
    box,
  ];
}

function renderOverview(): (Node | null)[] {
  const found = E46_MODULES.filter((m) => S.mods.get(m.group)?.scan?.variant);
  const total = found.reduce((n, m) => n + (S.mods.get(m.group)?.dtcs?.length ?? 0), 0);
  const read = found.filter((m) => S.mods.get(m.group)?.dtcs !== undefined || S.mods.get(m.group)?.dtcNA || S.mods.get(m.group)?.dtcError).length;
  return [
    h('div', { class: 'mh' },
      h('div', {}, h('p', { class: 'kicker' }, S.scanning ? 'Scanning the K-line…' : 'Vehicle overview'), h('h1', {}, carTitle())),
      h('div', { class: 'readouts' },
        h('div', {}, h('b', {}, String(found.length)), h('span', {}, 'modules responding')),
        h('div', { class: total ? 'hot' : '' }, h('b', {}, read < found.length ? '…' : String(total)), h('span', {}, total === 1 ? 'fault stored' : 'faults stored')),
      ),
    ),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', disabled: S.scanning || !!S.busy, onclick: async () => { for (const m of found) await readDtcs(m.group, false); } }, 'Read all faults'),
      h('button', { class: 'btn', disabled: !found.length, onclick: saveReport }, 'Save report'),
      h('button', { class: 'btn', disabled: !found.length || found.some((m) => S.mods.get(m.group)?.availProgress), onclick: async () => { for (const m of found) await checkAvailability(m.group, true); } }, 'Re-check supported data'),
    ),
    found.length
      ? h('div', { class: 'modgrid' }, found.map((m) => {
          const st = S.mods.get(m.group)!;
          const id = st.scan!.ident;
          const s = statusOf(st);
          return h('button', { class: `modcard ${s.cls}`, onclick: () => select(m.group) },
            h('div', { class: 'mc-head' }, h('span', { class: `led ${s.cls}` }), h('b', {}, m.short), h('span', { class: 'mc-file' }, variantLabel(st.scan!.variant!))),
            h('div', { class: 'mc-name' }, m.name),
            h('div', { class: 'mc-id' }, `Part ${id.ID_BMW_NR ?? '—'} · HW ${id.ID_HW_NR ?? '—'} · SW ${id.ID_SW_NR ?? '—'}`),
            st.dtcNA
              ? h('div', { class: 'mc-avail' }, 'Identified. Fault memory needs its module file.')
              : st.availProgress
              ? h('div', { class: 'mc-avail busy', 'data-avail': m.group }, `Checking supported data… ${st.availProgress.done}/${st.availProgress.total || '?'}`)
              : st.avail
                ? h('div', { class: 'mc-avail' }, `${st.avail.jobs.length} value ${st.avail.jobs.length === 1 ? 'group' : 'groups'} supported${hiddenEquipment(st.avail).length ? ` · not fitted: ${hiddenEquipment(st.avail).join(', ')}` : ''}`)
                : st.availError
                  ? h('div', { class: 'mc-avail warn' }, `${st.availError}. `, h('span', { class: 'link', role: 'button', tabindex: 0, onclick: (e: Event) => { e.stopPropagation(); void checkAvailability(m.group, true); } }, 'Retry'))
                  : null,
            st.dtcNA
              ? null
              : st.dtcs === undefined
              ? h('div', { class: 'mc-faults muted' }, st.dtcError ? 'Fault memory could not be read' : 'Reading fault memory…')
              : st.dtcs.length
                ? h('ul', { class: 'mc-faults' }, st.dtcs.map((d) => h('li', {}, h('span', { class: 'code' }, dtcCode(d)), d.text)))
                : h('div', { class: 'mc-faults clean' }, 'No faults stored'),
          );
        }))
      : h('div', { class: 'empty' }, h('strong', {}, S.scanning ? 'Scanning modules…' : 'No module responded'), S.scanning ? 'This takes a few seconds.' : 'Check the ignition is in position 2 and the cable is in K-line mode.'),
  ];
}

function renderLog() {
  const d = h('details', { class: 'logbar' }, h('summary', {}, 'Communication log'), h('div', { class: 'log' }, S.log.map((l) => h('div', { class: l.cls }, l.text))));
  d.addEventListener('toggle', () => { const l = d.querySelector('.log')!; l.scrollTop = l.scrollHeight; });
  return d;
}

// ------------------------------------------------------------------ boot
document.documentElement.lang = 'en';
document.title = 'E46Fanatics Scan';
files
  .loadEmbedded()
  .catch(() => 0)
  .then(() => render())
  .then(() =>
    watchCable((present, name) => {
      preCable = { present, name };
      updatePills();
    }),
  );
