// Files of the AI Diagnosis export: what an AI (Claude, ChatGPT, Gemini…) needs to analyse the car, plus
// ANALYZE.md telling it what to look at. The same guide will be the prompt of the built-in analysis later.
// Nothing is sent anywhere: the user saves the files and decides where they go. VINs are masked.

import type { CarId } from './carid';
import { carLine } from './carid';
import { baseKey } from './reference';
import { maskVinText } from './report';
import { METRIC } from './telemetry';
import { zip } from '../util/zip';
import {
  COND_TEXT, CONDS, Cond, DERIVED, FaultLine, Recorder, STEPS, compareFaults,
} from './aidiag';

export interface ExportInfo {
  app: string;
  car: CarId;
  /** modules that answered the scan */
  modules: { short: string; name: string; variant: string; ident: Record<string, string | number> }[];
  connection: string;
  now: number;
}

const iso = (t: number) => new Date(t).toISOString();
const csvCell = (c: unknown) => {
  const s = c === null || c === undefined ? '' : String(c);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const r3 = (x: number) => String(Math.round(x * 1000) / 1000);

// ------------------------------------------------------------------ session.csv
interface Col {
  ch: number;
  k: number;
  name: string;
}
function rawColumns(rec: Recorder): Col[] {
  const cols: Col[] = [];
  const seen = new Map<string, number>();
  rec.channels.forEach((c, ch) =>
    c.keys.forEach((key, k) => {
      let name = `${c.mod}.${baseKey(key.key)}`;
      if (seen.has(name)) name = `${name}@${c.job}`;
      seen.set(name, 1);
      const label = key.label && key.label.toUpperCase() !== key.key.toUpperCase() && key.label.toUpperCase() !== baseKey(key.key) ? ` ${key.label}` : '';
      cols.push({ ch, k, name: `${name}${label}${key.unit ? ` [${key.unit}]` : ''}` });
    }));
  return cols;
}

/** Base rows: the DME data block (every cycle). With no DME (unusual) every row is a base row. */
function baseCh(rec: Recorder) {
  const i = rec.channels.findIndex((c) => c.mod === 'DME');
  return i;
}

/**
 * One line per engine read, with every other value at that moment (the latest one read: gearbox ~4×/s,
 * other DME groups every few seconds, ABS every 5 s). Key metrics come first, already converted.
 */
export function sessionCsv(rec: Recorder): string {
  const cols = rawColumns(rec);
  const head = ['time', 't_s', 'phase', 'condition', 'gear', ...DERIVED.map((id) => `key.${id} (${METRIC[id].unit})`), ...cols.map((c) => c.name)];
  const at = new Map<string, number>();
  cols.forEach((c, i) => at.set(`${c.ch}|${c.k}`, i));
  const cur: (number | string | null)[] = cols.map(() => null);
  const base = baseCh(rec);
  const t0 = rec.rows[0]?.t ?? 0;
  const out: unknown[][] = [head];
  let last: { phase?: string; cond?: string; gear?: string; d?: (number | null)[] } = {};
  for (const r of rec.rows) {
    r.v.forEach((x, k) => {
      if (x !== null) cur[at.get(`${r.ch}|${k}`)!] = x;
    });
    if (r.d) last = r;
    if (base >= 0 ? r.ch !== base : false) continue;
    out.push([iso(r.t), ((r.t - t0) / 1000).toFixed(2), last.phase ?? '', last.cond ?? '', last.gear ?? '', ...DERIVED.map((_, i) => last.d?.[i] ?? ''), ...cur]);
  }
  return csv(out);
}

// ------------------------------------------------------------------ summary.csv
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, min: s[0], p05: q(0.05), mean: s.reduce((a, b) => a + b, 0) / s.length, p95: q(0.95), max: s[s.length - 1] };
}

export interface SummaryLine {
  metric: string;
  label: string;
  unit: string;
  cond: Cond | 'all';
  n: number;
  min: number;
  p05: number;
  mean: number;
  p95: number;
  max: number;
}

