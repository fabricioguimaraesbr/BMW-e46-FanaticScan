// High-level diagnostic session: serialized job queue, watchdog, and normalized results for the UI.

import { Ediabas, EcuFileProvider, JobResponse, ResultSet } from '../ediabas/Ediabas';
import type { EdInterface } from '../ediabas/EdInterface';
import { PrgFile, parseJobDoc } from '../prg/PrgFile';
import { toHex } from '../util/numbers';
import { translate } from './i18n-en';
import { argLabel, jobLabel, valueLabel } from './i18n-jobs';
import { JobSafety, SafetyMode, classifyJob, isAllowed } from './safety';
import { Equipment, equipmentFromDme, isHiddenByEquipment } from './equipment';
import { E46_MODULES, ModuleDef, UNIT_LABELS, VALUE_LABELS } from './modules';

export interface ScanEntry {
  module: ModuleDef;
  variant: string | null; // resolved SGBD, null = not answering
  ident: Record<string, string | number>;
  error?: string;
}

export interface Dtc {
  code: number;
  /** display code when it is not a DS2 byte (OBD-II: "P0171") */
  label?: string;
  hex: string;
  text: string; // English
  textOriginal: string; // German text from the SGBD
  details: string[]; // F_ARTn_TEXT
  present: boolean | null;
  frequency: number | null;
  env: { name: string; value: string; unit: string }[];
}

export interface Value {
  key: string;
  label: string;
  value: number | string;
  unit: string;
}

export interface JobListEntry {
  name: string;
  comment: string; // English
  commentOriginal: string;
  args: { name: string; type: string; comment: string }[];
  kind: 'status' | 'control' | 'dtc' | 'ident' | 'other';
  safety: JobSafety;
}

export interface SessionOptions {
  files: EcuFileProvider;
  iface: EdInterface;
  jobTimeoutMs?: number;
  onJob?: (r: JobResponse, ms: number) => void;
}

export const BLOCKED_CODE = -1;

/** Result of the availability scan of one module. */
export interface Availability {
  variant: string;
  equipment: Equipment;
  /** read jobs (value groups) that answered correctly */
  jobs: string[];
  /** read jobs that the module rejected or did not answer */
  unavailable: string[];
  checkedAt: number;
}

/** What the UI needs from a session: EDIABAS files (DiagSession) or plug-and-play without files (NativeSession). */
export interface Session {
  readonly kind: 'ediabas' | 'native';
  safetyMode: SafetyMode;
  abort(): void;
  scan(modules?: ModuleDef[], onEntry?: (e: ScanEntry) => void): Promise<ScanEntry[]>;
  readDtcs(variant: string): Promise<{ dtcs: Dtc[]; error?: string; variant: string; notSupported?: boolean }>;
  clearDtcs(variant: string): Promise<{ ok: boolean; error?: string }>;
  readValues(variant: string, job: string, args?: string): Promise<{ values: Value[]; error?: string; status: string }>;
  checkAvailability(variant: string, ident: Record<string, unknown>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): Promise<Availability>;
  listJobs(variant: string): Promise<JobListEntry[]>;
  run(variant: string, job: string, args?: string): Promise<JobResponse>;
}

export class DiagSession implements Session {
  readonly kind = 'ediabas' as const;
  readonly ediabas: Ediabas;
  private queue: Promise<unknown> = Promise.resolve();
  private timeout: number;
  /** 'read' (default): reads and clearing faults only. 'service': also actuator tests and resets. Writes: never. */
  safetyMode: SafetyMode = 'read';

  constructor(private opts: SessionOptions) {
    this.ediabas = new Ediabas({ files: opts.files, iface: opts.iface });
    this.timeout = opts.jobTimeoutMs ?? 20000;
  }

  /** Runs one EDIABAS job; jobs are serialized (one K-line), and aborted after the watchdog timeout. */
  run(sgbd: string, job: string, args?: string, timeoutMs = this.timeout): Promise<JobResponse> {
    const safety = classifyJob(job);
    if (!isAllowed(safety, this.safetyMode)) {
      const text =
        safety === 'write'
          ? `Blocked: ${job} writes permanently to the module (coding/programming). Not allowed in this version.`
          : `Blocked: ${job} is an ${safety === 'test' ? 'actuator test' : 'adaptation reset'}. Unlock “Tests & resets” first.`;
      return Promise.resolve({ sgbd, job, resultSets: [], error: { code: BLOCKED_CODE, text } });
    }
    const exec = async () => {
      const t0 = Date.now();
      const timer = setTimeout(() => this.ediabas.abort(), timeoutMs);
      try {
        const r = await this.ediabas.executeJob({ sgbd, job, args });
        if (r.error?.code === 121) r.error.text = `Timed out after ${timeoutMs / 1000} s, job aborted`;
        this.opts.onJob?.(r, Date.now() - t0);
        return r;
      } finally {
        clearTimeout(timer);
      }
    };
    const p = this.queue.then(exec, exec);
    this.queue = p.catch(() => undefined);
    return p;
  }

