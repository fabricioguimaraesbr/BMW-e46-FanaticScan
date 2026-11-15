// ECO: what the engine is burning right now and why, for city driving. Follows the values the Telemetry screen
// already reads (engine speed, speed, pedal, injection time, air mass, trims, coolant) and keeps a trip
// breakdown, a fuel "health check" and a guided test of the overrun fuel cut. Read-only.
//
// Fuel cut: with the module file the DME's injection time is used (0 ms = cut). In plug-and-play mode the OBD-II
// fuel system status says "open loop (load/decel)"; without either, it is estimated from pedal and engine speed.
// The cut and resume speeds below are typical values, not yet read from the car's calibration.

import type { CarId, DmeFamily } from './carid';

export interface EcoProfile {
  /** the DME cuts fuel on overrun above this engine speed (pedal released, engine warm) */
  cutRpm: number;
  /** and injects again when the engine slows to this */
  resumeRpm: number;
  /** coolant needed before the DME cuts fuel and the checks count as "warm" */
  warmC: number;
  /** thermostat map target at part load (map-controlled thermostat), undefined = not map controlled */
  targetC?: number;
  idleMaf: [number, number];
  idleRpm: [number, number];
  petrol: boolean;
  /** where the numbers come from */
  source: string;
}

export function ecoProfile(car: Pick<CarId, 'family' | 'gearbox'> | null): EcoProfile {
  const fam: DmeFamily = car?.family ?? 'unknown';
  const auto = car?.gearbox === 'automatic' || car?.gearbox === 'unknown';
  const base: EcoProfile = {
    cutRpm: auto ? 1400 : 1250, resumeRpm: auto ? 1100 : 1000, warmC: 70, targetC: undefined,
    idleMaf: [2.5, 4.5], idleRpm: [600, 820], petrol: true, source: 'typical values',
  };
  if (fam === 'MS43' || fam === 'MS45') return { ...base, targetC: 102, source: 'typical M54 values (not yet read from your DME)' };
  if (fam === 'MS42') return { ...base, targetC: 100, idleMaf: [2.5, 5], source: 'typical M52TU values' };
  if (fam === 'ME9') return { ...base, idleMaf: [1.8, 3.5], targetC: 100, source: 'typical N42/N46 values' };
  if (fam === 'MSS54') return { ...base, cutRpm: 1500, resumeRpm: 1200, idleMaf: [3, 6], idleRpm: [750, 950], source: 'typical S54 values' };
  if (fam === 'DDE') return { ...base, petrol: false, idleMaf: [5, 12], source: 'diesel: fuel figures are not air-based' };
  return base;
}

export interface EcoSample {
  /** ms */
  t: number;
  rpm?: number;
  speed?: number;
  pedal?: number;
  /** true when "pedal" is the OBD-II throttle position, not the pedal */
  pedalIsThrottle?: boolean;
  /** injection time, ms (module file) */
  ti?: number;
  /** OBD-II fuel system status text */
  fuelStatus?: string;
  ect?: number;
  maf?: number;
  stft1?: number;
  stft2?: number;
  ubatt?: number;
}

export type EcoState = 'drive' | 'cut' | 'coast' | 'idle' | 'unknown';
export type CutSource = 'injection' | 'obd' | 'estimate';
export type CheckStatus = 'OK' | 'WATCH' | 'CHECK' | 'INFO' | '—';
export interface EcoCheck { id: string; status: CheckStatus; label: string; ref: string; value: string; why?: string }
export type TestState = 'off' | 'arming' | 'ready' | 'watching' | 'pass' | 'fail';

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const LITRE_G = 745;
const STOI = 14.7;

