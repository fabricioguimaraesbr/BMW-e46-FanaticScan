// What the car is: the factory order (FA, "Fahrzeugauftrag") stored in the instrument cluster and in the light
// module, and whether the VIN and the mileage agree between the modules.
//
// FA as the cluster returns it (C_FA_LESEN): "E46_#0301*AV31%0354&N6SW$205$210$302...+ABCD-EFGH"
//   E46_  series        #MMYY  build date (time criterion)    *XXXX  type key
//   %NNNN paint code    &XXXX  upholstery code               $NNN   option (SA) codes
//   +XXXX / -XXXX       E-words / HO-words (codes for factory / dealer installed retrofits)

export interface FactoryOrder {
  raw: string;
  series: string;
  /** month 1-12 and four-digit year of the build date, when present */
  built?: { month: number; year: number };
  typeKey: string;
  paint: string;
  upholstery: string;
  options: string[];
  eWords: string[];
  hoWords: string[];
}

/** Parses an FA string. Unknown parts are kept in raw; returns null when there is nothing that looks like an FA. */
export function parseFa(raw: string): FactoryOrder | null {
  const s = raw.replace(/[\0\xff]+[\s\S]*$/, '').replace(/\s+/g, '').trim();
  if (!s || !/[#*%&$]/.test(s)) return null;
  const fa: FactoryOrder = { raw: s, series: '', typeKey: '', paint: '', upholstery: '', options: [], eWords: [], hoWords: [] };
  const head = /^([A-Z]\d{2,3})_?/i.exec(s);
  if (head) fa.series = head[1].toUpperCase();
  for (const m of s.matchAll(/([#*%&$+-])([A-Z0-9]+)/gi)) {
    const [, k, v] = m;
    const val = v.toUpperCase();
    if (k === '#' && /^\d{4}$/.test(val)) {
      const month = Number(val.slice(0, 2));
      const yy = Number(val.slice(2));
      if (month >= 1 && month <= 12) fa.built = { month, year: yy < 80 ? 2000 + yy : 1900 + yy };
    } else if (k === '*') fa.typeKey = val;
    else if (k === '%') fa.paint = val;
    else if (k === '&') fa.upholstery = val;
    else if (k === '$') fa.options.push(val);
    else if (k === '+') fa.eWords.push(val);
    else if (k === '-') fa.hoWords.push(val);
  }
  return fa.typeKey || fa.options.length || fa.built ? fa : null;
}

/** Common E46 option (SA) codes. Codes not in the list are shown with their number only. */
export const SA_TEXT: Record<string, string> = {
  '205': 'Automatic transmission',
  '210': 'Dynamic Stability Control (DSC)',
  '216': 'Servotronic',
  '220': 'Self-levelling suspension',
  '240': 'Leather steering wheel',
  '249': 'Multi-function steering wheel',
  '255': 'Sports leather steering wheel',
  '302': 'Alarm system',
  '320': 'Model designation deleted',
  '354': 'Green windscreen tint band',
  '386': 'Roof rails',
  '401': 'Electric sliding/tilting sunroof',
  '403': 'Electric glass sunroof',
  '423': 'Velour floor mats',
  '428': 'Warning triangle and first-aid kit',
  '430': 'Auto-dimming interior and exterior mirrors',
  '431': 'Auto-dimming interior mirror',
  '438': 'Wood trim',
  '441': 'Smoker package',
  '459': 'Electric seats with memory',
  '465': 'Through-loading system (ski bag)',
  '473': 'Front armrest',
  '488': 'Lumbar support',
  '494': 'Heated front seats',
  '496': 'Heated rear seats',
  '502': 'Headlight washers',
  '508': 'Park Distance Control (PDC)',
  '520': 'Fog lights',
  '521': 'Rain sensor',
  '522': 'Xenon headlights',
  '534': 'Automatic climate control',
  '540': 'Cruise control',
  '548': 'Speedometer in km/h',
  '550': 'On-board computer',
  '563': 'Light package',
  '606': 'Navigation system Business',
  '609': 'Navigation system Professional',
  '620': 'Voice input',
  '650': 'CD player',
  '672': 'CD changer',
  '676': 'HiFi speaker system',
  '704': 'M Sports suspension',
  '710': 'M leather steering wheel',
  '715': 'M Aerodynamics package',
  '760': 'High-gloss Shadow Line',
  '775': 'Anthracite headlining',
  '785': 'White direction indicators',
  '818': 'Battery master switch',
};

/** A few common E46 paint codes. Others show the code; the paint name is also on the sticker in the engine bay. */
export const PAINT: Record<string, string> = {
  '300': 'Alpine White III',
  '303': 'Cosmos Black metallic',
  '317': 'Orient Blue metallic',
  '354': 'Titanium Silver metallic',
  '364': 'Steel Blue metallic',
  '400': 'Silver Grey metallic',
  '416': 'Carbon Black metallic',
  '472': 'Sterling Grey metallic',
  '475': 'Black Sapphire metallic',
  '668': 'Jet Black',
};

export const paintName = (code: string) => PAINT[code.replace(/^0+/, '')] ?? '';
export const saText = (code: string) => SA_TEXT[code.replace(/^0+/, '')] ?? '';

// ---------------------------------------------------------------- VIN and mileage between modules

export interface IdentityEntry {
  module: string; // IKE, EWS, LCM, DME, EGS
  label: string;
  vin?: string;
  /** current odometer (cluster) */
  odometer?: number;
  /** mileage stored when the module was last programmed (DME/EGS) */
  programmedKm?: number;
  programmedDate?: string;
  programmings?: number;
  error?: string;
}

export interface IdentityFinding {
  level: 'ok' | 'warn' | 'info';
  text: string;
}

/** VIN as the modules keep it; empty, all zeros or placeholder means "not stored". */
export function cleanVin(v: unknown): string {
  const s = String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || /^0+$/.test(s) || /^(.)\1+$/.test(s)) return '';
  return s;
}
/** The last 7 characters (2 letters + 5 digits) are what every E46 module can store; compare on those. */
export const shortVin = (v: string) => v.slice(-7);

export function compareIdentity(entries: IdentityEntry[]): IdentityFinding[] {
  const out: IdentityFinding[] = [];
  const withVin = entries.filter((e) => e.vin);
  if (!withVin.length) out.push({ level: 'info', text: 'No module returned a VIN.' });
  else {
    const groups = new Map<string, IdentityEntry[]>();
    for (const e of withVin) {
      const k = shortVin(e.vin!);
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    if (groups.size === 1) {
      const [k] = groups.keys();
      out.push({ level: 'ok', text: withVin.length === 1 ? `Only the ${withVin[0].module} stores a VIN: …${k}.` : `All ${withVin.length} modules that store a VIN report …${k}.` });
    } else {
      // the VIN most modules agree on (the cluster and the immobiliser win a tie)
      const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || score(b[1]) - score(a[1]));
      const [main] = ranked[0];
      out.push({ level: 'warn', text: `The modules do not agree on the VIN: most report …${main}.` });
      for (const [k, es] of ranked.slice(1))
        out.push({ level: 'warn', text: `${es.map((e) => e.module).join(', ')} ${es.length === 1 ? 'reports' : 'report'} …${k}: a used module from another car, or one that was never matched to this car. ${es.some((e) => e.module === 'EWS' || e.module === 'DME') ? 'If the immobiliser and the engine computer disagree, the engine may not start (EWS–DME sync).' : ''}`.trim() });
    }
    const missing = entries.filter((e) => !e.vin && !e.error && ['IKE', 'EWS', 'LCM'].includes(e.module));
    if (missing.length) out.push({ level: 'info', text: `${missing.map((e) => e.module).join(', ')}: no VIN stored.` });
  }
  const odo = entries.find((e) => e.odometer !== undefined)?.odometer;
  const prog = entries.filter((e) => e.programmedKm !== undefined && e.programmedKm > 0);
  if (odo === undefined) out.push({ level: 'info', text: 'The odometer could not be read from the cluster.' });
  else {
    const above = prog.filter((e) => e.programmedKm! > odo + 500);
    for (const e of above) out.push({ level: 'warn', text: `${e.module} was last programmed at ${fmtKm(e.programmedKm!)}, more than the odometer shows now (${fmtKm(odo)}): the cluster was replaced or its mileage changed, or the ${e.module} comes from another car.` });
    if (prog.length && !above.length) out.push({ level: 'ok', text: `The mileage stored by ${prog.map((e) => e.module).join(' and ')} at programming (${prog.map((e) => fmtKm(e.programmedKm!)).join(', ')}) is below the odometer (${fmtKm(odo)}).` });
    if (!prog.length) out.push({ level: 'info', text: `Odometer ${fmtKm(odo)}. The other modules did not store a mileage to compare with (the engine and gearbox only store it when they are programmed).` });
  }
  return out;
}

const score = (es: IdentityEntry[]) => es.reduce((n, e) => n + (e.module === 'IKE' || e.module === 'EWS' ? 2 : 1), 0);
export const fmtKm = (km: number) => `${Math.round(km).toLocaleString('en-US').replace(/,/g, ' ')} km`;
