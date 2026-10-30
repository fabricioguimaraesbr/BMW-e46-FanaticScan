// Plug-and-play session: works with only the cable, no BMW module files.
//   - every E46 module: DS2 identification (part number, hardware, software, date)
//   - engine: OBD-II / EOBD over ISO 9141-2 — standard fault codes, clearing, live data
// Same interface as DiagSession, so the UI does not care which one it talks to.

import type { Availability, Dtc, JobListEntry, ScanEntry, Session, Value } from '../api/DiagSession';
import { E46_MODULES, ModuleDef } from '../api/modules';
import type { SafetyMode } from '../api/safety';
import type { JobResponse, ResultSet } from '../ediabas/Ediabas';
import { ResultType } from '../ediabas/results';
import type { ByteChannel } from '../transport/ByteChannel';
import { ObdInterface } from '../transport/ObdInterface';
import { Iso9141 } from './iso9141';
import { Obd2, PID_BY_ID, pidKey } from './obd2';

export const ENGINE_VARIANT = 'native:12';
const LIVE_JOB = 'OBD_LIVE';
const INFO_JOB = 'OBD_INFO';

/** PIDs read on every refresh; the others rotate one per refresh. */
const FAST_PIDS = [0x0c, 0x05, 0x0f, 0x0d, 0x04, 0x10, 0x0e, 0x06, 0x07, 0x11];
const DIAL_PIDS = [0x0c, 0x05, 0x0f, 0x0d];
const INFO_PIDS = [0x01, 0x03, 0x1c, 0x1f, 0x21];

export interface NativeOptions {
  channel: ByteChannel;
  iface: ObdInterface; // DS2 framing (9600 8E1)
  onTraffic?: (dir: 'tx' | 'rx' | 'info', bytes: Uint8Array | string) => void;
  onLink?: (s: 'answer' | 'noanswer' | 'nocable') => void;
  onJob?: (r: JobResponse, ms: number) => void;
}

const asciiOk = (b: Uint8Array) => b.length >= 11 && Array.from(b.slice(0, 11)).every((c) => c >= 0x30 && c <= 0x5a);
const str = (b: Uint8Array) => String.fromCharCode(...b);
const bcd = (x: number) => x.toString(16).padStart(2, '0').toUpperCase();

/** Generic DS2 identification decoding (ASCII layout used by most modules, binary layout of ABS/ASC MK20). */
export function decodeDs2Ident(p: Uint8Array): Record<string, string | number> {
  if (asciiOk(p)) {
    return {
      ID_BMW_NR: str(p.slice(0, 7)),
      ID_HW_NR: str(p.slice(7, 9)),
      ID_COD_INDEX: str(p.slice(9, 11)),
      ID_DIAG_INDEX: str(p.slice(11, 13)),
      ID_BUS_INDEX: str(p.slice(13, 15)),
      ID_DATUM_KW: str(p.slice(15, 17)),
      ID_DATUM_JAHR: str(p.slice(17, 19)),
      ...(p.length >= 33 ? { ID_SW_NR: str(p.slice(29, 31)) } : {}),
    };
  }
  // binary: BMW number as 7 hex digits, then HW, coding, diag, bus, date bytes, supplier, SW
  return {
    ID_BMW_NR: Array.from(p.slice(0, 4)).map(bcd).join('').slice(1),
    ID_HW_NR: bcd(p[4] ?? 0),
    ID_COD_INDEX: bcd(p[5] ?? 0),
    ID_DIAG_INDEX: bcd(p[6] ?? 0),
    ID_BUS_INDEX: bcd(p[7] ?? 0),
    ...(p.length > 11 ? { ID_SW_NR: bcd(p[11]) } : {}),
  };
}