export class EcoTracker {
  profile: EcoProfile;
  /** lowest pedal seen (rest position) */
  pedalRest?: number;
  state: EcoState = 'unknown';
  cut = false;
  cutSource: CutSource = 'estimate';
  lph?: number;
  kml?: number;
  time = { drive: 0, cut: 0, coast: 0, idle: 0, total: 0, cold: 0 };
  distanceKm = 0;
  fuelL = 0;
  liftOffs = 0;
  /** lift-offs (warm, moving) below the cut line: fuel keeps flowing */
  missed = 0;
  cutsSeen = 0;
  /** warm lift-offs above the cut line where no cut followed */
  noCutAbove = 0;
  last?: EcoSample;
  private lastT = 0;
  private released = false;
  private liftAt?: { t: number; rpm: number; warm: boolean; above: boolean; cut: boolean };
  private ema?: number;
  private warmEct: number[] = [];
  private idleMaf: number[] = [];
  private idleRpm: number[] = [];
  private trims: number[] = [];
  private batt: number[] = [];
  test: { state: TestState; text: string; delayMs?: number; t0?: number } = { state: 'off', text: '' };

  constructor(profile: EcoProfile) {
    this.profile = profile;
  }

  reset() {
    const p = this.profile;
    Object.assign(this, new EcoTracker(p));
  }

  /** pedal released, relative to the rest position learned on the way */
  isReleased(pedal: number | undefined) {
    if (pedal === undefined) return false;
    return pedal - (this.pedalRest ?? 0) <= 1.5;
  }
  /** pedal travel above the rest position */
  pedalTravel(pedal: number | undefined) {
    return pedal === undefined ? undefined : Math.max(0, pedal - (this.pedalRest ?? 0));
  }

  update(s: EcoSample) {
    const p = this.profile;
    // rest position: the lowest value seen, only from plausible rest readings (raw OBD-II rests near 10–18 %)
    if (s.pedal !== undefined && s.pedal <= 20 && (this.pedalRest === undefined || s.pedal < this.pedalRest)) this.pedalRest = s.pedal;
    const rpm = s.rpm ?? 0;
    const speed = s.speed ?? 0;
    const moving = speed >= 3;
    const released = s.pedal === undefined ? (s.ti !== undefined ? s.ti < 0.3 : false) : this.isReleased(s.pedal);
    const warm = s.ect === undefined ? true : s.ect >= p.warmC;
    // fuel cut
    let cut: boolean;
    if (s.ti !== undefined) { cut = s.ti < 0.3 && rpm > 500; this.cutSource = 'injection'; }
    else if (s.fuelStatus !== undefined) { cut = /decel|cut/i.test(s.fuelStatus) && released && rpm > p.resumeRpm; this.cutSource = 'obd'; }
    else { cut = released && warm && moving && rpm > p.resumeRpm && (this.cut || rpm > p.cutRpm); this.cutSource = 'estimate'; }
    this.cut = cut;
    this.state = !moving && rpm > 0 ? 'idle' : !released ? 'drive' : cut ? 'cut' : moving ? 'coast' : 'unknown';
    // fuel now
    if (s.maf !== undefined && p.petrol) {
      const tr = [s.stft1, s.stft2].filter((x): x is number => x !== undefined);
      const corr = tr.length ? 1 + tr.reduce((a, b) => a + b, 0) / tr.length / 100 : 1;
      this.lph = cut ? 0 : ((s.maf / STOI) * corr * 3600) / LITRE_G;
    } else this.lph = undefined;
    const dt = this.lastT ? Math.min(2, (s.t - this.lastT) / 1000) : 0;
    this.lastT = s.t;
    if (dt > 0) {
      this.time.total += dt;
      if (this.state !== 'unknown') this.time[this.state] += dt;
      if (!warm) this.time.cold += dt;
      this.distanceKm += (speed * dt) / 3600;
      if (this.lph !== undefined) this.fuelL += (this.lph * dt) / 3600;
    }
    if (!moving || this.lph === undefined) this.ema = undefined;
    else {
      const k = this.lph > 0.05 ? Math.min(99.9, speed / this.lph) : 99.9;
      this.ema = this.ema === undefined ? k : this.ema + 0.35 * (k - this.ema);
    }
    this.kml = cut ? undefined : this.ema;
    // lift-offs
    if (released && !this.released && moving) {
      this.liftOffs++;
      const above = rpm >= p.cutRpm;
      if (warm && !above) this.missed++;
      this.liftAt = { t: s.t, rpm, warm, above, cut: false };
    }
    if (this.liftAt) {
      if (cut && !this.liftAt.cut) { this.liftAt.cut = true; this.cutsSeen++; }
      if (!released || !moving || rpm < p.resumeRpm || s.t - this.liftAt.t > 4000) {
        if (this.liftAt.warm && this.liftAt.above && !this.liftAt.cut && s.t - this.liftAt.t > 2500) this.noCutAbove++;
        this.liftAt = undefined;
      }
    }
    this.released = released;
    // samples for the checks
    if (warm) {
      if (s.ect !== undefined && moving) this.warmEct.push(s.ect);
      if (!moving && rpm > 300 && released) {
        if (s.maf !== undefined) this.idleMaf.push(s.maf);
        this.idleRpm.push(rpm);
      }
      const tr = [s.stft1, s.stft2].filter((x): x is number => x !== undefined);
      if (tr.length && !cut) this.trims.push(...tr);
    }
    if (s.ubatt !== undefined && rpm > 500) this.batt.push(s.ubatt);
    for (const a of [this.warmEct, this.idleMaf, this.idleRpm, this.trims, this.batt]) if (a.length > 3000) a.splice(0, a.length - 3000);
    this.stepTest(s, released, warm, moving);
    this.last = s;
  }

