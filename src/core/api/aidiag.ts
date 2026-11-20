// AI Diagnosis: a lean, fast reading of the values that point at faults (engine, gearbox, ABS), a rolling
// recording of the last 60 minutes, a guided test drive, simple live alerts and the files an AI needs to
// analyse the car (see aiexport.ts). Read-only: it only runs value groups that Live Data may run.
// No DOM here: the screen is src/web/aiDiagPage.ts, the IndexedDB copy src/web/aiStore.ts.

import type { Dtc, Value } from './DiagSession';
import { baseKey } from './reference';
import { Frame, METRIC, METRICS, snapshot, Snapshot } from './telemetry';

export const WINDOW_MS = 60 * 60 * 1000;

// ------------------------------------------------------------------ what to read and how often
export type AiMod = 'DME' | 'EGS' | 'ABS';
export interface Channel {
  mod: AiMod;
  variant: string;
  job: string;
  /** 0 = every cycle; otherwise the time between two reads */
  periodMs: number;
}

/** DME groups worth reading now and then besides the data block (VANOS, mixture adaptations, O2 sensors, ignition). */
const DME_SIDE = /VANOS_NW_LAGE|LAMBDA_(ADD|MUL)|ADAPT.*(LAMBDA|GEMISCH)|L_SONDE|ZUEND|KLOPF|LAUFUNRUHE|ANSAUG|LEERLAUF|DROSSEL|LUFTMASSE/;
/** ABS/DSC group with the wheel speeds. */
const ABS_WHEELS = /RAD|GESCHW|DREHZAHL|SPEED/;

export interface ModJobs {
  mod: AiMod;
  variant: string;
  /** live groups of the module, main data block first (PageCtx.liveJobs) */
  jobs: string[];
}

/**
 * The reading plan: the DME data block every cycle, the gearbox block about 4× a second, the slower DME
 * groups in turn every few seconds and the wheel speeds every 5 s. The K-line is serial, so every extra
 * group costs engine readings: keep this list short.
 */
export function planChannels(mods: ModJobs[]): Channel[] {
  const out: Channel[] = [];
  for (const m of mods) {
    if (!m.jobs.length) continue;
    if (m.mod === 'DME') {
      out.push({ mod: 'DME', variant: m.variant, job: m.jobs[0], periodMs: 0 });
      for (const j of m.jobs.slice(1).filter((j) => DME_SIDE.test(j.toUpperCase())).slice(0, 8)) out.push({ mod: 'DME', variant: m.variant, job: j, periodMs: 4000 });
    } else if (m.mod === 'EGS') {
      out.push({ mod: 'EGS', variant: m.variant, job: m.jobs[0], periodMs: 250 });
    } else {
      const j = m.jobs.find((x) => ABS_WHEELS.test(x.toUpperCase())) ?? m.jobs[0];
      out.push({ mod: 'ABS', variant: m.variant, job: j, periodMs: 5000 });
    }
  }
  // the engine block first: it is the base of every recorded row
  return out.sort((a, b) => (a.periodMs === 0 && a.mod === 'DME' ? -1 : b.periodMs === 0 && b.mod === 'DME' ? 1 : 0));
}

/** Picks what to read in one cycle: the every-cycle groups and at most one other group that is due (the most overdue). */
export class Scheduler {
  private last = new Map<number, number>();
  constructor(readonly channels: Channel[]) {}
  next(now: number): number[] {
    const out: number[] = [];
    let best = -1, late = -Infinity;
    this.channels.forEach((c, i) => {
      if (c.periodMs === 0) return void out.push(i);
      const over = now - (this.last.get(i) ?? -Infinity) - c.periodMs;
      if (over >= 0 && over > late) {
        late = over;
        best = i;
      }
    });
    if (best >= 0) out.push(best);
    return out;
  }
  done(i: number, now: number) {
    this.last.set(i, now);
  }
}

// ------------------------------------------------------------------ driving condition of a row
export type Cond = 'cold' | 'idle' | 'cruise' | 'high_load' | 'overrun' | 'other';
export const CONDS: Cond[] = ['cold', 'idle', 'cruise', 'high_load', 'overrun', 'other'];
export const COND_TEXT: Record<Cond, string> = {
  cold: 'engine below 70 °C (any driving)',
  idle: 'warm, stopped (speed < 3 km/h, rpm < 1300)',
  cruise: 'warm, moving above 20 km/h with part throttle (pedal 3–60 %)',
  high_load: 'warm, pedal 60 % or more',
  overrun: 'warm, pedal released above 20 km/h (coasting, fuel cut possible)',
  other: 'warm, anything else (pulling away, slow manoeuvring)',
};

