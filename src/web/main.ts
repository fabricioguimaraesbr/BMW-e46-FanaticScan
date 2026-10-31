import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import '@fontsource/jetbrains-mono/400.css';
import { Availability, BLOCKED_CODE, DiagSession, Dtc, Session, JobListEntry, ScanEntry, Value, isLiveGroup, jobStatus } from '../core/api/DiagSession';
import { HybridSession } from '../core/api/HybridSession';
import { EQUIPMENT_LABEL, EquipmentKey, isHiddenByEquipment } from '../core/api/equipment';
import { SAFETY_LABEL } from '../core/api/safety';
import { ALL_E46_MODULES, E46_MODULES, ModuleDef } from '../core/api/modules';
import { EngineContext, KEY_METRICS, RefState, Reference, baseKey, engineContext, evaluate, referenceFor } from '../core/api/reference';
import { PanelPick, barScale, sameValueId, groupValues, isFlag, kindOf, pickPanel, visibleValues } from '../core/api/livelayout';
import type { JobResponse } from '../core/ediabas/Ediabas';
import { createE46 } from '../core/sim/e46';
import { DriveCycle } from '../core/sim/drive';
import { NativeSession } from '../core/native/NativeSession';
import { SimChannel } from '../core/sim/SimChannel';
import type { ByteChannel } from '../core/transport/ByteChannel';
import { DtrMode, ObdInterface } from '../core/transport/ObdInterface';
import { buildReport } from '../core/api/report';
import type { PageCtx } from './ctx';
import { loadGarage, renderGarage, saveCurrentScan } from './garagePage';
import { loggerRunning, renderLogger, resetLogger, stopLogger } from './loggerPage';
import { renderService, resetService } from './servicePage';
import { renderCoding, resetCoding } from './codingPage';
import { renderVehicle, resetVehicle } from './vehiclePage';
import { renderChecks, resetChecks, stopChecks } from './checksPage';
import { renderLibrary } from './libraryPage';
import { openTroubleshoot } from './troubleshoot';
import { ShareState, approvalDialog, openRemoteDialog } from './remote';
import type { RemoteSession } from '../core/remote/remote';
import { toHex } from '../core/util/numbers';
import { BrowserFileProvider } from './BrowserFileProvider';
import { liquidBackdrop } from './backdrop';
import { drawChart } from './chart';
import { formatNumber } from './gauge';
import logoSvg from './assets/e46fanatics.svg?raw';
import './nativeApp'; // Android app: USB bridge and file saving (no effect in a browser)
import { WebSerialChannel, watchCable, webSerialAvailable } from './WebSerialChannel';
import { WebUsbFtdiChannel, watchUsbCable, webUsbAvailable } from './WebUsbFtdiChannel';

/** Desktop Chrome/Edge: Web Serial (the OS drives the FTDI chip). Chrome on Android: WebUSB with our own FTDI driver. */
const cableApi = (): 'serial' | 'usb' | null => (webSerialAvailable() ? 'serial' : webUsbAvailable() ? 'usb' : null);
import { confirmDialog, download, h, nodes, stamp, store } from './dom';

// ------------------------------------------------------------------ state
/** Sections of the side menu. Module pages (faults, live, functions) show the module tabs on top. */
type Page = 'overview' | 'vehicle' | 'faults' | 'live' | 'functions' | 'checks' | 'service' | 'coding' | 'logger' | 'garage' | 'library' | 'log';
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
  iface: null as ObdInterface | null,
  /** K+DCAN line control, remembered in this browser */
  dtrMode: store.get<DtrMode>('e46diag.dtrMode', 'off'),
  /** also scan the modules only some cars have (navigation, phone, seats…) */
  scanOptional: store.get<boolean>('e46diag.scanOptional', false),
  /** the cable looks slow (FTDI latency timer) */
  hint: '' as '' | 'latency',
  /** a screen opened from the start screen (no car connected) */
  offline: '' as '' | 'garage' | 'library',
  channel: null as ByteChannel | null,
  mode: null as 'cable' | 'sim' | 'remote' | null,
  /** helper side: the car of someone else, read through a remote session */
  remote: null as RemoteSession | null,
  remoteAccess: '' as '' | 'read' | 'tests',
  /** owner side: this car is shared with a helper */
  share: null as ShareState | null,
  busy: '' as string,
  scanning: false,
  selected: null as string | null, // module group, null = vehicle overview
  page: 'overview' as Page,
  mods: new Map<string, ModState>(),
  log: [] as { cls: string; text: string }[],
  connError: '',
  live: {
    running: false,
    paused: false,
    error: '',
    chart: false,
    /** every value read so far on this module, merged from all its value groups (insertion order = screen order) */
    store: new Map<string, { v: Value; job: string }>(),
    values: [] as Value[],
    hist: new Map<string, number[]>(),
    rate: 0,
    rec: null as { t: string; vals: Map<string, number | string> }[] | null,
    sig: '',
    pass: { done: 0, total: 0 },
  },
  jobSel: '',
  jobFilter: '',
  jobResult: null as JobResponse | null,
};
const modState = (g: string) => S.mods.get(g) ?? S.mods.set(g, {}).get(g)!;
const moduleDef = (g: string) => ALL_E46_MODULES.find((m) => m.group === g)!;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const dtcCode = (d: Dtc) => d.label ?? hex2(d.code);
const app = document.getElementById('app')!;

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
type CablePill = 'none' | 'detected' | 'connected' | 'unplugged' | 'reconnecting' | 'sim' | 'remote';
const link = { lastAnswer: 0, lastNoAnswer: 0, scanStart: 0 };
let preCable = { present: false, name: '' };

function cableState(): CablePill {
  if (!S.session) return preCable.present ? 'detected' : 'none';
  if (S.mode === 'remote') return S.remote?.open ? 'remote' : 'unplugged';
  const st = (S.channel as unknown as { state?: string }).state ?? 'connected';
  if (S.mode === 'sim' && st === 'connected') return 'sim';
  return st as CablePill;
}
function carState(): 'ok' | 'noanswer' | 'idle' {
  const c = cableState();
  if (c !== 'connected' && c !== 'sim' && c !== 'remote') return 'idle';
  if (c === 'remote') return S.remote && Date.now() - S.remote.lastAnswer < 30000 ? 'ok' : 'idle';
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
  remote: ['ok', 'Remote car'],
};
const CAR_TEXT = { ok: ['ok', 'Car responding'], noanswer: ['warn', 'Car not responding'], idle: ['off', 'Car —'] } as const;

/** The simulated trip (key on → cold start → city → motorway → top speed → idle → off, repeating). */
let simDrive: DriveCycle | null = null;

