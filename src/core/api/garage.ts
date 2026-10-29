// Garage: saved cars and the history of their whole-car scans, and the comparison of two scans
// (which faults are new, which were cleared, which stay). Plain data, stored by the UI in the browser.

export interface GarageDtc {
  code: string; // display code (hex or P-code)
  text: string;
  present: boolean | null;
}

export interface GarageModule {
  short: string;
  name: string;
  variant: string;
  part?: string;
  hw?: string;
  sw?: string;
  /** 'read': fault memory read; 'id': identified only (no module file); 'error': could not be read */
  state: 'read' | 'id' | 'error';
  dtcs: GarageDtc[];
}

export interface GarageScan {
  id: string;
  at: string; // ISO time
  source: 'cable' | 'sim';
  note?: string;
  modules: GarageModule[];
}

export interface GarageCar {
  id: string;
  name: string;
  vin?: string;
  engine?: string;
  createdAt: string;
  scans: GarageScan[];
}

export interface GarageData {
  v: 1;
  cars: GarageCar[];
}

export const emptyGarage = (): GarageData => ({ v: 1, cars: [] });

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** A VIN as the E46 modules report it: the full 17 characters, or the short 7 (2 letters + 5 digits). */
export function normalizeVin(v: unknown): string | undefined {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(s) && /\d/.test(s)) return s;
  if (/^[A-Z]{2}\d{5}$/.test(s)) return s;
  return undefined;
}

const short7 = (vin?: string) => (vin ? vin.slice(-7) : undefined);

/** The saved car with this VIN (full or the last 7 characters match). */
export function findCarByVin(data: GarageData, vin?: string): GarageCar | undefined {
  if (!vin) return undefined;
  return data.cars.find((c) => c.vin && (c.vin === vin || short7(c.vin) === short7(vin)));
}

export function addScan(data: GarageData, carId: string, scan: GarageScan) {
  const car = data.cars.find((c) => c.id === carId);
  if (!car) throw new Error('car not found');
  car.scans.unshift(scan);
  if (car.scans.length > 200) car.scans.length = 200;
}

export interface ScanDiff {
  module: string;
  name: string;
  /** the module answered in only one of the two scans */
  onlyIn?: 'older' | 'newer';
  added: GarageDtc[];
  cleared: GarageDtc[];
  kept: GarageDtc[];
}

/** Compares two scans module by module. Faults are matched by module and code. */
export function diffScans(older: GarageScan, newer: GarageScan): ScanDiff[] {
  const out: ScanDiff[] = [];
  const shorts = [...new Set([...newer.modules.map((m) => m.short), ...older.modules.map((m) => m.short)])];
  for (const s of shorts) {
    const a = older.modules.find((m) => m.short === s);
    const b = newer.modules.find((m) => m.short === s);
    const name = (b ?? a)!.name;
    if (!a || !b) {
      out.push({ module: s, name, onlyIn: a ? 'older' : 'newer', added: b?.dtcs ?? [], cleared: a?.dtcs ?? [], kept: [] });
      continue;
    }
    const codesA = new Set(a.dtcs.map((d) => d.code));
    const codesB = new Set(b.dtcs.map((d) => d.code));
    out.push({
      module: s,
      name,
      added: b.dtcs.filter((d) => !codesA.has(d.code)),
      cleared: a.state === 'read' && b.state === 'read' ? a.dtcs.filter((d) => !codesB.has(d.code)) : [],
      kept: b.dtcs.filter((d) => codesA.has(d.code)),
    });
  }
  return out;
}

/** Reads a garage export (JSON). Throws with a readable message when it is not one. */
export function parseGarage(text: string): GarageData {
  const d = JSON.parse(text) as GarageData;
  if (!d || d.v !== 1 || !Array.isArray(d.cars)) throw new Error('This file is not an E46Fanatics Scan garage export.');
  for (const c of d.cars) if (!c.id || !Array.isArray(c.scans)) throw new Error('The garage file is damaged.');
  return d;
}

/** Adds the cars and scans of an import to the garage; a car with the same id or VIN is merged, scans are not duplicated. */
export function mergeGarage(into: GarageData, add: GarageData): { cars: number; scans: number } {
  let cars = 0;
  let scans = 0;
  for (const c of add.cars) {
    const mine = into.cars.find((x) => x.id === c.id) ?? findCarByVin(into, c.vin);
    if (!mine) {
      into.cars.push(c);
      cars++;
      scans += c.scans.length;
      continue;
    }
    for (const s of c.scans) {
      if (mine.scans.some((x) => x.id === s.id)) continue;
      mine.scans.push(s);
      scans++;
    }
    mine.scans.sort((x, y) => y.at.localeCompare(x.at));
  }
  return { cars, scans };
}