export function condition(v: Snapshot['v']): Cond {
  const { ect, speed, rpm, pedal } = v;
  if (ect !== undefined && ect < 70) return 'cold';
  const sp = speed ?? 0;
  if (sp < 3 && (rpm ?? 0) < 1300) return 'idle';
  if (pedal !== undefined && pedal >= 60) return 'high_load';
  if (sp > 20 && pedal !== undefined && pedal < 3) return 'overrun';
  if (sp > 20 && (pedal === undefined || pedal < 60)) return 'cruise';
  return 'other';
}

// ------------------------------------------------------------------ guided test drive
export interface StepDef {
  id: string;
  title: string;
  how: string;
  /** seconds the condition must hold (counted only while it holds) */
  needS: number;
  /** true while the step's condition is met */
  ok: (v: Snapshot['v']) => boolean;
  /** done at once when this is true (e.g. the engine is already warm) */
  doneIf?: (v: Snapshot['v']) => boolean;
  driving?: boolean;
}
const idle = (v: Snapshot['v']) => (v.speed ?? 0) < 3 && (v.rpm ?? 0) > 400 && (v.rpm ?? 0) < 1300;
export const STEPS: StepDef[] = [
  { id: 'warmup', title: 'Warm-up', how: 'Start the engine and let it idle or drive gently until the coolant reaches 80 °C. If it is already warm this step finishes by itself.', needS: 1, ok: (v) => (v.ect ?? 0) >= 80, doneIf: (v) => (v.ect ?? 0) >= 80 },
  { id: 'idle', title: 'Warm idle', how: 'Selector in P or N, A/C and blower off, lights off. Do not touch the pedal for 2 minutes.', needS: 120, ok: idle },
  { id: 'idle_load', title: 'Idle with load', how: 'Still stopped: A/C on, blower on full, headlights on, rear window heater on. Turn the steering wheel lock to lock once. 1 minute.', needS: 60, ok: idle },
  { id: 'cruise', title: 'Steady cruise', how: 'Drive at a steady 60–100 km/h with a light, constant pedal for 2 minutes in total.', needS: 120, ok: (v) => (v.speed ?? 0) >= 50 && (v.speed ?? 0) <= 115 && (v.pedal === undefined || (v.pedal > 2 && v.pedal < 60)), driving: true },
  { id: 'wot', title: 'Full acceleration', how: 'Only where it is safe and legal: from about 30 km/h press the pedal fully (kickdown) up to about 100 km/h or 5000 rpm.', needS: 3, ok: (v) => (v.pedal ?? 0) >= 85 || (v.rpm ?? 0) >= 4800, driving: true },
  { id: 'overrun', title: 'Coast down', how: 'From 60 km/h or more, lift off completely and let the car slow down to about 20 km/h without braking hard (fuel cut).', needS: 12, ok: (v) => (v.speed ?? 0) > 22 && (v.pedal === undefined ? false : v.pedal < 3), driving: true },
  { id: 'hot_idle', title: 'Hot idle', how: 'Stop safely, selector in P or N, and let it idle for 1 minute (heat soak after the drive).', needS: 60, ok: idle },
];

