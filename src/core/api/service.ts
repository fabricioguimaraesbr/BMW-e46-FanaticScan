// Service procedures for the E46: what each one is for, what must be true before running it, and which job of the
// module's own file performs it. Written for this app; the only BMW strings are job names (identifiers in the files).
// Every procedure runs through the normal session, so the safety rules apply unchanged: readings always, actuator
// tests and adaptation resets only after "Unlock tests & resets", permanent writes never.

import type { JobListEntry } from './DiagSession';
import type { JobSafety } from './safety';

export type ServiceCategory = 'Adaptations' | 'Brakes & DSC' | 'Engine checks' | 'Instruments & lights' | 'Calibration & service';

export interface ServiceTask {
  id: string;
  name: string;
  category: ServiceCategory;
  /** module short name (DME, EGS, ABS, IKE, LCM…) */
  module: string;
  what: string;
  /** conditions the user confirms one by one before the Run button unlocks */
  before: string[];
  /** what to do afterwards */
  after?: string;
  /** candidate jobs; the first one the module's file has is used */
  jobs?: string[];
  /** a pick of jobs (one per cylinder, per side…); only the ones the module has are offered */
  choices?: { label: string; job: string }[];
  /** shown when the procedure exists only as a permanent write, which this version never sends */
  blockedNote?: string;
}

const PARKED = 'Car parked, handbrake on, selector in P (automatic) or neutral';
const IGN_ON = 'Ignition on (key position 2), engine off';

