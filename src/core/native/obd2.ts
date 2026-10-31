// OBD-II services (SAE J1979) on top of ISO 9141-2: supported PIDs, live data, stored / pending DTCs, clear.

import type { ObdTransport } from './elm327';
import type { IsoMessage } from './iso9141';
import { describePcode } from './pcodes';

export interface PidDef {
  pid: number;
  label: string;
  unit: string;
  bytes: number;
  decode: (d: number[]) => number | string;
}

const pct = (a: number) => +((a * 100) / 255).toFixed(1);
const trim = (a: number) => +(((a - 128) * 100) / 128).toFixed(1);

const FUEL_STATUS: Record<number, string> = { 1: 'Open loop (cold)', 2: 'Closed loop', 4: 'Open loop (load/decel)', 8: 'Open loop (fault)', 16: 'Closed loop (sensor fault)' };

export const PIDS: PidDef[] = [
  { pid: 0x03, label: 'Fuel system status', unit: '', bytes: 2, decode: (d) => FUEL_STATUS[d[0]] ?? `0x${d[0].toString(16)}` },
  { pid: 0x04, label: 'Engine load', unit: '%', bytes: 1, decode: (d) => pct(d[0]) },
  { pid: 0x05, label: 'Coolant temp', unit: '°C', bytes: 1, decode: (d) => d[0] - 40 },
  { pid: 0x06, label: 'Fuel trim short B1', unit: '%', bytes: 1, decode: (d) => trim(d[0]) },
  { pid: 0x07, label: 'Fuel trim long B1', unit: '%', bytes: 1, decode: (d) => trim(d[0]) },
  { pid: 0x08, label: 'Fuel trim short B2', unit: '%', bytes: 1, decode: (d) => trim(d[0]) },
  { pid: 0x09, label: 'Fuel trim long B2', unit: '%', bytes: 1, decode: (d) => trim(d[0]) },
  { pid: 0x0b, label: 'Intake manifold pressure', unit: 'kPa', bytes: 1, decode: (d) => d[0] },
  { pid: 0x0c, label: 'Engine speed', unit: 'rpm', bytes: 2, decode: (d) => Math.round((d[0] * 256 + d[1]) / 4) },
  { pid: 0x0d, label: 'Vehicle speed', unit: 'km/h', bytes: 1, decode: (d) => d[0] },
  { pid: 0x0e, label: 'Ignition timing', unit: '°', bytes: 1, decode: (d) => d[0] / 2 - 64 },
  { pid: 0x0f, label: 'Intake air temp', unit: '°C', bytes: 1, decode: (d) => d[0] - 40 },
  { pid: 0x10, label: 'Air mass (MAF)', unit: 'g/s', bytes: 2, decode: (d) => +((d[0] * 256 + d[1]) / 100).toFixed(2) },
  { pid: 0x11, label: 'Throttle position', unit: '%', bytes: 1, decode: (d) => pct(d[0]) },
  ...[0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b].map((pid, i): PidDef => ({
    pid,
    label: `O2 sensor bank ${i < 4 ? 1 : 2} sensor ${(i % 4) + 1} voltage`,
    unit: 'V',
    bytes: 2,
    decode: (d) => +(d[0] / 200).toFixed(3),
  })),
  { pid: 0x1c, label: 'OBD standard', unit: '', bytes: 1, decode: (d) => ({ 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD + OBD-II', 6: 'EOBD (Europe)', 7: 'EOBD + OBD-II' } as Record<number, string>)[d[0]] ?? String(d[0]) },
  { pid: 0x1f, label: 'Time since engine start', unit: 's', bytes: 2, decode: (d) => d[0] * 256 + d[1] },
  { pid: 0x21, label: 'Distance with check engine light on', unit: 'km', bytes: 2, decode: (d) => d[0] * 256 + d[1] },
  { pid: 0x2f, label: 'Fuel level', unit: '%', bytes: 1, decode: (d) => pct(d[0]) },
  { pid: 0x33, label: 'Barometric pressure', unit: 'kPa', bytes: 1, decode: (d) => d[0] },
  { pid: 0x42, label: 'Control module voltage', unit: 'V', bytes: 2, decode: (d) => +((d[0] * 256 + d[1]) / 1000).toFixed(2) },
  { pid: 0x46, label: 'Ambient air temp', unit: '°C', bytes: 1, decode: (d) => d[0] - 40 },
];
export const PID_BY_ID = new Map(PIDS.map((p) => [p.pid, p]));
export const pidKey = (pid: number) => `OBD_${pid.toString(16).toUpperCase().padStart(2, '0')}`;

export interface ObdDtc {
  code: string; // P0171
  raw: number;
  text: string;
  pending: boolean;
}

export function decodeDtc(hi: number, lo: number): string {
  const sys = 'PCBU'[hi >> 6];
  return `${sys}${(hi >> 4) & 3}${(hi & 0x0f).toString(16).toUpperCase()}${lo.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Answers of the engine (several ECUs could answer on other cars; E46 has one). */
const ofService = (msgs: IsoMessage[], sid: number) => msgs.filter((m) => m.data[0] === sid);

export class Obd2 {
  supported = new Set<number>();
  constructor(readonly iso: ObdTransport) {}

  /** Reads the supported PID bitmaps (01 00, 01 20, 01 40). */
  async readSupported(): Promise<Set<number>> {
    this.supported.clear();
    for (const base of [0x00, 0x20, 0x40]) {
      if (base && !this.supported.has(base)) break;
      const ok = (x: IsoMessage) => x.data[0] === 0x41 && x.data[1] === base && x.data.length >= 6;
      const m = (await this.iso.request([0x01, base], 120, (msgs) => msgs.some(ok))).find(ok);
      if (!m || m.data.length < 6) break;
      for (let i = 0; i < 32; i++) if (m.data[2 + (i >> 3)] & (0x80 >> (i & 7))) this.supported.add(base + i + 1);
    }
    return this.supported;
  }

  async readPid(pid: number): Promise<number | string | undefined> {
    const def = PID_BY_ID.get(pid);
    if (!def) return undefined;
    const ok = (x: IsoMessage) => x.data[0] === 0x41 && x.data[1] === pid && x.data.length >= 2 + def.bytes;
    const m = (await this.iso.request([0x01, pid], 120, (msgs) => msgs.some(ok))).find(ok);
    if (!m) return undefined;
    return def.decode(Array.from(m.data.slice(2, 2 + def.bytes)));
  }

  /** MIL state and number of stored DTCs (PID 01). */
  async readStatus(): Promise<{ mil: boolean; count: number } | null> {
    const ok = (x: IsoMessage) => x.data[0] === 0x41 && x.data[1] === 0x01 && x.data.length >= 3;
    const m = (await this.iso.request([0x01, 0x01], 120, (msgs) => msgs.some(ok))).find(ok);
    if (!m) return null;
    return { mil: (m.data[2] & 0x80) !== 0, count: m.data[2] & 0x7f };
  }

  private async dtcs(service: 0x03 | 0x07): Promise<ObdDtc[] | null> {
    const msgs = await this.iso.request([service], 200);
    const ans = ofService(msgs, service + 0x40);
    if (!ans.length && !msgs.length) return null;
    const out: ObdDtc[] = [];
    for (const m of ans)
      for (let i = 1; i + 1 < m.data.length; i += 2) {
        const hi = m.data[i];
        const lo = m.data[i + 1];
        if (!hi && !lo) continue;
        const code = decodeDtc(hi, lo);
        if (!out.some((d) => d.code === code)) out.push({ code, raw: (hi << 8) | lo, text: describePcode(code), pending: service === 0x07 });
      }
    return out;
  }
  readStoredDtcs() {
    return this.dtcs(0x03);
  }
  readPendingDtcs() {
    return this.dtcs(0x07);
  }

  /** Mode 04: clears stored/pending DTCs, freeze frame and readiness monitors, turns the MIL off. */
  async clearDtcs(): Promise<boolean> {
    const msgs = await this.iso.request([0x04], 300);
    return ofService(msgs, 0x44).length > 0;
  }
}