  abort() {
    this.ediabas.abort();
  }

  // ---------------------------------------------------------------- vehicle scan
  async scan(modules = E46_MODULES, onEntry?: (e: ScanEntry) => void): Promise<ScanEntry[]> {
    const out: ScanEntry[] = [];
    for (const m of modules) {
      const r = await this.run(m.group, 'IDENT');
      const answered = !r.error || !/IFH-0009|IFH-0010|No variant/i.test(r.error.text);
      const e: ScanEntry = {
        module: m,
        variant: answered && r.sgbd !== m.group ? r.sgbd : null,
        ident: answered ? identFields(r.resultSets) : {},
        error: r.error?.text,
      };
      out.push(e);
      onEntry?.(e);
    }
    return out;
  }

  // ---------------------------------------------------------------- error memory
  async readDtcs(sgbd: string, job = 'FS_LESEN'): Promise<{ dtcs: Dtc[]; error?: string; variant: string }> {
    const r = await this.run(sgbd, job);
    return { dtcs: r.error ? [] : parseDtcs(r.resultSets), error: r.error?.text, variant: r.sgbd };
  }

  async clearDtcs(sgbd: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.run(sgbd, 'FS_LOESCHEN');
    const status = jobStatus(r.resultSets);
    return { ok: !r.error && (status === '' || status === 'OKAY'), error: r.error?.text ?? (status && status !== 'OKAY' ? status : undefined) };
  }

  // ---------------------------------------------------------------- values / jobs
  async readValues(sgbd: string, job: string, args?: string): Promise<{ values: Value[]; error?: string; status: string }> {
    const r = await this.run(sgbd, job, args);
    return { values: r.error ? [] : flattenValues(r.resultSets), error: r.error?.text, status: jobStatus(r.resultSets) };
  }

  /**
   * Finds out what this module supports: reads the equipment configuration (DME) and runs every read-only
   * value group once. Only 'read' jobs are used, so this never changes anything in the car.
   */
  async checkAvailability(variant: string, ident: Record<string, unknown>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): Promise<Availability> {
    const jobs = await this.listJobs(variant);
    const names = new Set(jobs.map((j) => j.name));
    const one = async (job: string) => {
      if (!names.has(job)) return {};
      const r = await this.run(variant, job);
      return r.error ? {} : Object.fromEntries(r.resultSets.slice(1).flatMap((s) => [...s].map(([k, v]) => [k, v.value])));
    };
    const equipment = names.has('ECU_CONFIG') || names.has('ABGAS_VARIANTE_LESEN') ? equipmentFromDme(await one('ECU_CONFIG'), await one('ABGAS_VARIANTE_LESEN'), ident) : {};
    const candidates = jobs.filter((j) => isLiveGroup(j) && !isHiddenByEquipment(j.name, equipment));
    const ok: string[] = [];
    const bad: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (shouldStop?.()) break;
      onProgress?.(i, candidates.length);
      const r = await this.run(variant, candidates[i].name, undefined, 3000);
      const status = jobStatus(r.resultSets);
      const valid = !r.error && (status === '' || status === 'OKAY') && flattenValues(r.resultSets).length > 0;
      (valid ? ok : bad).push(candidates[i].name);
    }
    onProgress?.(candidates.length, candidates.length);
    return { variant, equipment, jobs: ok, unavailable: bad, checkedAt: Date.now() };
  }

  async listJobs(variant: string): Promise<JobListEntry[]> {
    const f = await this.opts.files.load(variant.toLowerCase(), 'prg');
    if (!f) return [];
    return describeJobs(f);
  }
}

// ------------------------------------------------------------------ result helpers

const asText = (v: unknown) =>
  v instanceof Uint8Array ? toHex(v) : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(3))) : String(v ?? '');

const unitLabel = (u: string) => UNIT_LABELS[u.trim()] ?? u.trim();

export function jobStatus(sets: ResultSet[]): string {
  for (const s of sets.slice(1)) {
    const v = s.get('JOB_STATUS');
    if (v) return String(v.value);
  }
  return '';
}