export class NativeSession implements Session {
  readonly kind = 'native' as const;
  safetyMode: SafetyMode = 'read';
  readonly iso: Iso9141;
  readonly obd: Obd2;
  private rotate = 0;
  private cache = new Map<number, number | string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: NativeOptions) {
    this.iso = new Iso9141(opts.channel, { onTraffic: opts.onTraffic, onLink: opts.onLink });
    this.obd = new Obd2(this.iso);
  }

  abort() {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** DS2 request at 9600 8E1 (the OBD-II session is dropped while DS2 talks). */
  private async ds2(addr: number, data: number[], timeout = 1000, repeats = 1): Promise<Uint8Array | null> {
    if (this.iso.isReady) {
      this.iso.release();
      this.opts.iface.resetLine();
    }
    const i = this.opts.iface;
    await i.setCommParameter([6, 9600, addr, 0, 0, timeout, 50, 20, 0]);
    i.setCommAnswerLen([-1, 0]);
    i.commRepeats = repeats;
    const r = await i.transmitData(new Uint8Array([addr, data.length + 3, ...data]));
    return r && r.length >= 4 && r[2] === 0xa0 ? r.slice(3, r.length - 1) : null;
  }

  /** Raw DS2 exchange (whole answer frame, any status), serialized with everything else on the line. */
  ds2Raw(addr: number, data: number[], timeout = 1000): Promise<Uint8Array | null> {
    return this.serial(async () => {
      if (this.iso.isReady) {
        this.iso.release();
        this.opts.iface.resetLine();
      }
      const i = this.opts.iface;
      await i.setCommParameter([6, 9600, addr, 0, 0, timeout, 50, 20, 0]);
      i.setCommAnswerLen([-1, 0]);
      i.commRepeats = 0;
      try {
        const r = await i.transmitData(new Uint8Array([addr, data.length + 3, ...data]));
        return r && r.length >= 4 ? r : null;
      } catch {
        return null;
      }
    });
  }

  private ensureObd() {
    this.opts.iface.resetLine();
    return this.iso.isReady || this.iso.init();
  }

  scan(modules: ModuleDef[] = E46_MODULES, onEntry?: (e: ScanEntry) => void): Promise<ScanEntry[]> {
    return this.serial(async () => {
      const out: ScanEntry[] = [];
      for (const m of modules) {
        const t0 = Date.now();
        const payload = await this.ds2(m.address, [0x00], 600, 0);
        let e: ScanEntry = { module: m, variant: payload ? `native:${m.address.toString(16).padStart(2, '0')}` : null, ident: payload ? decodeDs2Ident(payload) : {} };
        if (m.address === 0x12 && !payload) {
          // engines without DS2 (diesel, later petrol): still reachable through OBD-II
          if (await this.ensureObd()) e = { module: m, variant: ENGINE_VARIANT, ident: { ID_PROTOCOL: 'OBD-II' } };
        }
        if (m.address === 0x12 && e.variant) e.ident.ID_PROTOCOL = e.ident.ID_PROTOCOL ?? 'DS2 + OBD-II';
        this.log(m.group.toUpperCase(), 'IDENT', e.variant ? undefined : 'No response', t0);
        out.push(e);
        onEntry?.(e);
      }
      return out;
    });
  }

  private log(sgbd: string, job: string, error: string | undefined, t0: number) {
    this.opts.onJob?.({ sgbd, job, resultSets: [], error: error ? { code: 19, text: error } : undefined }, Date.now() - t0);
  }

  readDtcs(variant: string) {
    return this.serial(async () => {
      if (variant !== ENGINE_VARIANT)
        return { dtcs: [], variant, notSupported: true, error: 'Fault memory of this module needs the BMW module files (INPA Ecu folder). Plug-and-play support for it is planned.' };
      const t0 = Date.now();
      if (!(await this.ensureObd())) return { dtcs: [], variant, error: 'The engine did not answer on OBD-II. Check the ignition (key position 2).' };
      const stored = await this.obd.readStoredDtcs();
      const pending = (await this.obd.readPendingDtcs()) ?? [];
      this.log('OBD-II', 'Mode 03/07', stored ? undefined : 'No answer', t0);
      if (!stored) return { dtcs: [], variant, error: 'The engine did not answer the fault memory request.' };
      const all = [...stored, ...pending.filter((p) => !stored.some((s) => s.code === p.code))];
      const dtcs: Dtc[] = all.map((d) => ({
        code: d.raw,
        label: d.code,
        hex: d.raw.toString(16).toUpperCase().padStart(4, '0'),
        text: d.text,
        textOriginal: '',
        details: [d.pending ? 'Pending: seen once, not confirmed yet' : 'Stored'],
        present: null,
        frequency: null,
        env: [],
      }));
      return { dtcs, variant };
    });
  }

  clearDtcs(variant: string) {
    return this.serial(async () => {
      if (variant !== ENGINE_VARIANT) return { ok: false, error: 'Not available for this module without BMW module files.' };
      if (!(await this.ensureObd())) return { ok: false, error: 'The engine did not answer on OBD-II.' };
      const ok = await this.obd.clearDtcs();
      return ok ? { ok } : { ok, error: 'The engine refused to clear (on some cars the engine must be off, key in position 2).' };
    });
  }

  readValues(variant: string, job: string) {
    return this.serial(async () => {
      if (variant !== ENGINE_VARIANT) return { values: [], status: '', error: 'No live data for this module without BMW module files.' };
      if (!(await this.ensureObd())) return { values: [], status: '', error: 'The engine did not answer on OBD-II.' };
      if (!this.obd.supported.size) await this.obd.readSupported();
      const sup = (p: number) => this.obd.supported.has(p) && PID_BY_ID.has(p);
      let list: number[];
      if (job === INFO_JOB) list = INFO_PIDS.filter((p) => p === 0x01 || sup(p));
      else {
        // dials every cycle, everything else round-robin (ISO 9141 manages ~5-8 values per second)
        const dials = DIAL_PIDS.filter(sup);
        const rest = [...FAST_PIDS.filter((p) => !dials.includes(p)), ...[...this.obd.supported].filter((p) => !FAST_PIDS.includes(p)).sort((a, b) => a - b)].filter(
          (p) => sup(p) && !INFO_PIDS.includes(p),
        );
        list = [...dials];
        const firstPass = rest.filter((p) => !this.cache.has(p));
        if (firstPass.length) list.push(...firstPass);
        else for (let k = 0; k < Math.min(3, rest.length); k++) list.push(rest[this.rotate++ % rest.length]);
      }
      const values: Value[] = [];
      for (const p of list) {
        if (p === 0x01) {
          const s = await this.obd.readStatus();
          if (s) {
            values.push({ key: 'OBD_MIL', label: 'Check engine light', value: s.mil ? 'On' : 'Off', unit: '' });
            values.push({ key: 'OBD_DTC_COUNT', label: 'Stored fault codes', value: s.count, unit: '' });
          }
          continue;
        }
        const v = await this.obd.readPid(p);
        if (v !== undefined) this.cache.set(p, v);
      }
      if (job !== INFO_JOB) {
        const order = [...FAST_PIDS, ...[...this.cache.keys()].sort((a, b) => a - b)];
        for (const p of [...new Set(order)]) {
          const v = this.cache.get(p);
          const def = PID_BY_ID.get(p);
          if (v !== undefined && def && !INFO_PIDS.includes(p)) values.push({ key: pidKey(p), label: def.label, value: v, unit: def.unit });
        }
      } else {
        for (const p of list) {
          const v = this.cache.get(p);
          const def = PID_BY_ID.get(p);
          if (v !== undefined && def) values.push({ key: pidKey(p), label: def.label, value: v, unit: def.unit });
        }
      }
      return values.length ? { values, status: 'OKAY' } : { values, status: '', error: 'The engine did not answer.' };
    });
  }

  async checkAvailability(variant: string): Promise<Availability> {
    if (variant !== ENGINE_VARIANT) return { variant, equipment: {}, jobs: [], unavailable: [], checkedAt: Date.now() };
    const sup = await this.serial(async () => ((await this.ensureObd()) ? this.obd.readSupported() : new Set<number>()));
    return { variant, equipment: {}, jobs: sup.size ? [LIVE_JOB, INFO_JOB] : [], unavailable: sup.size ? [] : [LIVE_JOB, INFO_JOB], checkedAt: Date.now() };
  }

  async listJobs(variant: string): Promise<JobListEntry[]> {
    if (variant !== ENGINE_VARIANT) return [];
    return [
      { name: LIVE_JOB, comment: 'Engine live data (OBD-II)', commentOriginal: '', args: [], kind: 'status', safety: 'read' },
      { name: INFO_JOB, comment: 'OBD status: check engine light, fuel system, OBD standard', commentOriginal: '', args: [], kind: 'status', safety: 'read' },
    ];
  }

  async run(variant: string, job: string): Promise<JobResponse> {
    const r = await this.readValues(variant, job);
    const set: ResultSet = new Map(r.values.map((v) => [v.label, { type: ResultType.S, name: v.label, value: `${v.value}${v.unit ? ' ' + v.unit : ''}` }]));
    return { sgbd: variant, job, resultSets: [new Map(), set], error: r.error ? { code: 19, text: r.error } : undefined };
  }
}