/** Min / 5th percentile / mean / 95th percentile / max of every numeric value, overall and by driving condition. */
export function summary(rec: Recorder): SummaryLine[] {
  const acc = new Map<string, { unit: string; label: string; by: Map<Cond | 'all', number[]> }>();
  const push = (metric: string, label: string, unit: string, c: Cond | undefined, x: number) => {
    let a = acc.get(metric);
    if (!a) acc.set(metric, (a = { unit, label, by: new Map() }));
    for (const k of c ? ['all', c] as const : ['all'] as const) {
      const arr = a.by.get(k) ?? a.by.set(k, []).get(k)!;
      arr.push(x);
    }
  };
  let cond: Cond | undefined;
  for (const r of rec.rows) {
    if (r.cond) cond = r.cond;
    if (r.d) r.d.forEach((x, i) => { if (x !== null) push(`key.${DERIVED[i]}`, METRIC[DERIVED[i]].label.toLowerCase(), METRIC[DERIVED[i]].unit, cond, x); });
    const c = rec.channels[r.ch];
    r.v.forEach((x, k) => {
      if (typeof x === 'number') push(`${c.mod}.${baseKey(c.keys[k].key)}`, c.keys[k].label, c.keys[k].unit, cond, x);
    });
  }
  const out: SummaryLine[] = [];
  for (const [metric, a] of acc)
    for (const k of ['all', ...CONDS] as const) {
      const xs = a.by.get(k);
      if (xs?.length) out.push({ metric, label: a.label, unit: a.unit, cond: k, ...stats(xs) });
    }
  return out;
}
export function summaryCsv(rec: Recorder): string {
  return csv([['metric', 'label', 'unit', 'condition', 'samples', 'min', 'p05', 'mean', 'p95', 'max'], ...summary(rec).map((s) => [s.metric, s.label, s.unit, s.cond, s.n, r3(s.min), r3(s.p05), r3(s.mean), r3(s.p95), r3(s.max)])]);
}

/** Time spent in each driving condition and guided-test step, in seconds. */
export function timeSplit(rec: Recorder) {
  const cond = new Map<string, number>(), phase = new Map<string, number>();
  let prev: { t: number; cond?: string; phase?: string } | undefined;
  for (const r of rec.rows) {
    if (!r.d) continue;
    if (prev) {
      const dt = Math.min(2, (r.t - prev.t) / 1000);
      cond.set(prev.cond ?? '', (cond.get(prev.cond ?? '') ?? 0) + dt);
      phase.set(prev.phase ?? '', (phase.get(prev.phase ?? '') ?? 0) + dt);
    }
    prev = { t: r.t, cond: r.cond, phase: r.phase };
  }
  return { cond, phase };
}

// ------------------------------------------------------------------ faults.csv, events.csv, car.json
export function faultsCsv(rec: Recorder): string {
  const lines = compareFaults(rec.faults);
  const reads = rec.faults.map((f) => [iso(f.t), f.when, f.mod, '', '', '', f.error ? `read failed: ${f.error}` : `${f.dtcs.length} fault(s) read`, '', '', '', '', '']);
  return csv([
    ['read_at', 'status', 'module', 'code', 'obd_code', 'present_now', 'text', 'frequency', 'details', 'conditions_when_stored', 'original_text', 'module_name'],
    ...lines.map((l) => faultRow(l)),
    [],
    ['# fault memory reads'],
    ...reads,
  ]);
}
function faultRow(l: FaultLine): unknown[] {
  const d = l.dtc;
  return [iso(l.t), l.status, l.mod, d.label ?? d.hex, d.pcode ?? '', d.present === null ? '' : d.present ? 'yes' : 'no', d.text, d.frequency ?? '', d.details.join(' | '),
    d.env.map((e) => `${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`).join(' | '), d.textOriginal, l.name];
}

export function eventsCsv(rec: Recorder): string {
  return csv([['time', 'type', 'event'], ...rec.events.map((e) => [iso(e.t), e.type, e.text])]);
}

export function carJson(rec: Recorder, info: ExportInfo): string {
  const t = timeSplit(rec);
  const mask = (o: Record<string, string | number>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !/VIN|FGNR|FAHRGESTELL|CHASSIS/i.test(k)).map(([k, v]) => [k, typeof v === 'string' ? maskVinText(v) : v]));
  return JSON.stringify({
    exported: iso(info.now),
    app: `E46Fanatics Scan ${info.app}`,
    connection: info.connection,
    car: { model: info.car.model ?? null, engine: info.car.engine ?? null, dme_family: info.car.family, gearbox: info.car.gearbox, summary: carLine(info.car), how_detected: info.car.how },
    recording: {
      from: rec.rows[0] ? iso(rec.rows[0].t) : null,
      to: rec.rows.length ? iso(rec.rows[rec.rows.length - 1].t) : null,
      minutes: Math.round(rec.spanMs / 600) / 100,
      rows: rec.rows.length,
      seconds_by_condition: Object.fromEntries([...t.cond].map(([k, v]) => [k, Math.round(v)])),
      seconds_by_guided_step: Object.fromEntries([...t.phase].map(([k, v]) => [k, Math.round(v)])),
      groups_read: rec.channels.map((c) => ({ module: c.mod, file: c.variant, group: c.job, values: c.keys.length })),
    },
    modules: info.modules.map((m) => ({ module: m.short, name: m.name, file: m.variant, ident: mask(m.ident) })),
  }, null, 2) + '\n';
}