  // ---------------------------------------------------------------- guided overrun test
  startTest() {
    this.test = { state: 'arming', text: '' };
    this.stepTest(this.last ?? { t: 0 }, this.released, (this.last?.ect ?? 99) >= this.profile.warmC, (this.last?.speed ?? 0) >= 3);
  }
  private stepTest(s: EcoSample, released: boolean, warm: boolean, moving: boolean) {
    const p = this.profile, T = this.test, rpm = s.rpm ?? 0;
    if (T.state === 'off' || T.state === 'pass' || T.state === 'fail') return;
    if (!warm) { T.state = 'arming'; T.text = `Waiting for a warm engine (coolant ${Math.round(s.ect ?? 0)} °C, needs ${p.warmC} °C).`; return; }
    if (T.state === 'arming' || T.state === 'ready') {
      if (!released && moving && rpm > p.cutRpm + 150) { T.state = 'ready'; T.text = `Ready: now lift your foot off completely and let the car roll.`; return; }
      T.state = 'arming';
      T.text = `Accelerate in 2nd or 3rd to about ${p.cutRpm + 600} rpm, then lift off completely.`;
      if (released && moving && rpm > p.cutRpm) { T.state = 'watching'; T.t0 = s.t; }
      return;
    }
    if (T.state === 'watching') {
      if (!released) { T.state = 'ready'; T.text = 'Pedal pressed again: lift off fully and keep it off.'; return; }
      const dt = s.t - (T.t0 ?? s.t);
      T.text = `Watching… ${(dt / 1000).toFixed(1)} s`;
      if (this.cut) { T.state = 'pass'; T.delayMs = dt; T.text = `PASS · fuel cut ${(dt / 1000).toFixed(1)} s after lift-off${this.cutSource === 'estimate' ? ' (estimated: no injection value on this connection)' : ''}.`; return; }
      if (rpm < p.resumeRpm || dt > 3500) { T.state = 'fail'; T.text = `No fuel cut seen (${this.cutSource === 'injection' ? 'injection never reached 0 ms' : 'fuel status never showed decel'}). Check the pedal at rest and the throttle adaptation.`; }
    }
  }