function statusPills() {
  const [cc, ct] = CABLE_TEXT[cableState()];
  const [rc, rt] = CAR_TEXT[carState()];
  const simToggle = S.mode === 'sim' ? () => { const ch = S.channel as SimChannel; if (ch.state === 'connected') ch.unplug(); else void ch.plug(); } : undefined;
  return h('div', { class: 'pills', id: 'pills' },
    h(simToggle ? 'button' : 'span', { class: `pill ${cc}`, onclick: simToggle, title: simToggle ? 'Simulator: click to unplug / plug the virtual cable' : S.session ? S.channel?.name ?? '' : preCable.name || 'Connect the cable to the USB port' }, h('span', { class: `led ${cc}` }), ct, simToggle && simDrive && cableState() === 'sim' ? h('small', { class: 'pill-sub' }, simDrive.phaseAt(simDrive.time)) : null),
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
    const ch = mode === 'sim' ? new SimChannel(createE46({ drive: (simDrive = new DriveCycle(0)) })) : cableApi() === 'serial' ? await WebSerialChannel.request() : await WebUsbFtdiChannel.request();
    const iface = new ObdInterface(ch, {
      dtrMode: mode === 'sim' ? 'off' : S.dtrMode,
      onHint: (k) => {
        S.hint = k;
        renderMain();
      },
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
    S.iface = iface;
    S.hint = '';
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
    log('info', `Connected: ${ch.name} · ${S.session.kind === 'native' ? 'plug-and-play mode (no module files)' : `${files.count} module files, plug & play for the rest`}${mode === 'cable' && S.dtrMode === 'kdcan' ? ' · K+DCAN line control on' : ''}`);
    render();
    scan();
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    if (!/No port selected|No device selected|cancel/i.test(m))
      S.connError = cableApi() === 'usb'
        ? `Could not open the cable: ${m}. Unplug the cable and plug it in again, and allow access when Android asks.`
        : `Could not open the cable: ${m}. Close INPA or BMW Scanner if they are using the port.`;
    render();
  }
}

async function disconnect() {
  S.share?.stop();
  S.share = null;
  resetCoding();
  resetVehicle();
  resetChecks();
  if (S.remote) {
    const r = S.remote;
    S.remote = null;
    r.close();
  }
  S.remoteAccess = '';
  stopLive();
  stopLogger();
  resetLogger();
  resetService();
  S.session?.abort();
  if (S.session instanceof NativeSession) S.session.iso.stopKeepAlive();
  if (S.session instanceof HybridSession) S.session.native.iso.stopKeepAlive();
  (S.channel as unknown as { dispose?: () => void } | null)?.dispose?.();
  await S.channel?.close().catch(() => undefined);
  S.session = null;
  S.channel = null;
  S.iface = null;
  S.mode = null;
  S.mods.clear();
  S.selected = null;
  S.page = 'overview';
  render();
}

const cableOk = () => (S.mode === 'remote' ? !!S.remote?.open : !!S.channel?.isOpen);

// ------------------------------------------------------------------ remote session
function openRemote() {
  openRemoteDialog({
    carSession: () => (S.mode === 'cable' || S.mode === 'sim' ? S.session : null),
    app: __APP_VERSION__,
    carTitle,
    cachedScan: () => ALL_E46_MODULES.map((m) => S.mods.get(m.group)?.scan).filter((e): e is ScanEntry => !!e),
    sharing: () => S.share,
    approve: async (a) => {
      log('info', `Remote helper asks: ${a.title} (${a.detail})`);
      const ok = await approvalDialog(a);
      if (ok && (a.kind === 'test' || a.kind === 'reset') && S.session && S.session.safetyMode !== 'service') {
        S.session.safetyMode = 'service';
        renderRail();
      }
      log(ok ? 'info' : 'tx', `${ok ? 'Allowed' : 'Refused'}: ${a.title}`);
      return ok;
    },
    onShareStarted: (st) => {
      S.share = st;
      log('info', `Sharing this car with a helper (${st.access === 'read' ? 'read only' : 'read + tests'})`);
      render();
    },
    onShareEnded: (reason) => {
      if (!S.share) return;
      S.share = null;
      log('info', `Remote session ended: ${reason}`);
      render();
    },
    onActivity: (text, refused) => log(refused ? 'tx' : 'info', `Remote: ${text}`),
    onHelperConnected: (session, info) => {
      S.remote = session;
      S.remoteAccess = info.access;
      S.session = session;
      S.channel = null;
      S.iface = null;
      S.mode = 'remote';
      S.offline = '';
      S.mods.clear();
      link.lastAnswer = Date.now();
      log('info', `Connected to a shared car: ${info.car} (${info.access === 'read' ? 'read only' : 'read + tests, approved by the owner'}, app v${info.app})`);
      render();
      void scan();
    },
    onHelperClosed: () => {
      if (S.mode !== 'remote') return;
      log('tx', 'The shared car disconnected');
      void disconnect();
    },
  });
}

async function scan() {
  if (!S.session || S.scanning) return;
  const session = S.session;
  S.scanning = true;
  link.scanStart = Date.now();
  S.mods.clear();
  render();
  await session.scan(S.scanOptional ? ALL_E46_MODULES : E46_MODULES, (e) => {
    modState(e.module.group).scan = e;
    if (!S.live.running) renderMain();
  });
  S.scanning = false;
  render();
  const found = ALL_E46_MODULES.filter((m) => modState(m.group).scan?.variant);
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
const LIVE_RERENDER_MS = 1200;
let liveBuiltAt = 0;

function resetLive() {
  S.live.running = false;
  S.live.paused = false;
  S.live.error = '';
  S.live.store.clear();
  S.live.values = [];
  S.live.hist.clear();
  S.live.sig = '';
  S.live.rate = 0;
  S.live.pass = { done: 0, total: 0 };
}

/** Value groups this module supports, the main data block first (it is read every cycle). */
function liveJobs(st: ModState): string[] {
  const avail = st.avail;
  const jobs = (st.jobs ?? [])
    .filter((j) => isLiveGroup(j) && !isHiddenByEquipment(j.name, avail?.equipment) && (!avail || avail.jobs.includes(j.name)))
    .map((j) => j.name);
  const main = jobs.find((j) => /MESSWERTEBLOCK|MESSWERTE$/.test(j)) ?? jobs.find((j) => j === 'STATUS_IO_LESEN');
  return main ? [main, ...jobs.filter((j) => j !== main)] : jobs;
}

/** Adds one read to the merged list. A value another group already reports (same name once the STAT_/STATUS_ prefix is dropped) is not repeated. */
function mergeValues(job: string, values: Value[], equipment: Availability['equipment'] | undefined) {
  const owner = new Map<string, string>();
  for (const [k, { job: j }] of S.live.store) owner.set(sameValueId(k), j);
  for (const v of values) {
    if (isHiddenByEquipment(v.key, equipment)) continue;
    const id = sameValueId(v.key);
    const o = owner.get(id);
    if (o && (o !== job || !S.live.store.has(v.key))) continue;
    owner.set(id, job);
    S.live.store.set(v.key, { v, job });
    if (typeof v.value === 'number') {
      const a = S.live.hist.get(v.key) ?? S.live.hist.set(v.key, []).get(v.key)!;
      a.push(v.value);
      if (a.length > 300) a.shift();
    }
  }
}

const liveSig = (vals: Value[]) => vals.map((v) => v.key).join('|');

async function startLive(group: string) {
  const st = modState(group);
  const variant = st.scan?.variant;
  const session = S.session;
  if (!variant || !session || S.live.running) return;
  const [main, ...rest] = liveJobs(st);
  if (!main) return;
  S.live.running = true;
  S.live.paused = false;
  S.live.error = '';
  S.live.pass = { done: 0, total: rest.length };
  renderMain();
  const failed = new Set<string>();
  let next = 0;
  let n = 0;
  let t0 = Date.now();
  const alive = () => S.live.running && S.selected === group && S.page === 'live' && S.session === session;
  while (alive()) {
    const r = await session.readValues(variant, main);
    if (!alive()) break;
    if (r.error && !cableOk()) {
      // cable pulled: pause and resume by itself when it is plugged back in
      document.querySelector('#live-msg')?.replaceChildren(h('div', { class: 'msg warn' }, 'Cable unplugged. Reading is paused and continues as soon as the cable is plugged back in.'));
      while (alive() && !cableOk()) await new Promise((res) => setTimeout(res, 400));
      document.querySelector('#live-msg')?.replaceChildren();
      continue;
    }
    if (r.error) {
      S.live.error = `Reading stopped: ${r.error}`;
      break;
    }
    mergeValues(main, r.values, st.avail?.equipment);
    // the other groups: all of them every cycle when there are few, otherwise one per cycle in turn
    const todo = rest.length <= 3 ? rest.filter((j) => !failed.has(j)) : [];
    if (rest.length > 3) {
      for (let i = 0; i < rest.length; i++) {
        const j = rest[next % rest.length];
        next++;
        if (!failed.has(j)) { todo.push(j); break; }
      }
    }
    for (const job of todo) {
      const r2 = await session.readValues(variant, job);
      if (!alive()) break;
      if (r2.error || !r2.values.length) { if (cableOk()) failed.add(job); continue; }
      mergeValues(job, r2.values, st.avail?.equipment);
    }
    S.live.pass.done = rest.length <= 3 ? rest.length : Math.min(rest.length, next);
    S.live.values = [...S.live.store.values()].map((e) => e.v);
    if (S.live.rec) S.live.rec.push({ t: new Date().toISOString(), vals: new Map(S.live.values.map((v) => [v.key, v.value])) });
    n++;
    if (Date.now() - t0 > 2000) {
      S.live.rate = (n * 1000) / (Date.now() - t0);
      n = 0;
      t0 = Date.now();
    }
    if (liveSig(S.live.values) !== S.live.sig && (!S.live.sig || Date.now() - liveBuiltAt > LIVE_RERENDER_MS)) renderMain();
    else updateLive();
  }
  S.live.running = false;
  renderMain();
}
function stopLive() {
  S.live.running = false;
}
function pauseLive() {
  S.live.paused = true;
  S.live.running = false;
  renderMain();
}
function resumeLive(group: string) {
  S.live.paused = false;
  S.live.error = '';
  void startLive(group);
}
function toggleRecord() {
  if (S.live.rec) {
    const keys = [...S.live.store.keys()];
    const head = keys.map((k) => { const v = S.live.store.get(k)!.v; return `${v.label}${v.unit && v.unit !== '-' ? ` (${v.unit})` : ''}`; });
    const rows = [['time', ...head], ...S.live.rec.map((r) => [r.t, ...keys.map((k) => String(r.vals.get(k) ?? ''))])];
    const csv = rows.map((r) => r.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const mod = S.selected ? moduleDef(S.selected).short.toLowerCase() : 'live';
    h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `e46-${mod}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` }).click();
    S.live.rec = null;
  } else S.live.rec = [];
  renderMain();
}

const fmt = (v: number | string | undefined) => (v === undefined ? '—' : typeof v === 'number' ? formatNumber(v) : v);
const unitText = (u: string) => (u === '-' ? '' : u);
const pctOf = (x: number, min: number, max: number) => Math.max(0, Math.min(100, ((x - min) / (max - min || 1)) * 100));

/** Up to 4 numbers for the chart: the module's key metrics first. */
function chartKeys(variant: string): string[] {
  const nums = visibleValues(S.live.values).filter((v) => kindOf(v) === 'num');
  const want = KEY_METRICS[variant.toLowerCase()] ?? [];
  const keys: string[] = [];
  for (const b of want) { const v = nums.find((x) => baseKey(x.key) === b); if (v) keys.push(v.key); }
  for (const v of nums) if (!keys.includes(v.key)) keys.push(v.key);
  return keys.slice(0, 4);
}

// ---- cards
function numCard(v: Value) {
  return h('div', { class: 'lv-card', 'data-k': v.key },
    h('div', { class: 'lv-top' }, h('span', { class: 'lv-label' }, v.label), h('span', { class: 'lv-val' }, h('b', {}), h('small', {}, unitText(v.unit)))),
    h('div', { class: 'lv-bar' }, h('span', { class: 'lv-band' }), h('span', { class: 'lv-mark' })),
    h('div', { class: 'lv-foot' }, h('span', { class: 'lv-min' }), h('span', { class: 'lv-ref' }), h('span', { class: 'lv-max' })),
  );
}
function refText(state: RefState, ref: Reference | undefined) {
  if (!ref || (ref.lo === undefined && ref.hi === undefined)) return 'no reference';
  const r = ref.lo !== undefined && ref.hi !== undefined ? `${formatNumber(ref.lo)} – ${formatNumber(ref.hi)}` : ref.hi !== undefined ? `≤ ${formatNumber(ref.hi)}` : `≥ ${formatNumber(ref.lo!)}`;
  const idle = ref.idleOnly ? ' at idle' : '';
  if (state === 'high') return `ABOVE ref ${r}`;
  if (state === 'low') return `BELOW ref ${r}`;
  if (state === 'cold') return `warming up · ref ${r}`;
  return `ref ${r}${idle}`;
}
function updateCard(el: Element, v: Value, ctx: EngineContext) {
  const { state, ref } = evaluate(v.key, v.value, ctx, v.unit);
  const num = typeof v.value === 'number' ? v.value : NaN;
  const sc = barScale(v, S.live.hist.get(v.key));
  el.className = `lv-card ${state}`;
  el.setAttribute('title', `${ref?.note ? `${ref.note}\n` : ''}${v.key}`);
  el.querySelector('.lv-val b')!.textContent = fmt(v.value);
  const band = el.querySelector<HTMLElement>('.lv-band')!;
  if (ref && (ref.lo !== undefined || ref.hi !== undefined)) {
    const a = pctOf(ref.lo ?? sc.min, sc.min, sc.max);
    const b = pctOf(ref.hi ?? sc.max, sc.min, sc.max);
    band.style.cssText = `left:${a}%;width:${Math.max(0, b - a)}%`;
  } else band.style.cssText = 'display:none';
  (el.querySelector('.lv-mark') as HTMLElement).style.left = `${Number.isNaN(num) ? 0 : pctOf(num, sc.min, sc.max)}%`;
  el.querySelector('.lv-min')!.textContent = formatNumber(sc.min);
  el.querySelector('.lv-max')!.textContent = formatNumber(sc.max);
  el.querySelector('.lv-ref')!.textContent = refText(state, ref);
}
function stateBox(v: Value) {
  return h('div', { class: 'lv-state', 'data-s': v.key, title: v.key }, h('span', { class: 'lv-label' }, v.label), h('b', {}));
}
function updateStateBox(el: Element, v: Value) {
  const flag = isFlag(v);
  const off = flag && !v.value;
  el.className = `lv-state ${off ? 'off' : ''}`;
  el.querySelector('b')!.textContent = flag ? (v.value ? 'On' : 'Off') : `${fmt(v.value)}${unitText(v.unit) ? ` ${v.unit}` : ''}`;
}

// ---- instrument panel (an original design: rev counter, centre readout, two temperature columns)
function tachoSvg(lo: number, hi: number, max: number) {
  const c = 160;
  const pt = (f: number, r: number) => { const a = ((135 + 270 * f) * Math.PI) / 180; return [c + r * Math.cos(a), c + r * Math.sin(a)].map((x) => x.toFixed(1)).join(' '); };
  const arc = (f1: number, f2: number, r: number) => `M ${pt(f1, r)} A ${r} ${r} 0 ${(f2 - f1) * 270 > 180 ? 1 : 0} 1 ${pt(f2, r)}`;
  let minor = '';
  let major = '';
  let labels = '';
  for (let x = 0; x <= max; x += 500) {
    const f = x / max;
    if (x % 1000 === 0) {
      major += `M ${pt(f, 140)} L ${pt(f, 118)} `;
      const [lx, ly] = pt(f, 96).split(' ');
      labels += `<text x="${lx}" y="${ly}" class="${x >= hi ? 'red' : ''}">${x / 1000}</text>`;
    } else minor += `M ${pt(f, 140)} L ${pt(f, 128)} `;
  }
  return `<svg viewBox="0 0 320 320" class="lv-tacho-svg" aria-hidden="true">
    <circle cx="160" cy="160" r="152" class="face"/>
    <path d="${arc(lo / max, Math.min(hi, max) / max, 146)}" class="band"/>
    ${hi < max ? `<path d="${arc(hi / max, 1, 146)}" class="redzone"/>` : ''}
    <path d="${minor}" class="minor"/><path d="${major}" class="major"/>
    <g class="labels">${labels}</g>
    <text x="160" y="206" class="cap">RPM ×1000</text>
    <text x="160" y="254" class="val">—</text>
    <line x1="160" y1="160" x2="160" y2="40" class="lv-needle"/>
    <circle cx="160" cy="160" r="16" class="hub"/>
  </svg>`;
}
function renderPanel(p: PanelPick, byKey: Map<string, Value>) {
  const parts: Node[] = [];
  if (p.tacho) {
    const ref = referenceFor(p.tacho);
    const hi = ref?.hi ?? 6500;
    const max = Math.ceil((hi + 500) / 1000) * 1000;
    const t = h('div', { class: 'lv-tacho', 'data-p': p.tacho, 'data-pt': 'tacho', 'data-max': String(max), 'data-hi': String(hi), role: 'img', 'aria-label': 'Engine speed' });
    t.innerHTML = tachoSvg(ref?.lo ?? 600, hi, max);
    parts.push(t);
  }
  const lcdItem = (key: string, label: string) => {
    const v = byKey.get(key);
    return h('div', { class: 'lv-lcd-item' }, h('span', {}, label), h('b', { 'data-p': key, 'data-pt': 'num' }, '—', h('small', {}, unitText(v?.unit ?? ''))));
  };
  if (p.speed || p.gear || p.readout.length) {
    parts.push(h('div', { class: 'lv-lcd' },
      p.speed ? h('div', { class: 'lv-lcd-row big' }, h('span', {}, 'SPEED'), h('b', { 'data-p': p.speed, 'data-pt': 'num' }, '—', h('small', {}, unitText(byKey.get(p.speed)?.unit ?? '')))) : null,
      p.gear ? h('div', { class: 'lv-lcd-row' }, h('span', {}, 'GEAR'), h('b', { 'data-p': p.gear, 'data-pt': 'text' }, '—')) : null,
      (p.speed || p.gear) && p.readout.length ? h('hr', {}) : null,
      p.readout.length ? h('div', { class: 'lv-lcd-grid' }, p.readout.map((r) => lcdItem(r.key, r.label))) : null,
    ));
  }
  if (p.bars.length) {
    parts.push(h('div', { class: 'lv-cols' }, p.bars.map((b) => {
      const ref = referenceFor(b.key);
      const band = ref?.lo !== undefined || ref?.hi !== undefined
        ? `bottom:${pctOf(ref?.lo ?? b.min, b.min, b.max)}%;height:${pctOf(ref?.hi ?? b.max, b.min, b.max) - pctOf(ref?.lo ?? b.min, b.min, b.max)}%`
        : 'display:none';
      return h('div', { class: 'lv-col', 'data-p': b.key, 'data-pt': 'bar', 'data-min': String(b.min), 'data-max': String(b.max) },
        h('span', { class: 'lv-col-label' }, b.label),
        h('div', { class: 'lv-col-track' }, h('span', { class: 'lv-col-band', style: band }), h('span', { class: 'lv-col-fill' }), h('i', { class: 'lv-col-max' }, formatNumber(b.max)), h('i', { class: 'lv-col-min' }, formatNumber(b.min))),
        h('b', {}, '—', h('small', {}, ` ${unitText(byKey.get(b.key)?.unit ?? '')}`)));
    })));
  }
  return h('section', { class: 'lv-panel', 'aria-label': 'Instrument panel' }, parts);
}
function updatePanel(root: Element, byKey: Map<string, Value>, ctx: EngineContext) {
  root.querySelectorAll<HTMLElement>('.lv-panel [data-p]').forEach((el) => {
    const v = byKey.get(el.dataset.p!);
    if (!v) return;
    const { state } = evaluate(v.key, v.value, ctx, v.unit);
    const num = typeof v.value === 'number' ? v.value : NaN;
    el.classList.toggle('bad', state === 'low' || state === 'high');
    const type = el.dataset.pt;
    if (type === 'tacho') {
      const max = Number(el.dataset.max);
      const f = Number.isNaN(num) ? 0 : Math.max(0, Math.min(1, num / max));
      el.querySelector<SVGElement>('.lv-needle')!.style.transform = `rotate(${-135 + 270 * f}deg)`;
      el.querySelector('.val')!.textContent = fmt(v.value);
      el.classList.toggle('redline', num >= Number(el.dataset.hi));
      el.setAttribute('aria-label', `Engine speed ${fmt(v.value)} rpm`);
    } else if (type === 'bar') {
      const min = Number(el.dataset.min);
      const max = Number(el.dataset.max);
      (el.querySelector('.lv-col-fill') as HTMLElement).style.height = `${Number.isNaN(num) ? 0 : pctOf(num, min, max)}%`;
      el.querySelector('b')!.firstChild!.textContent = fmt(v.value);
    } else if (type === 'text') {
      el.textContent = fmt(v.value);
    } else {
      el.firstChild!.textContent = fmt(v.value);
    }
  });
}

function updateLive() {
  const root = document.querySelector('.lv');
  if (!root) return;
  const byKey = new Map(S.live.values.map((v) => [v.key, v]));
  const ctx = engineContext(S.live.values);
  root.querySelectorAll('[data-k]').forEach((el) => { const v = byKey.get(el.getAttribute('data-k')!); if (v) updateCard(el, v, ctx); });
  root.querySelectorAll('[data-s]').forEach((el) => { const v = byKey.get(el.getAttribute('data-s')!); if (v) updateStateBox(el, v); });
  updatePanel(root, byKey, ctx);
  const variant = S.selected ? modState(S.selected).scan?.variant ?? '' : '';
  const chart = document.querySelector<HTMLCanvasElement>('.chart canvas');
  if (chart) drawChart(chart, chartKeys(variant).map((k, i) => ({ data: S.live.hist.get(k) ?? [], color: COLORS[i] })));
  const out = visibleValues(S.live.values).filter((v) => { const s = evaluate(v.key, v.value, ctx, v.unit).state; return s === 'low' || s === 'high'; }).length;
  const status = document.querySelector('#live-status');
  if (status) {
    const n = visibleValues(S.live.values).length;
    status.replaceChildren(
      h('span', { class: `led ${S.live.running ? 'live' : ''}` }),
      S.live.running ? `Live · ${S.live.rate ? `${S.live.rate.toFixed(1)} reads/s · ` : ''}${n} values` : `${S.live.paused ? 'Paused' : 'Stopped'} · ${n} values`,
      S.live.rec ? h('span', { class: 'rec-note' }, ` · recording, ${S.live.rec.length} rows`) : '',
      h('span', { class: out ? 'bad' : '' }, ` · ${ctx.running === false ? 'engine off' : ctx.idle ? 'warm idle' : 'idle-only checks paused'} · ${out ? `${out} out of range` : 'all checked values in range'}`),
    );
  }
  const pass = document.querySelector('#live-pass');
  if (pass) {
    const p = S.live.pass;
    pass.textContent = p.total > 3 && p.done < p.total && S.live.running ? `Reading the other value groups for the first time… ${p.done}/${p.total}` : '';
  }
}

// ------------------------------------------------------------------ rendering
/** Bar at the bottom of every screen: version, author, AI note. */
function renderAppBar() {
  return h('footer', { class: 'appbar' },
    h('span', { class: 'appbar-mark', 'aria-hidden': 'true' }),
    h('span', {}, h('b', {}, 'E46Fanatics Scan'), ` v${__APP_VERSION__}`, h('small', {}, ` · build ${__APP_BUILD__}`)),
    h('span', { class: 'appbar-sep', 'aria-hidden': 'true' }),
    h('span', {}, 'Developed by ', h('b', {}, 'Fabricio Guimarães')),
    h('span', { class: 'appbar-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'appbar-ai' }, 'Built with artificial intelligence'),
  );
}

function render() {
  const top = renderTop();
  if (!S.session) {
    if (S.offline) {
      const back = () => { S.offline = ''; render(); };
      const page = S.offline === 'garage' ? renderGarage(ctx, true, back) : renderLibrary(null, back, render);
      app.replaceChildren(top, h('div', { class: 'layout single' }, h('main', {}, ...nodes(page))), renderAppBar());
      return;
    }
    app.replaceChildren(top, liquidBackdrop(), renderSetup(), renderLog(), renderAppBar());
    return;
  }
  app.replaceChildren(top, h('div', { class: 'layout' }, h('nav', { class: 'rail', 'aria-label': 'Sections' }), h('main', {})), renderAppBar());
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
    S.session && S.mods.size ? h('div', { class: 'car' }, h('b', {}, carTitle()), h('small', {}, carSummary())) : null,
    statusPills(),
    h('button', { class: `btn ghost ${S.share ? 'sharing' : ''}`, onclick: openRemote, title: 'Share this car with a friend, or read the car of a friend' }, S.share ? 'Sharing car…' : S.mode === 'remote' ? 'Remote session' : 'Remote session'),
    h('button', { class: 'btn ghost', onclick: openReport, title: 'Save a file that explains a problem: app version, what was done and the last telegrams (VIN masked)' }, 'Report a problem'),
    S.session ? h('button', { class: 'btn ghost', onclick: disconnect }, 'Disconnect') : null,
  );
}

// ------------------------------------------------------------------ cable options, hints, problem report
function setDtrMode(m: DtrMode) {
  S.dtrMode = m;
  store.set('e46diag.dtrMode', m);
  if (S.iface && S.mode === 'cable') S.iface.dtrMode = m;
  log('info', m === 'kdcan' ? 'K+DCAN line control on: DTR is raised while sending on the K-line' : 'K+DCAN line control off: DTR and RTS stay low');
}

function cableOptions() {
  return h('details', { class: 'cable-opts' },
    h('summary', {}, 'Cable options'),
    h('label', { class: 'opt' },
      h('input', { type: 'checkbox', checked: S.dtrMode === 'kdcan', onchange: (e: Event) => { setDtrMode((e.target as HTMLInputElement).checked ? 'kdcan' : 'off'); render(); } }),
      h('span', {}, h('b', {}, 'K+DCAN line control (DTR)'), h('small', {}, 'Raises DTR while sending, the way EDIABAS drives K+DCAN cables. Try it only if no module answers with the cable switch in the right position; leave it off when the car already reads.'))),
  );
}

function renderHint() {
  if (S.hint !== 'latency') return null;
  return h('div', { class: 'msg warn hint' },
    h('b', {}, 'The cable answers late or garbled. '),
    'On Windows set the FTDI latency timer to 1 ms: Device Manager → Ports → USB Serial Port → Properties → Port Settings → Advanced → Latency Timer. On a Mac the driver usually does it already; try another USB port without a hub. ',
    h('button', { class: 'btn ghost', onclick: () => { S.hint = ''; renderMain(); } }, 'Dismiss'));
}

function reportData(description: string) {
  return buildReport({
    app: __APP_VERSION__,
    build: __APP_BUILD__,
    userAgent: navigator.userAgent,
    platform: (navigator as unknown as { platform?: string }).platform ?? '',
    description,
    page: S.session ? `${S.page}${S.selected ? ` · ${moduleDef(S.selected).short}` : ''}` : 'start',
    cable: S.channel?.name ?? (preCable.present ? preCable.name : 'none'),
    mode: S.mode ?? 'not connected',
    settings: { dtrMode: S.dtrMode, moduleFiles: files.count, safety: S.session?.safetyMode ?? 'read' },
    log: S.log,
    modules: ALL_E46_MODULES.filter((m) => S.mods.get(m.group)?.scan).map((m) => {
      const st = S.mods.get(m.group)!;
      return { short: m.short, variant: st.scan!.variant, ident: st.scan!.ident, faults: st.dtcs?.length, error: st.scan!.error ?? st.dtcError };
    }),
  });
}

function openReport() {
  const text = h('textarea', { rows: 4, placeholder: 'What happened? Which module, what did you press, what did you expect?', 'aria-label': 'Problem description', class: 'dlg-input' });
  const status = h('p', { class: 'note' });
  const close = () => d.close();
  const d = h('dialog', { class: 'report-dlg' },
    h('h2', {}, 'Report a problem'),
    h('p', {}, 'Saves a file with the app version, your browser, the screens and jobs of this session and the last telegrams on the K-line. The VIN is masked. Nothing is sent: attach the file to your post or message.'),
    text,
    status,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: close }, 'Close'),
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(reportData(text.value), null, 1)); status.textContent = 'Copied to the clipboard.'; } catch { status.textContent = 'The browser did not allow copying; use Save file.'; } } }, 'Copy'),
      h('button', { class: 'btn primary', onclick: () => { download(`e46-problem-report-${stamp()}.json`, JSON.stringify(reportData(text.value), null, 1), 'application/json'); status.textContent = 'Saved to your downloads.'; } }, 'Save file')),
  );
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', () => d.remove());
  text.focus();
}

