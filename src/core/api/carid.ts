// Which E46 is connected: engine DME family, engine, model and gearbox, from what the scan already found
// (DME file variant and ident, gearbox module answering or not). Used by the Vehicle and ECO screens and the
// car card in the side menu, so references and checks follow the car being read, not the owner's 325i.

export type DmeFamily = 'MS42' | 'MS43' | 'MS45' | 'ME9' | 'MSS54' | 'DDE' | 'unknown';
export type Gearbox = 'automatic' | 'SMG' | 'manual' | 'unknown';
/** what the app does with this DME today */
export type Support = 'full' | 'partial' | 'obd';

export interface FamilyInfo {
  family: Exclude<DmeFamily, 'unknown'>;
  engines: string;
  models: string;
  support: Support;
  /** what "support" means for this family */
  note: string;
}

/** Engine DME families fitted to the E46 (dates vary by market: the DME's own ident decides). */
export const DME_FAMILIES: FamilyInfo[] = [
  { family: 'MS42', engines: 'M52TU', models: '323i, 328i (1998–2000)', support: 'partial', note: 'Faults and live data with its module file; engine cooling calibration readable' },
  { family: 'MS43', engines: 'M54', models: '320i, 325i, 330i (2000–2003)', support: 'full', note: 'Everything: faults, live data, guided checks, ECO, engine cooling calibration' },
  { family: 'MS45', engines: 'M54 / M56', models: '325i, 330i from 2003 (mainly US)', support: 'obd', note: 'OBD-II engine data until its module file is added' },
  { family: 'ME9', engines: 'N42 / N46', models: '316i, 318i', support: 'obd', note: 'OBD-II engine data until its module file is added' },
  { family: 'MSS54', engines: 'S54', models: 'M3', support: 'obd', note: 'OBD-II engine data until its module file is added' },
  { family: 'DDE', engines: 'M47 / M57', models: 'Diesel (318d, 320d, 330d)', support: 'obd', note: 'OBD-II engine data; ECO fuel checks are for petrol engines' },
];

export interface CarIdInput {
  /** resolved file variant of the engine module (e.g. "ms430ds0"), "native:12" in plug-and-play mode */
  dmeVariant?: string | null;
  dmeIdent?: Record<string, string | number>;
  /** gearbox module (0x32) */
  egsVariant?: string | null;
  /** true once the scan has tried the gearbox address */
  egsScanned?: boolean;
}

export interface CarId {
  family: DmeFamily;
  info?: FamilyInfo;
  /** e.g. "M54B25" */
  engine?: string;
  /** e.g. "325i" */
  model?: string;
  gearbox: Gearbox;
  /** how each part was found, for the Vehicle screen */
  how: { family: string; engine: string; gearbox: string };
}

export function familyOfVariant(v: string | null | undefined): DmeFamily {
  const s = String(v ?? '').toLowerCase();
  if (/^ms43/.test(s)) return 'MS43';
  if (/^ms42/.test(s)) return 'MS42';
  if (/^ms45/.test(s)) return 'MS45';
  if (/^mss54/.test(s)) return 'MSS54';
  if (/^me9|^bms46|^me9n4/.test(s)) return 'ME9';
  if (/^(dde|d[0-9]{2}m[45]7|d50|d60|d40|ddem)/.test(s)) return 'DDE';
  return 'unknown';
}