function identFields(sets: ResultSet[]): Record<string, string | number> {
  const o: Record<string, string | number> = {};
  for (const s of sets.slice(1))
    for (const [k, v] of s) if (k.startsWith('ID_') && !(v.value instanceof Uint8Array)) o[k] = v.value as string | number;
  return o;
}

export function parseDtcs(sets: ResultSet[]): Dtc[] {
  const out: Dtc[] = [];
  for (const s of sets.slice(1)) {
    const nr = s.get('F_ORT_NR');
    if (!nr) continue;
    const g = (k: string) => s.get(k)?.value;
    const details: string[] = [];
    for (let i = 1; i <= 16; i++) {
      const t = g(`F_ART${i}_TEXT`);
      if (typeof t === 'string' && t && t !== '---' && !/^--/.test(t)) details.push(translate(t));
    }
    const env: Dtc['env'] = [];
    for (let i = 1; i <= 16; i++) {
      const name = g(`F_UW${i}_TEXT`);
      if (name === undefined) continue;
      env.push({ name: translate(String(name)), value: asText(g(`F_UW${i}_WERT`)), unit: unitLabel(String(g(`F_UW${i}_EINH`) ?? '')) });
    }
    const code = Number(nr.value);
    const vorh = g('F_VORHANDEN');
    out.push({
      code,
      hex: typeof g('F_HEX_CODE') === 'object' ? toHex(g('F_HEX_CODE') as Uint8Array) : String(g('F_HEX_CODE') ?? code.toString(16).toUpperCase().padStart(2, '0')),
      text: translate(String(g('F_ORT_TEXT') ?? '')),
      textOriginal: String(g('F_ORT_TEXT') ?? ''),
      details,
      present: vorh === undefined ? null : Number(vorh) !== 0,
      frequency: g('F_HFK') === undefined ? null : Number(g('F_HFK')),
      env,
    });
  }
  return out;
}

/** Value groups suitable for live data: read-only, no arguments, not the result page of an actuator test. */
export function isLiveGroup(j: JobListEntry): boolean {
  return j.kind === 'status' && j.safety === 'read' && !j.args.length && !/SYSTEMCHECK|VERSTELLZEIT|DICHTHEIT|^LESEN_|SYNC_MODE|DATENSATZ|PROG_STAT_EWS|_EWS/.test(j.name.toUpperCase());
}

/** Values the module reports as not available / not decodable. */
export function isValidValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return t !== '' && !/^\?{2,}|^-{2,}$|nicht (vorhanden|verbaut|unterst)|unbekannt|^n\/a$/i.test(t);
  }
  return true;
}

export function flattenValues(sets: ResultSet[]): Value[] {
  const out: Value[] = [];
  for (const s of sets.slice(1)) {
    for (const [k, v] of s) {
      if (k === 'JOB_STATUS' || k.endsWith('_EINH') || k.startsWith('_')) continue;
      if (!isValidValue(v.value)) continue;
      const base = k.replace(/_(WERT|TEXT)$/, '');
      if (k.endsWith('_TEXT') && s.has(base + '_WERT')) continue; // shown with the value
      const unitRaw = String(s.get(base + '_EINH')?.value ?? '');
      out.push({
        key: k,
        label: VALUE_LABELS[k] ?? valueLabel(k),
        value: typeof v.value === 'string' ? translate(v.value.trim()) : v.value instanceof Uint8Array ? toHex(v.value) : typeof v.value === 'number' && !Number.isInteger(v.value) ? +v.value.toFixed(3) : (v.value as number | string),
        unit: unitLabel(unitRaw),
      });
    }
  }
  return out;
}

export function describeJobs(f: PrgFile): JobListEntry[] {
  return f.ownJobs.map((j) => {
    const d = parseJobDoc(f, j.name);
    const n = j.name.toUpperCase();
    const kind: JobListEntry['kind'] = /^(STATUS|LESEN)_/.test(n)
      ? 'status'
      : /^(STEUERN|START|STOP|TEST)_/.test(n)
        ? 'control'
        : /^(FS|IS)_/.test(n)
          ? 'dtc'
          : /^IDENT/.test(n)
            ? 'ident'
            : 'other';
    return {
      name: j.name,
      comment: jobLabel(d?.comments.join(' ') ?? ''),
      commentOriginal: d?.comments.join(' ').trim() ?? '',
      args: (d?.args ?? []).map((a) => ({ name: a.name, type: a.type, comment: argLabel(a.comments.join(' ')) })),
      kind,
      safety: classifyJob(j.name),
    };
  });
}