// ------------------------------------------------------------------ ANALYZE.md
export function analyzeMd(info: ExportInfo): string {
  const c = info.car;
  const carText = [c.model ? `BMW E46 ${c.model}` : 'BMW E46', c.engine, c.family !== 'unknown' ? `DME ${c.family}` : '', c.gearbox !== 'unknown' ? `${c.gearbox} gearbox` : ''].filter(Boolean).join(', ');
  const refs = refTable(c);
  return `# ANALYZE.md: how to analyse this BMW E46 recording

You are helping the owner of a **${carText}** find out whether something is wrong with the car and what to do
about it. The data was recorded with **E46Fanatics Scan** (${info.app}), a community diagnostic app that reads
the car's modules over the K-line (BMW DS2 protocol, the same data as INPA). Connection: ${info.connection}.

**Answer in the language the user writes to you** (these instructions are in English only for consistency).

## Files

| File | What it is |
|---|---|
| \`car.json\` | The car as detected (DME family, engine, gearbox), module part and software numbers, how long the recording is and how many seconds were spent in each driving condition and guided-test step. |
| \`faults.csv\` | Fault memory of the main modules (engine, gearbox, ABS/DSC, immobilizer, airbag, cluster) read at the **start** and at the **end** of the recording. \`status\`: \`new\` = appeared during the recording, \`persists\` = in both reads, \`cleared\` = gone at the end, \`start_only\`/\`end_only\` = only one read was possible. \`present_now\` = the module says the fault is active now. \`conditions_when_stored\` = the module's freeze frame. |
| \`events.csv\` | Timeline: recording start, guided-test steps, live alerts raised by the app's simple rules, communication problems. |
| \`summary.csv\` | **Start here.** Min, 5th percentile, mean, 95th percentile and max of every numeric value, overall (\`all\`) and by driving condition. |
| \`session.csv\` | The raw recording (up to the last 60 minutes): one line per engine read (several per second). Use it to look at sequences: warm-up curve, VANOS target vs actual, trims during a step, what happened around an alert. It can be large; if you cannot read all of it, work from \`summary.csv\` and read the parts around events. |

### Columns of session.csv
- \`time\` (ISO, UTC), \`t_s\` (seconds from the first line), \`phase\` (guided-test step, \`free\` outside the test), \`condition\` (see below), \`gear\`.
- \`key.*\`: the main metrics, already converted by the app: \`key.stft1\`/\`key.stft2\` short-term fuel trims in % (0 = no correction, + = the DME adds fuel because it sees a lean mixture), \`key.maf\` air mass in g/s, \`key.vin\`/\`key.vex\` VANOS intake/exhaust cam position in °crank, \`key.slip\` torque converter slip in rpm, \`key.atf\` gearbox oil temperature, \`key.rad\` radiator outlet temperature, \`key.ubatt\` battery voltage, \`key.ti\` injection time in ms.
- \`DME.* / EGS.* / ABS.*\`: every value as the module reports it, named as in the BMW module file (German abbreviations, unit in brackets). Examples: MOTORDREHZAHL engine speed, MOTORTEMP coolant, KUEHLW_AUSL_TEMP radiator outlet, AN_LUFTTEMP intake air, LMM_MASSE air mass (kg/h), LAMBDA_INTEGRATOR short-term trim (factor, 1.00 = none), LAMBDA_ADD / LAMBDA_MUL mixture adaptations (additive acts mostly at idle, multiplicative across the load range), L_SONDE oxygen sensor voltage, ZUENDWINKEL ignition angle, VANOS_NW_LAGE cam position (IST = actual, SOLL = target), LAUFUNRUHE rough running per cylinder, GETRIEBETEMPERATUR gearbox oil, TURBINENDREHZAHL turbine speed, GANG gear, RAD/GESCHW wheel speed.
- Values other than the engine data block are **the latest value read** at that moment: gearbox about 4 times a second, other DME groups every few seconds, ABS every 5 seconds. An empty cell means the value was not read yet.

### Driving conditions (column \`condition\`)
${CONDS.map((k) => `- \`${k}\`: ${COND_TEXT[k]}`).join('\n')}