export const SERVICE_TASKS: ServiceTask[] = [
  // ---------------------------------------------------------------- adaptations
  {
    id: 'dme-adapt-all',
    name: 'Reset all engine adaptations',
    category: 'Adaptations',
    module: 'DME',
    what: 'Erases everything the engine computer has learned (idle, mixture, throttle, knock, misfire). Use it after a repair that changed how the engine breathes or fuels, so the old corrections do not mask or fight the fix.',
    before: [IGN_ON, 'The repair is finished and no fault is present', 'Battery charged (above 12.4 V)'],
    after: 'Start the engine and let it idle for about 10 minutes with lights, A/C and fan off, then drive normally. Idle can be uneven for the first minutes.',
    jobs: ['ADAPT_LOESCHEN'],
  },
  {
    id: 'dme-adapt-throttle',
    name: 'Reset throttle adaptation',
    category: 'Adaptations',
    module: 'DME',
    what: 'Forgets the learned throttle position. Use it after cleaning or replacing the throttle body.',
    before: [IGN_ON, 'Throttle body clean and connected'],
    after: 'Leave the ignition on for 30 seconds without touching the pedal, then start and idle for a few minutes.',
    jobs: ['ADAPT_DROSSELKLAPPE_LOESCHEN'],
  },
  {
    id: 'dme-adapt-mixture',
    name: 'Reset mixture (lambda) adaptation',
    category: 'Adaptations',
    module: 'DME',
    what: 'Forgets the learned fuel trims. Use it after fixing an air leak or replacing the air mass meter, oxygen sensors or injectors.',
    before: [IGN_ON, 'The leak or part is fixed'],
    after: 'Idle until warm, then drive 15–20 minutes with steady cruising so the trims are learned again. Watch the trims in Live Data.',
    jobs: ['ADAPT_LAMBDA_LOESCHEN'],
  },
  {
    id: 'dme-adapt-idle',
    name: 'Reset idle adaptation',
    category: 'Adaptations',
    module: 'DME',
    what: 'Forgets the learned idle air amount. Use it after cleaning or replacing the idle control valve.',
    before: [IGN_ON],
    after: 'Idle for 10 minutes with all consumers off.',
    jobs: ['ADAPT_LEERLAUF_LOESCHEN'],
  },
  {
    id: 'dme-adapt-roughness',
    name: 'Reset misfire detection adaptation',
    category: 'Adaptations',
    module: 'DME',
    what: 'Forgets the learned crankshaft wheel tolerances used for misfire detection. Use it after replacing the crankshaft sensor, flywheel or clutch.',
    before: [IGN_ON],
    after: 'Drive and coast from about 4,000 rpm down in a high gear without touching the throttle a few times, so the wheel is learned again.',
    jobs: ['ADAPT_LAUFUNRUHE_LOESCHEN'],
  },
  {
    id: 'dme-adapt-knock',
    name: 'Reset knock control adaptation',
    category: 'Adaptations',
    module: 'DME',
    what: 'Forgets learned ignition retard. Use it after changing to a different fuel quality or replacing knock sensors.',
    before: [IGN_ON],
    jobs: ['ADAPT_KLOPFREGELUNG_LOESCHEN'],
  },
  {
    id: 'dme-read-adapt',
    name: 'Read engine adaptation values',
    category: 'Adaptations',
    module: 'DME',
    what: 'Shows what the engine computer has learned, without changing anything. Useful before and after a repair.',
    before: [],
    jobs: ['STATUS_LL_ADAPTION', 'STATUS_ADAPTION_GEMISCH', 'STATUS_ADAPTION_DK_LLSTELLER', 'STATUS_DK_ADAPTION', 'STATUS_GEMISCH'],
  },
  {
    id: 'egs-adapt',
    name: 'Reset transmission adaptations',
    category: 'Adaptations',
    module: 'EGS',
    what: 'Erases the learned shift pressures and timing of the automatic transmission. Use it after a fluid change, a valve body repair or when shifts stay harsh.',
    before: [IGN_ON, 'Selector in P', 'Transmission fluid level correct'],
    after: 'Drive gently through all gears several times, with light and then moderate throttle. Shifts settle over the next 50–100 km.',
    jobs: ['RESET_ADAPTION'],
  },
  {
    id: 'egs-read-adapt',
    name: 'Read transmission adaptation values',
    category: 'Adaptations',
    module: 'EGS',
    what: 'Shows the learned shift values, without changing anything.',
    before: [],
    jobs: ['ADAPTIONSWERTE_80_LESEN'],
  },
  // ---------------------------------------------------------------- brakes
  {
    id: 'dsc-bleed-service',
    name: 'Bleed the ABS/DSC unit',
    category: 'Brakes & DSC',
    module: 'ABS',
    what: 'Runs the pump and valves of the hydraulic unit so trapped air leaves the unit, for a brake bleed after the unit or a line was opened.',
    before: [PARKED, IGN_ON, 'Bleeder device connected and reservoir full', 'A helper at the bleed screws'],
    after: 'Bleed the wheels in the usual order, check the pedal, then read the ABS fault memory.',
    jobs: ['ENTLUEFTUNG_SERVICE'],
  },
  {
    id: 'dsc-bleed-secondary',
    name: 'Bleed the secondary brake circuit',
    category: 'Brakes & DSC',
    module: 'ABS',
    what: 'Opens the valves of one side so the secondary circuit can be bled, after the hydraulic unit was replaced.',
    before: [PARKED, IGN_ON, 'Bleeder device connected and reservoir full', 'Bleed screw of that side open with a hose into a bottle'],
    choices: [
      { label: 'Left', job: 'NA_ENTLUEFTUNG_LI' },
      { label: 'Right', job: 'NA_ENTLUEFTUNG_RE' },
    ],
  },
  {
    id: 'abs-pump',
    name: 'ABS return pump test',
    category: 'Brakes & DSC',
    module: 'ABS',
    what: 'Runs the return pump of one axle circuit. A healthy pump is clearly heard.',
    before: [PARKED, IGN_ON],
    choices: [
      { label: 'Front axle', job: 'PUMPENFOERDERLEISTUNG_VO' },
      { label: 'Rear axle', job: 'PUMPENFOERDERLEISTUNG_HA' },
    ],
  },
  // ---------------------------------------------------------------- engine checks
  {
    id: 'dme-injector-cut',
    name: 'Switch off one injector (cylinder balance)',
    category: 'Engine checks',
    module: 'DME',
    what: 'Cuts one injector while the engine idles. A healthy cylinder makes the idle drop and shake; a cylinder that changes nothing is the misfiring one.',
    before: [PARKED, 'Engine running at warm idle', 'Nobody near the engine bay'],
    after: 'The injector comes back by itself; read the DME fault memory afterwards (cutting an injector can store a misfire fault).',
    choices: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `Cylinder ${n}`, job: `STEUERN_EV_${n}_AUS` })),
  },
  // ---------------------------------------------------------------- instruments
  {
    id: 'ike-selftest',
    name: 'Instrument cluster self-test',
    category: 'Instruments & lights',
    module: 'IKE',
    what: 'Sweeps the needles and lights the display segments, to check the gauges and the display.',
    before: [IGN_ON],
    jobs: ['STEUERN_SELBSTTEST'],
  },
  {
    id: 'lcm-selftest',
    name: 'Light module self-test',
    category: 'Instruments & lights',
    module: 'LCM',
    what: 'Switches the exterior lights on in turn so each bulb can be checked from outside the car.',
    before: [PARKED, IGN_ON, 'A helper outside the car'],
    jobs: ['STEUERN_SELBSTTEST'],
  },
  // ---------------------------------------------------------------- blocked (permanent writes)
  {
    id: 'ike-service-reset',
    name: 'Service interval reset',
    category: 'Calibration & service',
    module: 'IKE',
    what: 'Resets the oil service or inspection reminder in the cluster.',
    before: [],
    jobs: ['SIA_RESET'],
    blockedNote: 'Writes the cluster memory permanently, which this version never does. The cluster has its own reset procedure with the trip reset button.',
  },
  {
    id: 'steering-angle',
    name: 'Steering angle sensor calibration',
    category: 'Calibration & service',
    module: 'ABS',
    what: 'Teaches the DSC where straight ahead is, after an alignment or a steering repair.',
    before: [],
    jobs: ['ABGLEICH_LWS_AQ_SENSOREN', 'LENKWINKEL_DSC_ABGLEICHEN', 'ABGLEICH_DSC_SENSOREN'],
    blockedNote: 'Stores the calibration permanently in the DSC, which this version never does.',
  },
  {
    id: 'dsc-sensor-cal',
    name: 'DSC pressure and lateral sensor calibration',
    category: 'Calibration & service',
    module: 'ABS',
    what: 'Zeroes the brake pressure and lateral acceleration sensors after replacing them.',
    before: [],
    jobs: ['DRUCKSENSOR_DSC_ABGLEICHEN', 'QUERBESCHLEUNIGUNGSSENSOR_DSC_ABGLEICHEN', 'QUERBESCHLEUNIGUNG_DSC_ABGLEICHEN'],
    blockedNote: 'Stores the calibration permanently in the DSC, which this version never does.',
  },
];

