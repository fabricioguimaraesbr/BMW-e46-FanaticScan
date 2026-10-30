// Guided checks: procedures that follow live values and say what they mean. Everything here is read-only
// (value groups of the module files); the only optional step that drives something is the DME misfire system
// check, which goes through the normal "Unlock tests & resets".
// The thresholds are general E46 / M54 workshop experience, written for this app; they flag what to look at, they
// do not replace a measurement.

import type { Value } from './DiagSession';

export type CheckId = 'atf' | 'thermostat' | 'vanos' | 'lambda' | 'misfire';

export interface CheckDef {
  id: CheckId;
  title: string;
  module: 'DME' | 'EGS';
  summary: string;
  /** value groups read every cycle; the first one must exist in the module file */
  jobs: string[];
  /** read once at the start (adaptations) */
  once?: string[];
  /** conditions and steps, shown as a checklist */
  steps: string[];
  /** engine computers this check was written for */
  written: string;
}

export const CHECKS: CheckDef[] = [
  {
    id: 'thermostat',
    title: 'Thermostat and warm-up',
    module: 'DME',
    summary: 'Follows the coolant temperature and the radiator outlet from a cold start. A thermostat stuck open warms up slowly, runs cool and makes the radiator hot too early. Combine it with the coolant gauge curve in Coding to see it on the dashboard as well.',
    jobs: ['STATUS_MESSWERTEBLOCK'],
    steps: ['Start with a cold engine (left for a few hours, coolant below 40 °C) for the full test.', 'Start the engine and leave the app reading: idle or drive normally.', 'Keep it running until the coolant passes 90 °C, or for 15 minutes.'],
    written: 'MS43 (M54)',
  },
  {
    id: 'atf',
    title: 'Automatic gearbox fluid level',
    module: 'EGS',
    summary: 'The ZF 5HP19 is checked at the filler plug with the fluid between 30 and 50 °C. This follows the fluid temperature from the gearbox computer and says when to check.',
    jobs: ['STATUS_IO_LESEN'],
    steps: ['Car level: on a lift, or with both axles raised the same height.', 'Engine idling, A/C off, handbrake on.', 'Move the selector slowly through every position, pausing a few seconds in each, then back to P.', 'With the fluid between 30 and 50 °C, remove the filler plug on the side of the gearbox: the fluid should be level with the edge of the hole. Top up with the specified fluid until it runs out, then refit the plug.'],
    written: 'GS8.60.4 (5HP19)',
  },
  {
    id: 'vanos',
    title: 'VANOS (target against actual)',
    module: 'DME',
    summary: 'Compares where the DME wants each camshaft with where it really is. A VANOS that follows slowly or not at all points to worn seals in the VANOS unit, a sticking solenoid or low oil pressure.',
    jobs: ['STATUS_VANOS_NW_LAGE_IST_SOLL_REF_EINLASS', 'STATUS_VANOS_NW_LAGE_IST_SOLL_REF_AUSLASS', 'STATUS_MESSWERTEBLOCK'],
    steps: ['Warm engine (coolant above 70 °C), selector in P or N.', 'Idle for 20 seconds, then rev slowly to 2 500–3 500 rpm a few times, holding each rise for a couple of seconds. A short drive works too.', 'Watch both camshafts: the actual value should follow the target within a few degrees.'],
    written: 'MS43 (M54)',
  },
  {
    id: 'lambda',
    title: 'Oxygen sensors (pre-cat)',
    module: 'DME',
    summary: 'Watches both pre-cat oxygen sensors switching between rich and lean, and the mixture correction of each bank. Lazy sensors, vacuum leaks and fuel problems show here.',
    jobs: ['STATUS_L_SONDE', 'STATUS_L_SONDE_2', 'STATUS_MESSWERTEBLOCK'],
    once: ['STATUS_LAMBDA_ADD_1', 'STATUS_LAMBDA_MUL_1', 'STATUS_LAMBDA_ADD_2', 'STATUS_LAMBDA_MUL_2'],
    steps: ['Warm engine (coolant above 75 °C) so the DME runs in closed loop.', 'Idle for 30 seconds, then hold about 2 500 rpm for 30 seconds.', 'Each sensor should swing between about 0.1 and 0.8 V, several times every 10 seconds.'],
    written: 'MS43 (M54)',
  },
  {
    id: 'misfire',
    title: 'Misfires per cylinder',
    module: 'DME',
    summary: 'The rough-running value and the misfire counter of each cylinder, side by side. One cylinder clearly above the others points at its coil, plug or injector (swap the coil with a neighbour and see if the fault moves).',
    jobs: ['STATUS_SYSTEMCHECK_LAUFUNRUHE', 'STATUS_MESSWERTEBLOCK'],
    steps: ['Warm engine at idle, A/C off, no load.', 'Let it read for 30 seconds. If all values stay at zero, start the DME misfire check (needs “Unlock tests & resets”).', 'Then also try with the A/C on and with lights on: misfires sometimes show only under load.'],
    written: 'MS43 (M54)',
  },
];

