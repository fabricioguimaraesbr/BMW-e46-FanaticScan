// Drive cycle for the simulator: a 325i automatic going through a whole trip, then starting over.
// Key on (engine off) → cold start → warming up at idle → city traffic with gear changes and stops →
// motorway, then full throttle up to top speed → slowing down → warm idle → engine off → again.
// Times are compressed (warm-up takes about a minute instead of ten) so the whole trip fits in 6.5 minutes.

export type DrivePhase = 'Key on, engine cold' | 'Engine off' | 'Cranking' | 'Cold start' | 'Warming up' | 'City driving' | 'Motorway' | 'Top speed run' | 'Slowing down' | 'Warm idle';

export interface EngineState {
  phase: DrivePhase;
  running: boolean;
  rpm: number;
  speed: number; // km/h
  gear: number; // 0 = engine off / P, 1-5
  pedal: number; // %
  throttle: number; // °
  maf: number; // kg/h
  iat: number; // °C
  clt: number;
  oil: number;
  cltOut: number;
  atf: number;
  inj: number; // ms
  ign: number; // ° before TDC
  vanosIn: number;
  vanosOut: number;
  kl15: number; // V
  ubatt: number;
  lambda1: number;
  lambda2: number;
  load: number; // mg/stroke
  pressure: number; // hPa
  /** O2 sensor heaters, % duty */
  o2heat: number;
  /** electric fan, % */
  fan: number;
  turbine: number; // rpm
  output: number; // rpm
}

/** Cycle length in seconds. */
export const CYCLE = 390;

/** [time s, phase] — the phase that starts at that time. */
const PHASES: [number, DrivePhase][] = [
  [0, 'Key on, engine cold'], [8, 'Cranking'], [10, 'Cold start'], [40, 'Warming up'], [80, 'City driving'],
  [200, 'Motorway'], [250, 'Top speed run'], [295, 'Slowing down'], [335, 'Warm idle'], [375, 'Engine off'],
];

/** Road speed (km/h) keyframes. Between them the speed changes smoothly. */
const SPEED: [number, number][] = [
  [0, 0], [80, 0],
  // city: two traffic lights
  [92, 30], [100, 48], [110, 50], [118, 30], [125, 0], [135, 0], [146, 40], [156, 60], [168, 60], [175, 35], [182, 0], [192, 0],
  // motorway: join, cruise, full throttle to top speed, hold, slow down, exit
  [197, 20], [212, 80], [225, 110], [235, 120], [250, 120], [272, 200], [287, 232], [295, 235], [312, 130], [325, 60], [335, 0],
  [CYCLE, 0],
];

/** Temperature keyframes (°C): warm-up is compressed, the top speed run heats things up, idle settles them. */
const COOLANT: [number, number][] = [[0, 22], [10, 22], [40, 45], [80, 82], [150, 96], [250, 98], [295, 106], [335, 101], [375, 97], [CYCLE, 92]];
const OIL: [number, number][] = [[0, 22], [10, 22], [40, 32], [80, 58], [200, 96], [250, 104], [295, 124], [335, 116], [375, 110], [CYCLE, 104]];
const ATF: [number, number][] = [[0, 22], [10, 22], [80, 38], [200, 70], [295, 96], [335, 92], [CYCLE, 86]];
const INTAKE: [number, number][] = [[0, 26], [10, 26], [80, 38], [130, 44], [200, 36], [295, 29], [335, 40], [375, 46], [CYCLE, 46]];

// ZF 5HP19 ratios and the 325i final drive; 1 km/h ≈ 26.24 rpm at the gearbox output (tyre 1.95 m round).
const RATIO = [0, 3.665, 1.999, 1.407, 1.0, 0.742];
const OUT_PER_KMH = 26.24;
// upshift speeds (km/h) with a light and with a full pedal; downshifts happen 12 km/h (light) to 30 km/h (full) lower
const UP_LIGHT = [0, 18, 34, 54, 74];
const UP_FULL = [0, 62, 104, 150, 198];

const smooth = (x: number) => x * x * (3 - 2 * x);
function track(keys: [number, number][], t: number, eased = true) {
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) {
      const f = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * (eased ? smooth(f) : f);
    }
  }
  return keys[keys.length - 1][1];
}
const lerp = (a: number, b: number, f: number) => a + (b - a) * Math.max(0, Math.min(1, f));

export class DriveCycle {
  private t0: number;
  /** @param startAt seconds into the cycle at the moment the simulator starts (0 = key on, engine off). */
  constructor(startAt = 0, private now: () => number = Date.now) {
    this.t0 = now() - startAt * 1000;
  }

  /** Seconds into the current cycle. */
  get time() {
    return ((this.now() - this.t0) / 1000) % CYCLE;
  }

  phaseAt(t: number): DrivePhase {
    let p = PHASES[0][1];
    for (const [s, name] of PHASES) if (t >= s) p = name;
    return p;
  }