/**
 * Phone (Android): there is no launcher to join the modulos folder to the page, so the user picks
 * their own .prg/.grp files once; they stay in this browser only (IndexedDB). Nothing is uploaded.
 */
function phoneModuleFiles() {
  if (files.embedded)
    return h('p', { class: 'start-note' }, `${files.count} module files built into this page.`);
  const input = h('input', { type: 'file', multiple: true, accept: '.prg,.grp,.PRG,.GRP', style: 'display:none' }) as HTMLInputElement;
  input.onchange = async () => {
    if (!input.files?.length) return;
    const n = await files.addFiles(input.files);
    S.connError = n ? '' : 'None of the chosen files is a module file (.prg / .grp).';
    render();
  };
  return h('div', { class: 'start-note' },
    files.count
      ? h('span', {}, `${files.count} module files on this phone. `)
      : h('span', {}, 'No module files on this phone: plug & play mode (engine over OBD-II, every module identified). To read every module, choose your .prg and .grp files once; they stay on this phone. '),
    input,
    h('button', { class: 'btn', onclick: () => input.click() }, files.count ? 'Add files' : 'Choose module files'),
    files.count ? h('button', { class: 'btn', onclick: async () => { await files.clear(); render(); } }, 'Remove') : null,
  );
}

function renderSetup() {
  const api = cableApi();
  const hasSerial = !!api;
  return h('section', { class: 'setup' },
    logo('hero-logo'),
    h('h1', {}, 'BMW E46 diagnostics'),
    h('p', { class: 'lede' }, 'Read and clear fault codes, watch live data and run module tests with your K+DCAN or BMW Scanner cable.'),
    h('div', { class: 'start' },
      h('div', { class: 'start-card' },
        h('h2', {}, 'Connect to the car'),
        h('p', {}, 'Plug the cable into the OBD port and turn the key to position 2. On a K+DCAN cable, use K-line mode with OBD pins 7 and 8 joined (the switch position that does it depends on the cable).'),
        api === 'usb' ? h('p', { class: 'start-note' }, 'Phone: plug the cable in with a USB OTG adapter (USB-A female to USB-C or micro-USB) and allow access when Android asks.') : null,
        api === 'usb' ? phoneModuleFiles() : files.count ? null : h('p', { class: 'start-note' }, 'No module files in the modulos folder: plug & play mode (engine over OBD-II, every module identified).'),
        S.connError ? h('div', { class: 'msg err' }, S.connError) : null,
        !hasSerial ? h('div', { class: 'msg warn' }, 'This browser cannot access USB ports. Use Chrome or Edge on Mac or Windows, or Chrome on Android, to connect the cable. iPhone and iPad cannot use USB cables. The simulator works in any browser.') : null,
        cableOptions(),
        h('button', { class: 'btn primary', disabled: !hasSerial, onclick: () => connect('cable') }, 'Connect cable'),
      ),
      h('div', { class: 'start-card' },
        h('h2', {}, 'Simulator'),
        h('p', {}, 'A simulated 325i on a 6½-minute trip that repeats: key on, cold start, warm-up at idle, city traffic, motorway and a run to top speed, warm idle, engine off.'),
        h('button', { class: 'btn', onclick: () => connect('sim') }, 'Start simulator'),
      ),
      h('div', { class: 'start-card mini' },
        h('h2', {}, 'Garage'),
        h('p', {}, (() => { const g = loadGarage(); const n = g.cars.reduce((k, c) => k + c.scans.length, 0); return g.cars.length ? `${g.cars.length} ${g.cars.length === 1 ? 'car' : 'cars'} and ${n} saved ${n === 1 ? 'scan' : 'scans'}. Look back at past scans and compare them without the car.` : 'Saved cars and their scan history. Scan a car and save it to compare later scans with it.'; })()),
        h('button', { class: 'btn', onclick: () => { S.offline = 'garage'; render(); } }, 'Open garage'),
      ),
      h('div', { class: 'start-card mini' },
        h('h2', {}, 'Docs & Library'),
        h('p', {}, 'How the app works and how to use each screen, the cars and modules it supports, the fault guides, and the diagnostic socket and bus diagrams.'),
        h('button', { class: 'btn', onclick: () => { S.offline = 'library'; render(); } }, 'Open library'),
      ),
      h('div', { class: 'start-card mini' },
        h('h2', {}, 'Remote session'),
        h('p', {}, 'Read the car of a friend from the community: paste the invite code they send you. To share your own car, connect it first and use “Remote session” in the top bar.'),
        h('button', { class: 'btn', onclick: openRemote }, 'Connect to a car'),
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

/** Side menu, in sections: the car, its data, workshop tools, and the rest. */
const SECTIONS: [string, [Page, string][]][] = [
  ['Car', [['overview', 'Overview'], ['vehicle', 'Vehicle'], ['faults', 'Faults']]],
  ['Data', [['live', 'Live Data'], ['logger', 'Data Logger']]],
  ['Workshop', [['checks', 'Guided checks'], ['service', 'Service'], ['functions', 'Tests & Functions'], ['coding', 'Coding']]],
  ['More', [['garage', 'Garage'], ['library', 'Library'], ['log', 'Log']]],
];
const foundModules = () => ALL_E46_MODULES.filter((m) => S.mods.get(m.group)?.scan?.variant);

/** Side menu: sections of the app, safety state at the bottom. */
function renderRail() {
  const rail = document.querySelector('.rail');
  if (!rail) return;
  const faults = foundModules().reduce((n, m) => n + (S.mods.get(m.group)?.dtcs?.length ?? 0), 0);
  const service = S.session?.safetyMode === 'service';
  rail.replaceChildren(...nodes([
    ...SECTIONS.flatMap(([title, pages]) => [
      h('div', { class: 'rail-sep' }, title),
      ...pages.map(([p, label]) =>
        h('button', { class: 'nav', 'aria-current': S.page === p ? 'page' : 'false', onclick: () => go(p) },
          label, p === 'faults' && faults ? h('span', { class: 'count' }, String(faults)) : null)),
    ]),
    S.mode === 'remote'
      ? h('div', { class: 'rail-foot remote' },
          h('span', { class: 'led ok' }),
          h('div', {}, h('b', {}, 'Remote car'), h('small', {}, S.remoteAccess === 'tests' ? 'Read + tests, each approved by the owner' : 'Read only (set by the owner)')))
      : h('div', { class: `rail-foot ${service ? 'unlocked' : ''}` },
          h('span', { class: `led ${service ? 'warn' : 'ok'}` }),
          h('div', {}, h('b', {}, service ? 'Tests & resets unlocked' : 'Read-only mode'), h('small', {}, 'Coding blocked, except the gauge curve'))),
    S.share ? h('div', { class: 'rail-foot sharing' }, h('span', { class: 'led live' }), h('div', {}, h('b', {}, 'Car shared'), h('small', {}, S.share.access === 'read' ? 'Helper: read only' : 'Helper: read + tests'))) : null,
  ]));
}

function go(p: Page) {
  if (p !== 'live') stopLive();
  if (p !== 'logger') stopLogger();
  if (p !== 'checks') stopChecks();
  if (MODULE_PAGES.includes(p) && !S.selected) S.selected = foundModules()[0]?.group ?? null;
  S.page = p;
  renderRail();
  renderMain();
}

function select(g: string) {
  if (S.selected !== g) {
    resetLive();
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
  const missing = ALL_E46_MODULES.filter((m) => S.mods.get(m.group)?.scan && !S.mods.get(m.group)!.scan!.variant).length;
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
  const banner = renderHint() ?? renderRemoteBanner();
  const put = (xs: (Node | null)[]) => main.replaceChildren(...nodes([banner, ...xs]));
  if (S.page === 'overview') return put(renderOverview());
  if (S.page === 'service') return put(renderService(ctx));
  if (S.page === 'coding') return put(renderCoding(ctx));
  if (S.page === 'library') return put(renderLibrary(ctx));
  if (S.page === 'logger') return put(renderLogger(ctx));
  if (S.page === 'garage') return put(renderGarage(ctx));
  if (S.page === 'vehicle') return put(renderVehicle(ctx));
  if (S.page === 'checks') return put(renderChecks(ctx));
  if (S.page === 'log') return put(renderLogPage());
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
    banner,
    renderChips(),
    h('div', { class: 'mh' },
      h('div', {}, h('p', { class: 'kicker' }, `${m.name} · ${variantLabel(st.scan.variant)} · 0x${hex2(m.address)}`), h('h1', {}, `${title} · ${m.short}`)),
      h('dl', { class: 'ident' },
        idItem('BMW part no.', id.ID_BMW_NR), idItem('Hardware', id.ID_HW_NR), idItem('Software', id.ID_SW_NR),
        idItem('Coding index', id.ID_COD_INDEX), idItem('Diag index', id.ID_DIAG_INDEX),
        id.ID_DATUM_KW !== undefined ? idItem('Built (wk/yr)', `${id.ID_DATUM_KW}/${id.ID_DATUM_JAHR}`) : idItem('Date', id.ID_DATUM)),
    ),
    ...(S.page === 'faults' ? renderDtcTab(m) : S.page === 'live' ? renderLiveTab(m) : renderJobsTab(m)),
  ]));
  if (S.page === 'live') updateLive();
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
        : h('div', { class: 'dtcs' }, st.dtcs.map((d) => dtcItem(d, m))),
  ];
}

function dtcItem(d: Dtc, m: ModuleDef) {
  const tags = [d.present === true ? 'Present' : d.present === false ? 'Not present now' : '', d.frequency !== null ? `Seen ${d.frequency}×` : '', d.pcode ?? ''].filter(Boolean);
  return h('details', { class: 'dtc' },
    h('summary', {},
      h('span', { class: 'code' }, dtcCode(d)),
      h('span', { class: 'txt' }, h('b', {}, d.text || 'Fault without description'), d.details.length ? h('span', {}, d.details.join(', ')) : null),
      h('span', { class: 'tags' }, tags.map((t) => h('span', { class: `tag ${t === 'Present' ? 'hot' : ''}` }, t))),
      h('button', { class: 'btn ts-btn', title: 'What this fault means, likely causes, how to check and how to fix', onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); openTroubleshoot(ctx, m, d, dtcCode(d)); } }, 'Troubleshoot'),
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
  const jobs = liveJobs(st);
  // everything is read without choosing: start by itself, unless paused or the module is still being checked
  if (!S.live.running && !S.live.paused && !S.live.error && jobs.length && !st.availProgress && !S.busy && cableOk()) {
    setTimeout(() => { if (S.selected === m.group && S.page === 'live' && !S.live.running) void startLive(m.group); }, 0);
  }
  const toolbar = h('div', { class: 'toolbar lv-toolbar' },
    h('span', { class: 'lv-status', id: 'live-status' }),
    h('span', { class: 'grow' }),
    S.live.running
      ? h('button', { class: 'btn', onclick: pauseLive }, 'Pause')
      : h('button', { class: 'btn primary', disabled: !jobs.length || !!S.busy || !!st.availProgress || !cableOk(), onclick: () => resumeLive(m.group) }, S.live.values.length ? 'Resume' : 'Start'),
    h('button', { class: `btn ${S.live.chart ? 'on' : ''}`, 'aria-pressed': S.live.chart ? 'true' : 'false', disabled: !S.live.values.length, onclick: () => { S.live.chart = !S.live.chart; renderMain(); } }, 'Chart'),
    h('button', { class: `btn ${S.live.rec ? 'rec' : 'rec-idle'}`, disabled: !S.live.running && !S.live.rec, onclick: toggleRecord }, S.live.rec ? 'Stop & save CSV' : 'Record CSV'),
  );
  const availNote = st.availProgress
    ? h('div', { class: 'msg info', 'data-avail': m.group }, `Checking supported data… ${st.availProgress.done}/${st.availProgress.total || '?'}`)
    : avail
      ? h('p', { class: 'availnote' }, `${jobs.length} value ${jobs.length === 1 ? 'group' : 'groups'} supported by this ${m.short}, all read automatically${avail.unavailable.length ? ` · ${avail.unavailable.length} not supported (hidden)` : ''}${hiddenEquipment(avail).length ? ` · not fitted: ${hiddenEquipment(avail).join(', ')}` : ''}.`)
      : null;
  const msg = h('div', { id: 'live-msg' }, S.live.error ? h('div', { class: 'msg err' }, S.live.error) : null);
  const vals = S.live.values;
  S.live.sig = liveSig(vals);
  liveBuiltAt = Date.now();
  if (!vals.length) {
    const why = !jobs.length
      ? 'This module has no live value groups.'
      : st.availProgress
        ? 'Live data starts as soon as the check of supported data is done.'
        : !cableOk()
          ? 'Plug the cable in to read live data.'
          : S.live.running
            ? 'Reading the first values…'
            : 'Press Start to read live data.';
    return [toolbar, availNote, msg, h('div', { class: 'lv' }, h('div', { class: 'empty' }, h('strong', {}, S.live.running ? 'Reading live data' : 'Live data'), why))];
  }
  const byKey = new Map(vals.map((v) => [v.key, v]));
  const variant = st.scan!.variant!;
  const panel = pickPanel(vals);
  const groups = groupValues(vals, variant);
  const ck = S.live.chart ? chartKeys(variant) : [];
  const single = groups.length === 1;
  return [
    toolbar,
    availNote,
    msg,
    h('div', { class: 'lv' },
      panel ? renderPanel(panel, byKey) : null,
      ck.length ? h('div', { class: 'chart' }, h('canvas', {}), h('div', { class: 'legend' }, ck.map((k, i) => h('span', {}, h('i', { style: `background:${COLORS[i]}` }), byKey.get(k)?.label ?? k)))) : null,
      h('p', { class: 'note lv-pass', id: 'live-pass' }),
      groups.map((g) => h('section', { class: 'lv-group' },
        h('div', { class: 'lv-group-head' }, h('h2', {}, single ? 'Values' : g.name), h('span', {}, [g.nums.length ? `${g.nums.length} ${g.nums.length === 1 ? 'reading' : 'readings'}` : '', g.texts.length ? `${g.texts.length} ${g.texts.length === 1 ? 'state' : 'states'}` : ''].filter(Boolean).join(' · '))),
        g.nums.length ? h('div', { class: 'lv-cards' }, g.nums.map(numCard)) : null,
        g.texts.length ? h('div', { class: 'lv-states' }, g.texts.map(stateBox)) : null,
      )),
      m.short === 'DME'
        ? h('p', { class: 'refnote' }, variant === 'native:12'
            ? 'Standard OBD-II values. Normal ranges are typical for a warm E46 petrol engine. Ranges marked “at idle” are only checked at warm idle with the car stopped. Values refresh about once per second: OBD-II on the K-line is slow by design.'
            : 'The blue band is the normal range for a warm M54 with the MS43. Ranges marked “at idle” are only checked at warm idle with the car stopped. Hover a value for details.')
        : h('p', { class: 'refnote' }, 'The blue band is the normal range where one is known. Hover a value for its original name.'),
    ),
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

function renderLogPage(): (Node | null)[] {
  const box = h('div', { class: 'log log-page' }, S.log.map((l) => h('div', { class: l.cls }, l.text)));
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'K-line traffic'), h('h1', {}, 'Communication log'))),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => { void navigator.clipboard?.writeText(S.log.map((l) => l.text).join('\n')); } }, 'Copy log'),
      h('button', { class: 'btn', onclick: () => h('a', { href: URL.createObjectURL(new Blob([S.log.map((l) => l.text).join('\n')], { type: 'text/plain' })), download: `e46-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt` }).click() }, 'Save log'),
      h('button', { class: 'btn', onclick: openReport }, 'Report a problem'),
      h('span', { class: 'note' }, 'If something does not work, send this log or a problem report.')),
    S.mode === 'cable' ? cableOptions() : null,
    box,
  ];
}