export type StepState = 'todo' | 'active' | 'done' | 'skipped';
export class GuidedTest {
  state: StepState[] = STEPS.map(() => 'todo');
  held: number[] = STEPS.map(() => 0);
  /** index of the active step, -1 = test not running */
  cur = -1;
  private lastT = 0;
  get running() {
    return this.cur >= 0;
  }
  /** id written into each recorded row */
  get phase() {
    return this.cur >= 0 ? STEPS[this.cur].id : 'free';
  }
  start(): string[] {
    this.state = STEPS.map(() => 'todo');
    this.held = STEPS.map(() => 0);
    this.lastT = 0;
    return this.goTo(0);
  }
  stop(): string[] {
    if (this.cur < 0) return [];
    const id = STEPS[this.cur].id;
    if (this.state[this.cur] === 'active') this.state[this.cur] = 'todo';
    this.cur = -1;
    return [`guided test stopped at "${id}"`];
  }
  skip(): string[] {
    if (this.cur < 0) return [];
    this.state[this.cur] = 'skipped';
    return [`step "${STEPS[this.cur].id}" skipped`, ...this.goTo(this.cur + 1)];
  }
  /** the user says the step is done (e.g. the condition cannot be detected on this connection) */
  finish(): string[] {
    if (this.cur < 0) return [];
    this.state[this.cur] = 'done';
    return [`step "${STEPS[this.cur].id}" marked done by the user`, ...this.goTo(this.cur + 1)];
  }
  private goTo(i: number): string[] {
    while (i < STEPS.length && this.state[i] !== 'todo') i++;
    if (i >= STEPS.length) {
      this.cur = -1;
      return ['guided test finished'];
    }
    this.cur = i;
    this.state[i] = 'active';
    this.lastT = 0;
    return [`step "${STEPS[i].id}" started`];
  }
  /** feeds one reading; returns event texts (step changes) */
  update(t: number, v: Snapshot['v']): string[] {
    if (this.cur < 0) return [];
    const s = STEPS[this.cur];
    const dt = this.lastT ? Math.min(2, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    if (s.doneIf?.(v)) this.held[this.cur] = s.needS;
    else if (s.ok(v)) this.held[this.cur] += dt;
    if (this.held[this.cur] >= s.needS) {
      this.state[this.cur] = 'done';
      return [`step "${s.id}" done`, ...this.goTo(this.cur + 1)];
    }
    return [];
  }
  progress(i: number) {
    return Math.min(1, this.held[i] / STEPS[i].needS);
  }
}

// ------------------------------------------------------------------ live alerts (simple rules, the AI goes deeper)
export interface AlertRule {
  id: string;
  text: (x: number) => string;
  /** value checked, undefined = rule does not apply now */
  value: (v: Snapshot['v'], c: Cond) => number | undefined;
  bad: (x: number) => boolean;
  /** seconds the value must stay bad */
  holdS: number;
}
const warmAndRunning = (v: Snapshot['v'], c: Cond) => c !== 'cold' && (v.rpm ?? 0) > 400;
export const ALERTS: AlertRule[] = [
  { id: 'ect_high', text: (x) => `Coolant high: ${x.toFixed(0)} °C`, value: (v) => v.ect, bad: (x) => x > 112, holdS: 5 },
  { id: 'rad_high', text: (x) => `Radiator outlet high: ${x.toFixed(0)} °C`, value: (v) => v.rad, bad: (x) => x > 113, holdS: 5 },
  { id: 'warmup_slow', text: (x) => `Coolant only ${x.toFixed(0)} °C after 15 min running (thermostat stuck open?)`, value: () => undefined, bad: () => false, holdS: 0 },
  { id: 'stft1', text: (x) => `Short-term fuel trim bank 1 at ${x > 0 ? '+' : ''}${x.toFixed(1)} %`, value: (v, c) => (warmAndRunning(v, c) && c !== 'overrun' ? v.stft1 : undefined), bad: (x) => Math.abs(x) > 10, holdS: 8 },
  { id: 'stft2', text: (x) => `Short-term fuel trim bank 2 at ${x > 0 ? '+' : ''}${x.toFixed(1)} %`, value: (v, c) => (warmAndRunning(v, c) && c !== 'overrun' ? v.stft2 : undefined), bad: (x) => Math.abs(x) > 10, holdS: 8 },
  { id: 'idle_rpm', text: (x) => `Idle speed ${x.toFixed(0)} rpm`, value: (v, c) => (c === 'idle' && (v.rpm ?? 0) > 300 ? v.rpm : undefined), bad: (x) => x < 550 || x > 950, holdS: 10 },
  { id: 'idle_maf', text: (x) => `Air mass at warm idle ${x.toFixed(1)} g/s`, value: (v, c) => (c === 'idle' ? v.maf : undefined), bad: (x) => x < 2 || x > 6, holdS: 15 },
  { id: 'ubatt_low', text: (x) => `Battery only ${x.toFixed(1)} V with the engine running (charging?)`, value: (v) => ((v.rpm ?? 0) > 500 ? v.ubatt : undefined), bad: (x) => x < 13.0, holdS: 10 },
  { id: 'ubatt_high', text: (x) => `Battery ${x.toFixed(1)} V (overcharging?)`, value: (v) => ((v.rpm ?? 0) > 500 ? v.ubatt : undefined), bad: (x) => x > 15, holdS: 10 },
  { id: 'atf_high', text: (x) => `Gearbox oil hot: ${x.toFixed(0)} °C`, value: (v) => v.atf, bad: (x) => x > 120, holdS: 10 },
  { id: 'iat_high', text: (x) => `Intake air ${x.toFixed(0)} °C`, value: (v) => v.iat, bad: (x) => x > 65, holdS: 20 },
];

/** Tracks each rule: an event when it goes bad (once) and when it is back to normal. */
export class Alerts {
  private since = new Map<string, number>();
  readonly active = new Map<string, string>();
  private runningSince = 0;
  private slowWarn = false;
  update(t: number, v: Snapshot['v'], c: Cond): { id: string; text: string; on: boolean }[] {
    const out: { id: string; text: string; on: boolean }[] = [];
    for (const r of ALERTS) {
      const x = r.value(v, c);
      const bad = x !== undefined && r.bad(x);
      if (bad) {
        const s = this.since.get(r.id) ?? t;
        this.since.set(r.id, s);
        if (!this.active.has(r.id) && t - s >= r.holdS * 1000) {
          const text = r.text(x!);
          this.active.set(r.id, text);
          out.push({ id: r.id, text, on: true });
        }
      } else if (x !== undefined) {
        this.since.delete(r.id);
        if (this.active.has(r.id)) {
          out.push({ id: r.id, text: `${this.active.get(r.id)} → back to normal`, on: false });
          this.active.delete(r.id);
        }
      }
    }
    // slow warm-up: still below 70 °C after 15 minutes with the engine running
    if ((v.rpm ?? 0) > 400) {
      if (!this.runningSince) this.runningSince = t;
      if (!this.slowWarn && v.ect !== undefined && v.ect < 70 && t - this.runningSince > 15 * 60 * 1000) {
        this.slowWarn = true;
        const text = ALERTS.find((a) => a.id === 'warmup_slow')!.text(v.ect);
        this.active.set('warmup_slow', text);
        out.push({ id: 'warmup_slow', text, on: true });
      }
    } else this.runningSince = 0;
    return out;
  }
}

// ------------------------------------------------------------------ the recording
export interface ChannelRec {
  mod: AiMod;
  variant: string;
  job: string;
  keys: { key: string; label: string; unit: string }[];
}
export interface Row {
  t: number;
  /** channel index */
  ch: number;
  /** values in the order of the channel's keys (null = not in this read) */
  v: (number | string | null)[];
  /** only on rows of the base channel (the DME data block): phase, condition and the key metrics */
  phase?: string;
  cond?: Cond;
  /** key metrics in DERIVED order */
  d?: (number | null)[];
  gear?: string;
}
export type EventType = 'start' | 'phase' | 'alert' | 'faults' | 'comm' | 'note';
export interface Ev {
  t: number;
  type: EventType;
  text: string;
}
export type FaultWhen = 'start' | 'end';
export interface FaultRead {
  t: number;
  when: FaultWhen;
  mod: string;
  name: string;
  variant: string;
  dtcs: Dtc[];
  error?: string;
}

/** Key metrics stored with each base row, already converted (STFT in %, air mass in g/s). */
export const DERIVED = METRICS.map((m) => m.id);

export class Recorder {
  channels: ChannelRec[] = [];
  rows: Row[] = [];
  events: Ev[] = [];
  faults: FaultRead[] = [];
  startedAt = 0;
  /** rows not yet copied to IndexedDB start here */
  flushed = 0;
  private latest: Record<AiMod, Map<string, Value>> = { DME: new Map(), EGS: new Map(), ABS: new Map() };
  /** last snapshot, for the screen */
  snap?: Snapshot;
  cond?: Cond;