// ---------------------------------------------------------------- value helpers

/** First numeric value whose key matches (keys as the module file names them). */
export function pick(values: Value[], re: RegExp): number | undefined {
  const v = values.find((x) => re.test(x.key) && typeof x.value === 'number');
  return v ? (v.value as number) : undefined;
}
export const pickText = (values: Value[], re: RegExp) => {
  const v = values.find((x) => re.test(x.key));
  return v ? String(v.value) : undefined;
};

export interface Verdict {
  level: 'ok' | 'warn' | 'bad' | 'info';
  title: string;
  text: string;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- ATF level

export const ATF_MIN = 30;
export const ATF_MAX = 50;

export interface AtfSample { t: number; temp?: number; rpm?: number }

export function atfVerdict(s: AtfSample[]): Verdict {
  const last = s[s.length - 1];
  if (!last || last.temp === undefined) return { level: 'info', title: 'Waiting for the gearbox', text: 'No fluid temperature yet.' };
  const t = last.temp;
  if ((last.rpm ?? 0) < 400) return { level: 'warn', title: `Fluid ${Math.round(t)} °C · engine off`, text: 'The level is only correct with the engine idling: start the engine.' };
  if (t < ATF_MIN) {
    const rate = warmRate(s);
    const eta = rate > 0.01 ? (ATF_MIN - t) / rate : 0;
    return { level: 'info', title: `Fluid ${Math.round(t)} °C · not yet`, text: `Keep idling. Check at ${ATF_MIN} °C${eta ? `, in about ${mmss(eta)}` : ''}. Meanwhile, move the selector through every position and back to P.` };
  }
  if (t <= ATF_MAX) return { level: 'ok', title: `Fluid ${Math.round(t)} °C · check now`, text: `Between ${ATF_MIN} and ${ATF_MAX} °C: remove the filler plug now. Fluid level with the edge of the hole is correct; if nothing comes out, top up until it does. ${t > 45 ? 'Be quick: it is close to the upper limit.' : ''}`.trim() };
  return { level: 'warn', title: `Fluid ${Math.round(t)} °C · too warm`, text: `Above ${ATF_MAX} °C the fluid expands and the level reads too high. Let it cool (engine off) and check again from a cooler start.` };
}

/** °C per second over the last minute. */
function warmRate(s: AtfSample[]): number {
  const recent = s.filter((x) => x.temp !== undefined && x.t >= s[s.length - 1].t - 60);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  return b.t > a.t ? (b.temp! - a.temp!) / (b.t - a.t) : 0;
}

// ---------------------------------------------------------------- thermostat

export interface ThermoSample { t: number; clt?: number; out?: number; rpm?: number; speed?: number }

export interface ThermoResult {
  verdicts: Verdict[];
  running: number; // seconds with the engine running
  start?: number;
  max?: number;
  last?: number;
  timeTo80?: number;
}

export function thermostatCheck(s: ThermoSample[]): ThermoResult {
  const run = s.filter((x) => (x.rpm ?? 0) > 400 && x.clt !== undefined);
  const res: ThermoResult = { verdicts: [], running: 0 };
  if (!run.length) {
    res.verdicts.push({ level: 'info', title: 'Start the engine', text: 'The test follows the coolant from the moment the engine runs.' });
    return res;
  }
  for (let i = 1; i < s.length; i++) if ((s[i].rpm ?? 0) > 400) res.running += s[i].t - s[i - 1].t;
  res.start = run[0].clt;
  res.max = Math.max(...run.map((x) => x.clt!));
  res.last = run[run.length - 1].clt;
  const hit = run.find((x) => x.clt! >= 80);
  if (hit && res.start! < 70) res.timeTo80 = hit.t - run[0].t;
  const v = res.verdicts;
  if (res.start! > 60) v.push({ level: 'info', title: `Started warm (${Math.round(res.start!)} °C)`, text: 'The warm-up time needs a cold start; the checks of a warm engine still apply.' });
  if (res.max! >= 115) v.push({ level: 'bad', title: `Coolant reached ${Math.round(res.max!)} °C`, text: 'Too hot. Stop the engine and check the coolant level, the electric fan, the water pump and the radiator before driving on.' });
  // radiator outlet almost as hot as the engine while the engine is still cold: coolant already goes through the radiator
  const early = run.filter((x) => x.clt! < 75 && x.out !== undefined && x.t - run[0].t > 180);
  if (early.length >= 3 && early.filter((x) => x.out! >= x.clt! - 8).length / early.length > 0.7)
    v.push({ level: 'bad', title: 'Radiator hot while the engine is cold', text: 'The radiator outlet follows the engine temperature before the engine is warm: the thermostat is open when it should be closed (stuck open).' });
  if (res.running >= 900 && res.max! < 80) v.push({ level: 'bad', title: `Only ${Math.round(res.max!)} °C after ${mmss(res.running)}`, text: 'An M54 should pass 80 °C well within 15 minutes. The thermostat is most likely stuck open. Replace it (and its temperature sensor connector if it is corroded).' });
  else if (res.timeTo80 !== undefined && res.timeTo80 > 1200) v.push({ level: 'warn', title: `Slow warm-up: ${mmss(res.timeTo80)} to 80 °C`, text: 'Longer than usual (about 8–15 minutes, longer at idle in cold weather). A thermostat that opens too early is the usual cause.' });
  const warm = run.filter((x) => x.t - run[0].t > 60 && x.clt! >= 88);
  if (warm.length && !v.some((x) => x.level === 'bad')) {
    const after = run.filter((x) => x.t >= warm[0].t);
    const low = Math.min(...after.map((x) => x.clt!));
    if (low < 80 && after.some((x) => (x.speed ?? 0) > 60)) v.push({ level: 'warn', title: `Drops to ${Math.round(low)} °C when driving`, text: 'Once warm, the coolant should stay above about 85 °C. Falling at speed points to a thermostat that does not close fully.' });
    else v.push({ level: 'ok', title: `Warm: ${Math.round(res.last!)} °C${res.timeTo80 !== undefined ? ` · 80 °C in ${mmss(res.timeTo80)}` : ''}`, text: 'Warms up and holds its temperature as it should. The M54 map thermostat lets it run hotter at light load (up to about 105–110 °C) and cooler under load; that is normal.' });
  } else if (!v.length) v.push({ level: 'info', title: `Warming up: ${Math.round(res.last!)} °C after ${mmss(res.running)}`, text: 'Keep it running until the coolant passes 90 °C.' });
  return res;
}

// ---------------------------------------------------------------- VANOS

export interface VanosSample { t: number; inIst?: number; inSoll?: number; outIst?: number; outSoll?: number; rpm?: number; clt?: number }

export interface CamStats { span: number; meanDev: number; maxDev: number; n: number }

export function camStats(s: VanosSample[], ist: 'inIst' | 'outIst', soll: 'inSoll' | 'outSoll'): CamStats {
  const xs = s.filter((x) => x[ist] !== undefined && x[soll] !== undefined && (x.rpm ?? 0) > 400);
  if (!xs.length) return { span: 0, meanDev: 0, maxDev: 0, n: 0 };
  const sol = xs.map((x) => x[soll]!);
  // deviations only where the target is steady (one read after a change, the cam is still on its way)
  const steady = xs.filter((x, i) => i > 0 && Math.abs(x[soll]! - xs[i - 1][soll]!) < 2);
  const dev = (steady.length ? steady : xs).map((x) => Math.abs(x[ist]! - x[soll]!));
  return { span: Math.max(...sol) - Math.min(...sol), meanDev: dev.reduce((a, b) => a + b, 0) / dev.length, maxDev: Math.max(...dev), n: xs.length };
}

export function vanosVerdicts(s: VanosSample[]): Verdict[] {
  const last = s[s.length - 1];
  const out: Verdict[] = [];
  if (!last || (last.rpm ?? 0) < 400) return [{ level: 'info', title: 'Start the engine', text: 'VANOS only moves with the engine running and warm.' }];
  if ((last.clt ?? 90) < 70) out.push({ level: 'info', title: `Engine at ${Math.round(last.clt!)} °C`, text: 'VANOS is held back while the engine is cold; the result is reliable from about 70 °C.' });
  for (const [name, ist, soll] of [['Intake', 'inIst', 'inSoll'], ['Exhaust', 'outIst', 'outSoll']] as const) {
    const c = camStats(s, ist, soll);
    if (c.n < 5) continue;
    if (c.span < 5) out.push({ level: 'info', title: `${name}: target has not moved yet`, text: 'Rev to 2 500–3 500 rpm a few times so the DME asks the camshaft to move.' });
    else if (c.meanDev <= 3) out.push({ level: 'ok', title: `${name}: follows the target`, text: `Average difference ${c.meanDev.toFixed(1)}°, largest ${c.maxDev.toFixed(1)}° over a ${c.span.toFixed(0)}° range.` });
    else if (c.meanDev <= 7) out.push({ level: 'warn', title: `${name}: slow to follow`, text: `Average difference ${c.meanDev.toFixed(1)}°. Typical of worn VANOS seals (rattle at idle, weak low-rpm torque) or low oil pressure. Check the oil level and the VANOS solenoid connector first.` });
    else out.push({ level: 'bad', title: `${name}: does not follow`, text: `Average difference ${c.meanDev.toFixed(1)}°. Solenoid, wiring, seals or the camshaft sensor. Read the DME faults and the guide for VANOS faults.` });
  }
  return out;
}

// ---------------------------------------------------------------- oxygen sensors

export interface LambdaSample { t: number; v1?: number; v2?: number; int1?: number; int2?: number; clt?: number; rpm?: number }

export interface SensorStats { min: number; max: number; switches: number; per10s: number; meanInt?: number; n: number }

export function sensorStats(s: LambdaSample[], v: 'v1' | 'v2', int: 'int1' | 'int2', windowS = 30): SensorStats {
  const end = s.length ? s[s.length - 1].t : 0;
  const xs = s.filter((x) => x[v] !== undefined && x.t >= end - windowS && (x.rpm ?? 0) > 400);
  if (xs.length < 2) return { min: 0, max: 0, switches: 0, per10s: 0, n: xs.length };
  let state: 'rich' | 'lean' | '' = '';
  let switches = 0;
  for (const x of xs) {
    const now: 'rich' | 'lean' | '' = x[v]! > 0.55 ? 'rich' : x[v]! < 0.35 ? 'lean' : state;
    if (state && now !== state) switches++;
    state = now;
  }
  const ints = xs.map((x) => x[int]).filter((n): n is number => n !== undefined);
  const span = xs[xs.length - 1].t - xs[0].t || 1;
  return { min: Math.min(...xs.map((x) => x[v]!)), max: Math.max(...xs.map((x) => x[v]!)), switches, per10s: (switches * 10) / span, meanInt: ints.length ? ints.reduce((a, b) => a + b, 0) / ints.length : undefined, n: xs.length };
}

export function lambdaVerdicts(s: LambdaSample[]): Verdict[] {
  const last = s[s.length - 1];
  if (!last || (last.rpm ?? 0) < 400) return [{ level: 'info', title: 'Start the engine', text: 'The sensors are read with the engine running and warm.' }];
  const out: Verdict[] = [];
  if ((last.clt ?? 90) < 75) out.push({ level: 'info', title: `Engine at ${Math.round(last.clt!)} °C`, text: 'Below about 75 °C the DME may still run without the sensors (open loop). Wait until it is warm.' });
  for (const [bank, v, int] of [['Bank 1 (cyl. 1–3)', 'v1', 'int1'], ['Bank 2 (cyl. 4–6)', 'v2', 'int2']] as const) {
    const st = sensorStats(s, v, int);
    if (st.n < 8) continue;
    const corr = st.meanInt !== undefined ? ` Mixture correction ${((st.meanInt - 1) * 100).toFixed(0)}%.` : '';
    if (st.max < 0.3) out.push({ level: 'bad', title: `${bank}: stays lean`, text: `Never above ${st.max.toFixed(2)} V. Vacuum leak (crankcase vent valve, intake boots, dipstick tube), low fuel pressure, or a dead sensor.${corr}` });
    else if (st.min > 0.6) out.push({ level: 'bad', title: `${bank}: stays rich`, text: `Never below ${st.min.toFixed(2)} V. Leaking injector, high fuel pressure, or a contaminated sensor.${corr}` });
    else if (st.per10s < 1.5) out.push({ level: 'warn', title: `${bank}: switches slowly`, text: `${st.switches} swings in ${Math.round((st.n || 1))} reads (${st.per10s.toFixed(1)} per 10 s). A healthy sensor swings several times every 10 seconds; slow swinging is typical of an aged sensor. The app reads a few times per second, so very fast switching shows as fewer swings: confirm at 2 500 rpm.${corr}` });
    else out.push({ level: 'ok', title: `${bank}: switching`, text: `${st.min.toFixed(2)}–${st.max.toFixed(2)} V, ${st.per10s.toFixed(1)} swings per 10 s.${corr}` });
    if (st.meanInt !== undefined && Math.abs(st.meanInt - 1) > 0.1) out.push({ level: 'warn', title: `${bank}: large mixture correction`, text: `The DME corrects the fuel by ${((st.meanInt - 1) * 100).toFixed(0)}%. Positive: it adds fuel (air leak, weak fuel pump, dirty air-mass meter). Negative: it removes fuel (leaking injector, high fuel pressure).` });
  }
  return out;
}

// ---------------------------------------------------------------- misfires

export const CYLINDERS = [1, 2, 3, 4, 5, 6];

export interface MisfireData { rough: (number | undefined)[]; count: (number | undefined)[] }

/** Per-cylinder values from STATUS_SYSTEMCHECK_LAUFUNRUHE (or LESEN_SYSTEMCHECK_LAUFUNRUHE). */
export function misfireData(values: Value[]): MisfireData {
  return {
    rough: CYLINDERS.map((c) => pick(values, new RegExp(`LAUFUNRUHE_ZYL${c}_WERT$`))),
    count: CYLINDERS.map((c) => pick(values, new RegExp(`VERBRENNUNGSAUSSETZER_ZYL${c}_WERT$`))),
  };
}

export function misfireVerdicts(d: MisfireData, running: boolean): Verdict[] {
  if (!running) return [{ level: 'info', title: 'Start the engine', text: 'Rough running is measured at idle with a warm engine.' }];
  const r = d.rough.map((x) => x ?? 0);
  const c = d.count.map((x) => (x !== undefined && x >= 0 && x < 30000 ? x : 0));
  if (r.every((x) => x === 0) && c.every((x) => x === 0)) return [{ level: 'info', title: 'No values yet', text: 'All cylinders read zero. Let it idle for a while, or start the DME misfire check.' }];
  const sorted = [...r].sort((a, b) => a - b);
  const median = (sorted[2] + sorted[3]) / 2 || 0.0001;
  const rough = CYLINDERS.filter((_, i) => r[i] > median * 2 && r[i] > median + 0.15);
  const counted = CYLINDERS.filter((_, i) => c[i] > 0);
  const out: Verdict[] = [];
  if (counted.length) out.push({ level: counted.length > 2 ? 'warn' : 'bad', title: `Misfires counted on cylinder ${counted.join(', ')}`, text: counted.length > 2 ? 'Several cylinders: look for something they share: vacuum leak, fuel pressure, a crankshaft sensor fault, or bad fuel.' : 'Swap that coil with a neighbouring cylinder, clear the faults and read again: if the misfire follows the coil, replace the coil; if it stays, check the plug, then the injector.' });
  if (rough.length) out.push({ level: 'warn', title: `Cylinder ${rough.join(', ')} runs rougher than the others`, text: 'More than twice the middle value of the six. Same order of checks: coil, plug, injector, then compression.' });
  if (!out.length) out.push({ level: 'ok', title: 'Even running', text: 'No misfires counted and no cylinder stands out.' });
  return out;
}