function renderOverview(): (Node | null)[] {
  const found = ALL_E46_MODULES.filter((m) => S.mods.get(m.group)?.scan?.variant);
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
      h('button', { class: 'btn', disabled: !found.length || S.scanning || !!S.busy || found.some((m) => S.mods.get(m.group)?.dtcs === undefined && !S.mods.get(m.group)?.dtcNA && !S.mods.get(m.group)?.dtcError), onclick: () => saveCurrentScan(ctx), title: 'Keep this scan in the Garage to compare it later' }, S.busy === 'garage' ? 'Reading VIN…' : 'Save to Garage'),
      h('details', { class: 'more-menu' },
        h('summary', { class: 'btn ghost' }, 'Scan options'),
        h('div', { class: 'more-pop' },
          h('label', { class: 'opt', title: 'Navigation, telephone, steering wheel buttons, seat memory, rain sensor, steering angle sensor, headlight leveling, amplifier, CD changer…' },
            h('input', { type: 'checkbox', checked: S.scanOptional, disabled: S.scanning, onchange: (e: Event) => { S.scanOptional = (e.target as HTMLInputElement).checked; store.set('e46diag.scanOptional', S.scanOptional); if (S.scanOptional) void scan(); else renderMain(); } }),
            h('span', {}, h('b', {}, 'Include optional modules'), h('small', {}, 'Navigation, phone, seats, rain sensor… Each module that is not fitted adds about 2 s to the scan.'))),
          h('button', { class: 'btn', disabled: !found.length || found.some((m) => S.mods.get(m.group)?.availProgress), onclick: async () => { for (const m of found) await checkAvailability(m.group, true); } }, 'Re-check supported data'),
          h('button', { class: 'btn', disabled: S.scanning, onclick: () => void scan() }, 'Scan again'))),
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

// ------------------------------------------------------------------ context for the Garage, Data Logger and Service screens
const ctx: PageCtx = {
  session: () => S.session,
  mode: () => S.mode,
  scanning: () => S.scanning,
  found: () => foundModules().map((m) => ({ def: m, ...S.mods.get(m.group)! })),
  jobs: async (group) => {
    const st = modState(group);
    if (!st.jobs && S.session && st.scan?.variant) st.jobs = await S.session.listJobs(st.scan.variant);
    return st.jobs ?? [];
  },
  liveJobs: (group) => liveJobs(modState(group)),
  cableOk,
  isService: () => S.session?.safetyMode === 'service',
  unlockService,
  stopLive,
  busy: () => !!S.busy || S.scanning,
  setBusy: (b) => {
    S.busy = b;
  },
  carTitle,
  log,
  rerender: () => {
    if (S.session) renderAll();
    else render();
  },
  readAllFaults: async () => {
    for (const m of foundModules()) await readDtcs(m.group, false);
  },
  goLive: (short) => {
    const m = foundModules().find((x) => x.short === short);
    if (!m) return;
    select(m.group);
    go('live');
  },
  goPage: (page) => go(page as Page),
};

/** Top of every screen while a remote session runs (owner: who is reading; helper: whose car this is). */
function renderRemoteBanner() {
  if (S.share)
    return h('div', { class: 'msg info rm-banner' }, h('span', { class: 'led live' }),
      h('span', {}, h('b', {}, 'Your car is shared. '), `${S.share.access === 'read' ? 'The helper can read faults and live data.' : 'The helper can read, and ask you to run tests.'} Clearing faults and tests ask you first. ${S.share.host.requests} requests.`),
      h('button', { class: 'btn', onclick: () => S.share?.stop() }, 'Stop sharing'));
  if (S.mode === 'remote')
    return h('div', { class: 'msg info rm-banner' }, h('span', { class: 'led ok' }),
      h('span', {}, h('b', {}, 'Remote car. '), `You are reading a car shared by its owner (${S.remoteAccess === 'tests' ? 'read + tests: the owner approves each test and fault clearing' : 'read only; clearing faults asks the owner'}). Each reading crosses the internet, so live data is slower than at the car.`),
      h('button', { class: 'btn', onclick: disconnect }, 'Leave'));
  return null;
}

// ------------------------------------------------------------------ boot
document.documentElement.lang = 'en';
document.title = 'E46Fanatics Scan';
files
  .loadEmbedded()
  .catch(() => 0)
  // phones have no launcher: their module files live in IndexedDB
  .then((n) => (n || cableApi() !== 'usb' ? n : files.restore()))
  .then(() => render())
  .then(() =>
    (cableApi() === 'usb' ? watchUsbCable : watchCable)((present, name) => {
      preCable = { present, name };
      updatePills();
    }),
  );