  channelIndex(mod: AiMod, variant: string, job: string) {
    let i = this.channels.findIndex((c) => c.mod === mod && c.job === job && c.variant === variant);
    if (i < 0) i = this.channels.push({ mod, variant, job, keys: [] }) - 1;
    return i;
  }
  event(t: number, type: EventType, text: string) {
    if (!this.startedAt) this.startedAt = t;
    this.events.push({ t, type, text });
  }
  /** Records one read. `base` = the DME data block (a full row with phase, condition and key metrics). */
  add(t: number, ch: number, values: Value[], base: boolean, phase: string): Row {
    if (!this.startedAt) this.startedAt = t;
    const c = this.channels[ch];
    const v: (number | string | null)[] = c.keys.map(() => null);
    for (const x of values) {
      let k = c.keys.findIndex((y) => y.key === x.key);
      if (k < 0) {
        k = c.keys.push({ key: x.key, label: x.label, unit: x.unit }) - 1;
        v.push(null);
      }
      v[k] = typeof x.value === 'number' ? (Number.isFinite(x.value) ? Math.round(x.value * 10000) / 10000 : null) : String(x.value);
      this.latest[c.mod].set(x.key, x);
    }
    const row: Row = { t, ch, v };
    if (base) {
      const frame: Frame = { DME: [...this.latest.DME.values()], EGS: [...this.latest.EGS.values()] };
      const s = snapshot(frame);
      this.snap = s;
      this.cond = condition(s.v);
      row.phase = phase;
      row.cond = this.cond;
      row.d = DERIVED.map((id) => (s.v[id] === undefined || !Number.isFinite(s.v[id]!) ? null : Math.round(s.v[id]! * 1000) / 1000));
      if (s.gear) row.gear = s.gear;
    }
    this.rows.push(row);
    return row;
  }
  /** latest value of a module by its base name */
  value(mod: AiMod, base: string): Value | undefined {
    for (const v of this.latest[mod].values()) if (baseKey(v.key) === base) return v;
    return undefined;
  }
  /** wheel speeds (ABS): the latest numeric values whose name says wheel/speed */
  wheels(): Value[] {
    return [...this.latest.ABS.values()].filter((v) => typeof v.value === 'number' && /RAD|GESCHW|DREHZ|SPEED/.test(baseKey(v.key)));
  }
  /** keeps the last WINDOW_MS (events and fault reads too, except the first fault read: the "start" reference) */
  prune(now: number, windowMs = WINDOW_MS) {
    const from = now - windowMs;
    let n = 0;
    while (n < this.rows.length && this.rows[n].t < from) n++;
    if (n) {
      this.rows.splice(0, n);
      this.flushed = Math.max(0, this.flushed - n);
    }
    this.events = this.events.filter((e) => e.t >= from);
    return n;
  }
  get spanMs() {
    return this.rows.length ? this.rows[this.rows.length - 1].t - this.rows[0].t : 0;
  }
  clear() {
    this.channels = [];
    this.rows = [];
    this.events = [];
    this.faults = [];
    this.startedAt = 0;
    this.flushed = 0;
    this.latest = { DME: new Map(), EGS: new Map(), ABS: new Map() };
    this.snap = undefined;
    this.cond = undefined;
  }
}

// ------------------------------------------------------------------ fault comparison
export type FaultStatus = 'new' | 'persists' | 'cleared' | 'start_only' | 'end_only';
export interface FaultLine {
  mod: string;
  name: string;
  dtc: Dtc;
  status: FaultStatus;
  when: FaultWhen;
  t: number;
}

const dtcId = (d: Dtc) => d.label ?? d.hex ?? String(d.code);

/**
 * Faults of each module at the start and at the end of the recording: new (appeared during the session),
 * persists (in both), cleared (gone at the end). With only one read, the status says which one.
 */
export function compareFaults(reads: FaultRead[]): FaultLine[] {
  const out: FaultLine[] = [];
  const mods = [...new Set(reads.map((r) => r.mod))];
  for (const mod of mods) {
    const start = reads.find((r) => r.mod === mod && r.when === 'start' && !r.error);
    const end = [...reads].reverse().find((r) => r.mod === mod && r.when === 'end' && !r.error);
    if (start && end) {
      const s = new Set(start.dtcs.map(dtcId));
      const e = new Set(end.dtcs.map(dtcId));
      for (const d of end.dtcs) out.push({ mod, name: end.name, dtc: d, status: s.has(dtcId(d)) ? 'persists' : 'new', when: 'end', t: end.t });
      for (const d of start.dtcs) if (!e.has(dtcId(d))) out.push({ mod, name: start.name, dtc: d, status: 'cleared', when: 'start', t: start.t });
    } else {
      const r = start ?? end;
      if (!r) continue;
      for (const d of r.dtcs) out.push({ mod, name: r.name, dtc: d, status: start ? 'start_only' : 'end_only', when: r.when, t: r.t });
    }
  }
  return out;
}

/** Modules whose fault memory is read by default (point 4 of the plan): the ones that matter for a diagnosis. */
export const FAULT_MODS = ['DME', 'EGS', 'ABS', 'EWS', 'MRS', 'IKE'];

export const metricLabel = (id: string) => `${METRIC[id].label.toLowerCase()} (${METRIC[id].unit})`;