/** "M54_25", "M54B25", "M54 2.5" → { code: "M54B25", liters: 2.5 } */
export function parseEngine(raw: unknown): { code: string; liters?: number } | undefined {
  const t = String(raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = t.match(/\b([MNS]\d{2})(?:TU)?[ _B-]?(\d{2})?\b/) ?? t.match(/\b([MNS]\d{2})/);
  if (!m) return undefined;
  const cc = m[2] ? Number(m[2]) : undefined;
  return { code: cc ? `${m[1]}B${m[2]}` : m[1], liters: cc ? cc / 10 : undefined };
}

/** BMW part numbers of engine DMEs (plug-and-play mode, no module file): public DME supplier lists and the
 * reference car's own MS43 (7545150). Partial lists: an unknown number just leaves the family open. */
const PARTS: Record<string, Exclude<DmeFamily, 'unknown'>> = Object.fromEntries([
  ...['1429810', '1429811', '1430268', '1430338', '1430273', '1438787', '1430671', '1430672', '1430785', '1430786', '1430844', '1430845', '4509413', '7500255', '7500256', '7505859', '7506345', '7526753', '7526754'].map((n) => [n, 'MS42']),
  ...['7545150', '7571017', '7571290', '7572342', '7572371'].map((n) => [n, 'MS43']),
  ...['7512523', '7514833', '7527015', '7522584', '7523810', '7525937', '7526791', '7527110', '7524718', '7530211', '7531500', '7531442', '7532142', '7532903', '7533652', '7533654', '7541336', '7541344', '7543158', '7543224', '7548770', '7548772', '7549388', '7549391', '7549795', '7561382', '7561383'].map((n) => [n, 'MS45']),
]);
export const familyOfPart = (nr: unknown): DmeFamily => PARTS[String(nr ?? '').replace(/\D/g, '').slice(-7)] ?? 'unknown';

const MODEL_BY_ENGINE: Record<string, string> = {
  M54B22: '320i', M54B25: '325i', M54B30: '330i', M56B25: '325i', M52B25: '323i', M52B28: '328i',
  N42B18: '318i', N46B18: '318i', N42B20: '318i', N46B20: '318i', S54B32: 'M3',
};

export function identifyCar(x: CarIdInput): CarId {
  let family = familyOfVariant(x.dmeVariant);
  let howFamily = family !== 'unknown' ? `engine module file ${String(x.dmeVariant).toUpperCase()}` : '';
  const eng = parseEngine(x.dmeIdent?.ID_MOTOR);
  if (family === 'unknown' && familyOfPart(x.dmeIdent?.ID_BMW_NR) !== 'unknown') {
    family = familyOfPart(x.dmeIdent?.ID_BMW_NR);
    howFamily = `DME part number ${x.dmeIdent?.ID_BMW_NR}`;
  }
  if (family === 'unknown' && eng) {
    // no module file: guess the family from the engine the DME names
    if (eng.code.startsWith('M54')) { family = 'MS43'; howFamily = 'engine named by the DME (M54: MS43, or MS45 on later cars)'; }
    else if (eng.code.startsWith('M52')) { family = 'MS42'; howFamily = 'engine named by the DME'; }
  }
  if (family === 'unknown') howFamily = !x.dmeVariant ? 'engine module not found yet' : x.dmeIdent?.ID_BMW_NR ? `DME ${x.dmeIdent.ID_BMW_NR} not in the list: OBD-II only` : 'not recognised: OBD-II only';
  const info = DME_FAMILIES.find((f) => f.family === family);
  const engineCode = eng?.code;
  let gearbox: Gearbox = 'unknown';
  let howGear = 'gearbox module not checked yet';
  const egs = String(x.egsVariant ?? '').toLowerCase();
  if (egs) {
    gearbox = /smg/.test(egs) ? 'SMG' : 'automatic';
    howGear = `gearbox module answered (${egs.startsWith('native:') ? 'DS2 ident' : egs.toUpperCase()})`;
  } else if (x.egsScanned) {
    gearbox = 'manual';
    howGear = 'no automatic gearbox module answered';
  }
  return {
    family,
    info,
    engine: engineCode,
    model: engineCode ? MODEL_BY_ENGINE[engineCode] : undefined,
    gearbox,
    how: { family: howFamily, engine: engineCode ? 'DME ident (ID_MOTOR)' : 'not reported', gearbox: howGear },
  };
}

/** One line for the side menu card: "M54B25 · MS43 · Automatic". */
export function carLine(c: CarId): string {
  const g = c.gearbox === 'unknown' ? '' : c.gearbox === 'SMG' ? 'SMG' : c.gearbox[0].toUpperCase() + c.gearbox.slice(1);
  return [c.engine, c.family === 'unknown' ? '' : c.family, g].filter(Boolean).join(' · ');
}