  // ---------------------------------------------------------------- health check
  checks(): EcoCheck[] {
    const p = this.profile;
    const out: EcoCheck[] = [];
    const warmT = this.time.total - this.time.cold;
    const ect = median(this.warmEct.slice(-600));
    if (p.targetC === undefined) out.push({ id: 'ect', status: 'INFO', label: 'Coolant vs thermostat', ref: 'No thermostat map reference for this engine', value: ect !== undefined ? `${ect.toFixed(0)} °C` : '—' });
    else if (ect === undefined || warmT < 120 || this.warmEct.length < 20) out.push({ id: 'ect', status: '—', label: 'Coolant vs thermostat map', ref: `Target ${p.targetC} °C at part load · drive a few minutes warm`, value: '' });
    else out.push({ id: 'ect', status: ect < p.targetC - 6 ? 'WATCH' : 'OK', label: 'Coolant vs thermostat map', ref: `Target ${p.targetC} °C at part load`, value: `${ect.toFixed(0)} °C`,
      why: ect < p.targetC - 6 ? 'Running cooler than the map: the thermostat may open early, or the map target was lowered. A cooler engine burns a little more.' : undefined });
    const tr = this.trims.length > 20 ? this.trims.reduce((a, b) => a + b, 0) / this.trims.length : undefined;
    out.push(tr === undefined
      ? { id: 'trim', status: '—', label: 'Short-term trims', ref: 'Normal within ±10 % · needs a warm engine', value: '' }
      : { id: 'trim', status: Math.abs(tr) > 10 ? 'CHECK' : Math.abs(tr) > 6 ? 'WATCH' : 'OK', label: 'Short-term trims', ref: 'Normal within ±10 %', value: `${tr >= 0 ? '+' : ''}${tr.toFixed(1)} %`,
          why: tr > 6 ? 'Adding fuel: air the MAF does not see (vacuum leak, CCV) or a weak MAF.' : tr < -6 ? 'Removing fuel: leaking injector, high fuel pressure or a MAF reading high.' : undefined });
    const maf = median(this.idleMaf);
    out.push(maf === undefined
      ? { id: 'maf', status: '—', label: 'Air mass at idle', ref: `Warm, stopped: ${p.idleMaf[0]}–${p.idleMaf[1]} g/s (A/C off)`, value: '' }
      : { id: 'maf', status: maf > p.idleMaf[1] || maf < p.idleMaf[0] ? 'WATCH' : 'OK', label: 'Air mass at idle', ref: `Warm, A/C off: ${p.idleMaf[0]}–${p.idleMaf[1]} g/s (approximate)`, value: `${maf.toFixed(1)} g/s`,
          why: maf > p.idleMaf[1] ? 'Higher than usual: A/C, fan, alternator load or a high idle. With trims near 0 the MAF itself is fine.' : maf < p.idleMaf[0] ? 'Lower than usual: with positive trims, look for air entering after the MAF.' : undefined });
    const last = this.last;
    if (this.pedalRest === undefined) out.push({ id: 'pedal', status: '—', label: 'Pedal at rest', ref: 'Released pedal must read as released for the fuel cut', value: '' });
    else if (last?.pedalIsThrottle) out.push({ id: 'pedal', status: 'INFO', label: 'Pedal at rest (OBD-II)', ref: 'OBD-II gives the throttle, not the pedal', value: `${this.pedalRest.toFixed(0)} %`, why: 'With the module file the DME pedal value is used instead.' });
    else out.push({ id: 'pedal', status: this.pedalRest > 3 ? 'INFO' : 'OK', label: 'Pedal at rest (DME)', ref: this.pedalRest > 3 ? 'Offset learned: the app counts it as 0 %' : 'Reads 0 % with the foot off', value: `${this.pedalRest.toFixed(1)} %`,
      why: this.pedalRest > 3 ? 'If the DME also takes this as pressed, it never cuts fuel: the guided test below shows it.' : undefined });
    if (this.test.state === 'pass') out.push({ id: 'cut', status: 'OK', label: 'Overrun fuel cut', ref: 'Guided test', value: 'PASS' });
    else if (this.test.state === 'fail') out.push({ id: 'cut', status: 'CHECK', label: 'Overrun fuel cut', ref: 'Guided test', value: 'FAIL' });
    else if (this.cutsSeen) out.push({ id: 'cut', status: 'OK', label: 'Overrun fuel cut', ref: `Seen this trip${this.cutSource === 'estimate' ? ' (estimated)' : ''}`, value: `${this.cutsSeen}×` });
    else if (this.noCutAbove >= 2) out.push({ id: 'cut', status: 'CHECK', label: 'Overrun fuel cut', ref: `Lifted off above ${p.cutRpm} rpm warm, no cut`, value: `${this.noCutAbove}×` });
    else out.push({ id: 'cut', status: '—', label: 'Overrun fuel cut', ref: `Lift off above ${p.cutRpm} rpm with a warm engine, or run the test`, value: '' });
    const idle = median(this.idleRpm);
    out.push(idle === undefined
      ? { id: 'idle', status: '—', label: 'Idle speed', ref: `Warm: ${p.idleRpm[0]}–${p.idleRpm[1]} rpm`, value: '' }
      : { id: 'idle', status: idle < p.idleRpm[0] || idle > p.idleRpm[1] ? 'WATCH' : 'OK', label: 'Idle speed', ref: `Warm: ${p.idleRpm[0]}–${p.idleRpm[1]} rpm`, value: `${Math.round(idle)} rpm` });
    out.push({ id: 'cold', status: 'INFO', label: 'Cold running this trip', ref: `No fuel cut and richer mixture below ${p.warmC} °C`, value: this.time.total > 5 ? `${fmtMin(this.time.cold)} · ${Math.round((this.time.cold / this.time.total) * 100)} %` : '—' });
    const ub = median(this.batt);
    out.push(ub === undefined
      ? { id: 'batt', status: '—', label: 'Charging', ref: 'Engine running: 13.5–14.8 V', value: '' }
      : { id: 'batt', status: ub < 13.5 || ub > 14.8 ? 'WATCH' : 'OK', label: 'Charging', ref: 'Engine running: 13.5–14.8 V', value: `${ub.toFixed(1)} V` });
    out.push({ id: 'more', status: 'INFO', label: 'O2 sensors, adaptations, misfires', ref: 'Guided checks (Workshop)', value: '' });
    return out;
  }