### Guided test steps (column \`phase\`)
${STEPS.map((s) => `- \`${s.id}\` (${s.title}): ${s.how}`).join('\n')}

Steps the user skipped or did not do have no rows; say so instead of guessing what they would have shown.

## Reference values (typical, not limits)
These are typical values for a healthy car of this type, to orient you. They are not BMW specifications;
weigh them against the conditions and the rest of the data, and say when a value is borderline.

${refs}

## What to analyse
1. **Faults first.** Explain each code in plain words, whether it is active, how often it happened and what the freeze frame says. Link it to what the live data shows. A \`new\` fault during the recording is the strongest lead.
2. **Mixture.** Short-term trims and adaptations by condition: lean only at idle (trims/additive high at idle, normal at cruise) points to unmetered air (vacuum leak: crankcase ventilation (CCV) valve and hoses, oil filler cap, dipstick O-ring, intake boot, DISA valve gasket, brake booster hose). Lean or rich across all loads points to the air-mass meter, fuel pressure or injectors. Compare bank 1 with bank 2: one bank only points to that bank (injector, leak, O2 sensor). Check the O2 sensors switch (narrow-band sensors move between about 0.1 and 0.9 V several times a second in closed loop when warm).
3. **Air mass.** Idle air mass in range; air mass against rpm and pedal at full acceleration (a tired MAF reads low and the car feels flat).
4. **Cooling.** The warm-up curve (time to 80 °C), the coolant temperature the DME holds at light load and at high load (the electronic thermostat runs hotter at light load), the radiator outlet against the coolant (the thermostat opening shows as the outlet rising; outlet staying cold with a hot engine = no flow), heat soak at hot idle. Slow warm-up or coolant that never reaches the target = thermostat stuck open. Overheating at idle but not on the move = fan.
5. **VANOS.** Actual against target for intake and exhaust: the actual should follow within a few degrees and settle within about a second. Slow or offset response points to the VANOS solenoids, the VANOS seals (a known M52TU/M54 wear item) or oil pressure/quality.
6. **Ignition and rough running.** Ignition angle at idle and under load (strong retard under load = knock), rough-running values per cylinder (one cylinder clearly worse = coil, plug or injector of that cylinder).
7. **Idle quality.** Idle speed and air mass with and without load (step \`idle_load\`): the idle should hold steady when the A/C and lights come on.
8. **Electrical.** Battery voltage with the engine running (about 13.8 to 14.8 V) and at idle with load.
9. **Gearbox (automatic).** Gearbox oil temperature, converter slip when locked (should be near zero), slip in each gear, gear changes during the drive (hunting, slow changes, flare = rpm rising during the change), behaviour when hot.
10. **ABS/DSC.** The four wheel speeds should agree within about 1–2 km/h when driving straight at a steady speed; one wheel reading zero, jumping or far off points to that wheel's sensor, its ring or the wiring.
11. **Immobilizer and airbag.** Report their faults; do not suggest any work on the airbag system other than a professional check.

## How to answer
1. **Verdict**: one or two lines: the car looks healthy / has points to watch / needs a repair, and how urgent.
2. **Findings**, most important first. For each: what the data shows (quote the values, the condition or step and the time), the likely causes ranked by probability for this engine, how to confirm each one (a check the owner can do, a guided check or live value in the app, or a workshop test), and the usual fix.
3. **Faults explained**, one by one.
4. **What was missing**: data that was not recorded or not available on this connection, and what to record next time (for example a guided-test step that was skipped).

Rules:
- Use only the data in these files. Do not invent values. If the data is not enough to decide, say so and say what would decide it.
- Tell apart a sensor that reads wrong from a real problem (a sensor that is stuck, jumps or disagrees with related values).
- Brakes, airbag, steering and fuel leaks are safety items: recommend a professional inspection.
- Never suggest disabling an emission or safety system.
- The app is read-only by default; if a test or reset in the app would help (for example resetting the mixture adaptations after a repair), mention it as an option, not something already done.
- This analysis is guidance from recorded data, not a workshop diagnosis. Say this once at the end.
`;
}