  state(): EngineState {
    return this.at(this.time, (this.now() - this.t0) / 1000);
  }

  /** Engine and car at second t of the cycle (wall is a free-running clock for small wobbles). */
  at(t: number, wall = t): EngineState {
    const phase = this.phaseAt(t);
    const running = phase !== 'Engine off' && phase !== 'Key on, engine cold' && phase !== 'Cranking';
    const cranking = phase === 'Cranking';
    const speed = Math.max(0, track(SPEED, t));
    const dv = (track(SPEED, t + 0.5) - track(SPEED, t - 0.5)); // km/h per s
    const topRun = phase === 'Top speed run';
    // pedal: what it takes to hold the speed (air drag grows with v²) plus what it takes to accelerate
    let pedal = running && speed > 0.5 ? Math.min(100, 4 + (speed / 235) ** 2 * 62 + Math.max(0, dv) * 4.5) : 0;
    if (topRun && dv > 0.2) pedal = 100;
    if (dv < -0.3) pedal = 0;
    // gear: upshift points move up with the pedal; on the way down shift later (lower speed)
    let gear = 0;
    if (running) {
      const pf = pedal / 100;
      gear = 1;
      for (let g = 1; g <= 4; g++) {
        const up = lerp(UP_LIGHT[g], UP_FULL[g], pf) - (dv < 0 ? lerp(12, 30, pf) : 0);
        if (speed > up) gear = g + 1;
      }
    }
    const output = speed * OUT_PER_KMH;
    const turbine = output * RATIO[gear];
    // idle speed: high after a cold start, settling as the engine warms
    const clt = track(COOLANT, t);
    const idle = !running ? 0 : t < 40 ? lerp(1250, 900, (t - 10) / 30) : t < 80 ? lerp(900, 720, (t - 40) / 40) : 720;
    // torque converter: slips at low speed (engine runs above the turbine), locks from 3rd gear when cruising
    const slip = gear >= 3 && speed > 50 ? 1.01 : 1.06 + pedal / 400;
    const stall = idle + pedal * 22;
    let rpm = 0;
    if (cranking) rpm = lerp(0, 260, (t - 8) / 0.4) + Math.sin(wall * 30) * 25;
    else if (running) rpm = Math.max(turbine * slip, speed < 15 ? lerp(stall, idle, speed / 15) : 0, idle) + Math.sin(wall * 7) * (speed < 1 ? 12 : 5);
    if (running && t >= 10 && t < 11.5) rpm = lerp(1500, idle, (t - 10) / 1.5); // start flare
    rpm = Math.max(0, Math.min(6500, rpm));
    const r = rpm / 1000;
    const pf = pedal / 100;
    const cold = clt < 70;
    const closedLoop = running && t > 25 && !(topRun && pedal > 90);
    const wobble = (k: number, a: number) => Math.sin(wall * k) * a;
    const ubatt = !running ? (cranking ? 10.4 + wobble(9, 0.3) : 12.55) : (cold ? 14.35 : 14.05) + wobble(1 / 3, 0.05);
    const st: EngineState = {
      phase,
      running,
      rpm,
      speed,
      gear,
      pedal,
      throttle: running ? (cold && speed < 1 ? 3.6 : 2.5) + pf * 85 : pedal * 0.85,
      maf: running ? (cold && speed < 1 ? 17 : 13) + rpm * (0.0012 + pf * 0.093) : 0,
      iat: track(INTAKE, t) + wobble(1 / 9, 1),
      clt,
      oil: track(OIL, t),
      cltOut: Math.max(track(INTAKE, t) - 4, clt - (clt > 95 ? 6 : clt > 80 ? 22 : 30)),
      atf: track(ATF, t),
      inj: running ? (cold ? 3.4 : 2.6) + pf * 8.6 + Math.max(0, r - 1) * 0.15 : cranking ? 6 : 0,
      ign: running ? (pf > 0.85 ? 22 + r : speed > 1 ? 24 + r * 3 - pf * 10 : cold ? 2 : 8) + wobble(5, 1.5) : 0,
      vanosIn: running ? (r > 1.5 && pf < 0.8 ? 84 + r * 2 : pf >= 0.8 && r > 4 ? 112 : 108) : 120,
      vanosOut: running ? (r > 1.5 && pf < 0.8 ? -86 : -102) : -105,
      kl15: ubatt - 0.05,
      ubatt,
      lambda1: closedLoop ? 1 + wobble(1.3, 0.03) : 1,
      lambda2: closedLoop ? 1 + Math.cos(wall * 1.1) * 0.03 : 1,
      load: running ? 135 + pf * 390 + (cold && speed < 1 ? 25 : 0) : 0,
      pressure: 935,
      o2heat: running ? (t < 60 ? 100 : 28 + wobble(0.7, 4)) : 0,
      fan: running && clt > 99 ? Math.min(100, (clt - 99) * 18) : 0,
      turbine,
      output,
    };
    return st;
  }
}