  /** trip split, percent of the time */
  split() {
    const t = Math.max(1e-6, this.time.drive + this.time.cut + this.time.coast + this.time.idle);
    const pc = (x: number) => (x / t) * 100;
    return { drive: pc(this.time.drive), cut: pc(this.time.cut), coast: pc(this.time.coast), idle: pc(this.time.idle) };
  }
  get average() {
    return this.fuelL > 0.005 && this.distanceKm > 0.05 ? Math.min(99.9, this.distanceKm / this.fuelL) : undefined;
  }
}

export const fmtMin = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** What the driver is seeing, in one sentence. */
export function coach(e: EcoTracker): { tone: 'good' | 'warn' | 'info' | 'plain'; title: string; text: string } {
  const p = e.profile, s = e.last;
  const rpm = Math.round(s?.rpm ?? 0);
  if (!s) return { tone: 'plain', title: 'Waiting for the engine', text: 'Values appear as soon as the DME answers.' };
  if ((s.ect ?? 99) < p.warmC) return { tone: 'info', title: `Engine warming up · ${Math.round(s.ect ?? 0)} °C`, text: `Below ${p.warmC} °C the mixture is richer and there is no fuel cut. Short trips spend most of their fuel here.` };
  if (e.state === 'cut') return { tone: 'good', title: 'Fuel cut · 0.0 L/h', text: `You lifted off with the engine above the cut line. The DME injects again near ${p.resumeRpm} rpm.` };
  if (e.state === 'coast') return { tone: 'warn', title: 'Coasting, fuel still flowing', text: rpm < p.cutRpm ? `${rpm} rpm is below the cut line (${p.cutRpm}). In D at low speed the converter is open and revs drop fast.` : 'Above the cut line: the cut follows after a short delay.' };
  if (e.state === 'idle') return { tone: 'info', title: `Stopped · ${e.lph?.toFixed(1) ?? '—'} L/h`, text: 'Standing in traffic burns fuel at 0 km/l. Long waits add up quickly in the city.' };
  return { tone: 'plain', title: 'Driving', text: 'A gentle, steady pedal lets the converter lock sooner and keeps the mixture out of enrichment.' };
}