function refTable(c: CarId): string {
  const m54 = c.family === 'MS43' || c.family === 'MS45' || c.family === 'unknown';
  const auto = c.gearbox !== 'manual' && c.gearbox !== 'SMG';
  const rows: [string, string][] = [
    ['Warm idle speed', c.family === 'MSS54' ? 'about 800–950 rpm' : 'about 600–820 rpm (lower in D on an automatic)'],
    ['Air mass at warm idle', c.family === 'ME9' ? 'about 1.8–3.5 g/s' : c.family === 'MSS54' ? 'about 3–6 g/s' : 'about 2.5–4.5 g/s (a little more with A/C on)'],
    ['Coolant, warm', m54 ? 'the MS43 electronic thermostat holds about 100–110 °C at light load and lets it drop to about 90–95 °C under high load' : 'about 85–105 °C'],
    ['Coolant, warm-up', 'reaches 80 °C within about 10–15 minutes of gentle driving (longer at idle in cold weather)'],
    ['Radiator outlet', 'well below the coolant while the thermostat is closed, rising once it opens; above about 113 °C is too hot'],
    ['Short-term fuel trims', 'mostly within ±10 % when warm; brief spikes on throttle changes are normal; 0 at full load and fuel cut (open loop)'],
    ['Oxygen sensors (pre-cat)', 'switching between about 0.1 and 0.9 V several times a second when warm, in closed loop'],
    ['VANOS', 'intake about 80–120 °crank, exhaust about −105 to −80 °crank (depends on rpm and load); actual follows target within a few degrees'],
    ['Battery, engine running', 'about 13.8–14.8 V; engine off 12.4–12.8 V'],
    ['Intake air', 'ambient plus 5–30 °C (more in stop-and-go and heat soak)'],
  ];
  if (auto)
    rows.push(
      ['Gearbox oil', 'about 70–100 °C in normal driving; above 120 °C is hot'],
      ['Converter slip', 'near 0 rpm (under about 50) when the lock-up clutch is engaged; a few hundred rpm open at low speed is normal'],
    );
  rows.push(['Wheel speeds (ABS)', 'all four within about 1–2 km/h of each other at a steady speed in a straight line']);
  return ['| Value | Typical |', '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n');
}

// ------------------------------------------------------------------ one file to paste or attach
/** ANALYZE.md + car + faults + events + summary in a single markdown file (no raw recording). */
export function aiReportMd(rec: Recorder, info: ExportInfo): string {
  const lines = compareFaults(rec.faults);
  const faults = lines.length
    ? ['| Module | Code | Status | Active | Text | Freeze frame |', '|---|---|---|---|---|---|',
        ...lines.map((l) => `| ${l.mod} | ${l.dtc.label ?? l.dtc.hex}${l.dtc.pcode ? ` (${l.dtc.pcode})` : ''} | ${l.status} | ${l.dtc.present === null ? '' : l.dtc.present ? 'yes' : 'no'} | ${l.dtc.text.replace(/\|/g, '/')} | ${l.dtc.env.map((e) => `${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`).join(', ').replace(/\|/g, '/')} |`)].join('\n')
    : rec.faults.length ? 'No faults stored in the modules that were read.' : 'The fault memory was not read.';
  const reads = rec.faults.map((f) => `- ${iso(f.t)} ${f.when} · ${f.mod}: ${f.error ? `read failed (${f.error})` : `${f.dtcs.length} fault(s)`}`).join('\n');
  const guide = analyzeMd(info).replace(/^# ANALYZE\.md: how to analyse this BMW E46 recording/, '# BMW E46 recording: instructions and data')
    .replace(/## Files[\s\S]*?### Columns of session\.csv/, '## What is in this file\nThis single file has the instructions, the car, the faults, the timeline and the summary statistics. The raw recording (session.csv) is in the .zip export if you need sequences.\n\n### Columns of session.csv (if the user also sends it)');
  return `${guide}
---

## Car (car.json)
\`\`\`json
${carJson(rec, info).trim()}
\`\`\`

## Faults (start and end of the recording)
${faults}

Fault memory reads:
${reads || '- none'}

## Timeline (events.csv)
\`\`\`csv
${eventsCsv(rec).trim()}
\`\`\`

## Summary statistics (summary.csv)
\`\`\`csv
${summaryCsv(rec).trim()}
\`\`\`
`;
}

/** The .zip with every file. */
export async function exportZip(rec: Recorder, info: ExportInfo): Promise<Uint8Array> {
  return zip([
    { name: 'ANALYZE.md', data: analyzeMd(info) },
    { name: 'car.json', data: carJson(rec, info) },
    { name: 'faults.csv', data: faultsCsv(rec) },
    { name: 'events.csv', data: eventsCsv(rec) },
    { name: 'summary.csv', data: summaryCsv(rec) },
    { name: 'session.csv', data: sessionCsv(rec) },
  ], new Date(info.now));
}