export interface ResolvedChoice {
  label: string;
  job: JobListEntry;
}
export interface ResolvedTask {
  task: ServiceTask;
  /** the jobs that will run (one, or the ones picked from choices) */
  options: ResolvedChoice[];
  safety: JobSafety;
}

/** Matches a procedure against the module's job list. Returns null when the module's file has none of its jobs. */
export function resolveTask(task: ServiceTask, jobs: JobListEntry[]): ResolvedTask | null {
  const byName = new Map(jobs.map((j) => [j.name.toUpperCase(), j]));
  let options: ResolvedChoice[] = [];
  if (task.blockedNote) {
    // shown so people know why it is missing; never run
    const j = (task.jobs ?? []).map((n) => byName.get(n.toUpperCase())).find((x) => !!x);
    return j ? { task, options: [{ label: j.comment || j.name, job: j }], safety: 'write' } : null;
  }
  if (task.choices) {
    options = task.choices.map((c) => ({ label: c.label, job: byName.get(c.job.toUpperCase())! })).filter((c) => c.job && !c.job.args.length);
  } else {
    const found = (task.jobs ?? []).map((n) => byName.get(n.toUpperCase())).filter((j): j is JobListEntry => !!j && !j.args.length);
    // a reading procedure runs all the reading jobs it lists; anything else runs the first one found
    const read = found.filter((j) => j.safety === 'read');
    options = (read.length === found.length && read.length ? read : found.slice(0, 1)).map((j) => ({ label: j.comment || j.name, job: j }));
  }
  if (!options.length) return null;
  const order: JobSafety[] = ['read', 'clear', 'test', 'reset', 'write'];
  const safety = options.map((o) => o.job.safety).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  return { task, options, safety };
}
