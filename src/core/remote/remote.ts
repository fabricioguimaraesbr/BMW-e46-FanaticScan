// Remote session: a community member reads someone else's car over the internet.
//
// The car stays on the computer with the cable (the "host"). The helper's app gets a RemoteSession that implements
// the same Session interface as a cable session, so every screen works unchanged; each call crosses the connection
// as a small JSON message and runs on the host's own session. The host decides what is allowed, never the helper:
//   - reads (identification, fault memory, live values, read-only jobs): always
//   - clearing faults: only when the owner approves it on the host, each time
//   - actuator tests and resets: only with "read + tests" access, each one approved by the owner
//   - writes (coding, EEPROM, the gauge curve): never; raw K-line access is not offered at all
// The connection itself (WebRTC data channel) is in src/web/remote.ts; this file only needs a text pipe.

import type { Availability, Dtc, JobListEntry, ScanEntry, Session, Value } from '../api/DiagSession';
import type { JobResponse } from '../ediabas/Ediabas';
import { E46_MODULES, ModuleDef } from '../api/modules';
import type { JobSafety, SafetyMode } from '../api/safety';

export const REMOTE_PROTOCOL = 1;

/** A bidirectional text channel (an RTCDataChannel, or a pair of in-memory ends in the tests). */
export interface Pipe {
  send(text: string): void;
  onmessage: ((text: string) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export type RemoteAccess = 'read' | 'tests';

export interface HelloInfo {
  protocol: number;
  app: string;
  car: string;
  access: RemoteAccess;
  kind: Session['kind'];
}

type Method = 'hello' | 'scan' | 'readDtcs' | 'clearDtcs' | 'readValues' | 'checkAvailability' | 'listJobs' | 'run' | 'abort';
interface Req { id: number; m: Method; a: unknown[] }
interface Res { id: number; r?: unknown; e?: string; partial?: unknown }

// ---------------------------------------------------------------- serialization (Map and Uint8Array survive)

export function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x instanceof Map) return { $m: [...x.entries()] };
    if (x instanceof Uint8Array) return { $b: Array.from(x) };
    return x;
  });
}
export function decode<T = unknown>(s: string): T {
  return JSON.parse(s, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      if ('$m' in x) return new Map(x.$m);
      if ('$b' in x) return new Uint8Array(x.$b);
    }
    return x;
  }) as T;
}

// ---------------------------------------------------------------- host (the computer at the car)

export interface Approval {
  /** what the helper asks for, in plain words */
  title: string;
  detail: string;
  kind: 'clear' | 'test' | 'reset';
}

export interface HostOptions {
  session: Session;
  access: RemoteAccess;
  app: string;
  car: () => string;
  /** scan results the host already has (the helper does not need to wait for a new scan) */
  cachedScan?: () => ScanEntry[];
  /** asks the owner; resolves true when allowed. Tests also need the host session in service mode (done by the caller). */
  approve: (a: Approval) => Promise<boolean>;
  onActivity?: (text: string, refused: boolean) => void;
}

export class RemoteHost {
  private jobsCache = new Map<string, Promise<JobListEntry[]>>();
  requests = 0;
  constructor(private pipe: Pipe, private o: HostOptions) {
    pipe.onmessage = (t) => void this.handle(t);
  }

  private jobs(variant: string) {
    let p = this.jobsCache.get(variant);
    if (!p) this.jobsCache.set(variant, (p = this.o.session.listJobs(variant).catch(() => [])));
    return p;
  }

  /** Safety of a job as the host's own files describe it. A job the module file does not list is a write. */
  private async safetyOf(variant: string, job: string): Promise<JobSafety> {
    const j = (await this.jobs(variant)).find((x) => x.name.toUpperCase() === job.toUpperCase());
    return j?.safety ?? 'write';
  }

  private refuse(text: string): never {
    this.o.onActivity?.(text, true);
    throw new Error(text);
  }

  private async gate(variant: string, job: string, label: string) {
    const safety = await this.safetyOf(variant, job);
    if (safety === 'read') return;
    if (safety === 'write') this.refuse(`Refused: ${job} writes to the module. Writes are never allowed in a remote session.`);
    if ((safety === 'test' || safety === 'reset') && this.o.access !== 'tests') this.refuse(`Refused: ${job} is an ${safety === 'test' ? 'actuator test' : 'adaptation reset'}. The car owner shared read-only access.`);
    const ok = await this.o.approve({ kind: safety, title: safety === 'clear' ? 'Clear fault memory' : safety === 'test' ? 'Actuator test' : 'Reset learned values', detail: `${label}: ${job}` });
    if (!ok) this.refuse(`Refused by the car owner: ${job}`);
  }

  private async handle(text: string) {
    let req: Req;
    try {
      req = decode<Req>(text);
    } catch {
      return;
    }
    const s = this.o.session;
    const reply = (r: Partial<Res>) => this.pipe.send(encode({ id: req.id, ...r }));
    this.requests++;
    try {
      const a = req.a ?? [];
      const variant = String(a[0] ?? '');
      let r: unknown;
      switch (req.m) {
        case 'hello':
          r = { protocol: REMOTE_PROTOCOL, app: this.o.app, car: this.o.car(), access: this.o.access, kind: s.kind } satisfies HelloInfo;
          break;
        case 'scan': {
          const modules = a[0] as ModuleDef[];
          const useCache = a[1] === true;
          const cached = useCache ? this.o.cachedScan?.() ?? [] : [];
          if (useCache && modules.every((m) => cached.some((c) => c.module.group === m.group))) {
            r = modules.map((m) => cached.find((c) => c.module.group === m.group)!);
          } else {
            this.o.onActivity?.('Helper scans the car', false);
            r = await s.scan(modules, (e) => reply({ partial: e }));
          }
          break;
        }
        case 'readDtcs':
          r = await s.readDtcs(variant);
          break;
        case 'clearDtcs': {
          const ok = await this.o.approve({ kind: 'clear', title: 'Clear fault memory', detail: `Module ${variant.toUpperCase()}: faults still present come back` });
          if (!ok) this.refuse(`Refused by the car owner: clear faults of ${variant.toUpperCase()}`);
          this.o.onActivity?.(`Helper cleared the faults of ${variant.toUpperCase()}`, false);
          r = await s.clearDtcs(variant);
          break;
        }
        case 'readValues': {
          const job = String(a[1] ?? '');
          if ((await this.safetyOf(variant, job)) !== 'read') this.refuse(`Refused: ${job} is not a reading`);
          r = await s.readValues(variant, job, a[2] as string | undefined);
          break;
        }
        case 'checkAvailability':
          r = await s.checkAvailability(variant, (a[1] ?? {}) as Record<string, unknown>);
          break;
        case 'listJobs':
          r = await this.jobs(variant);
          break;
        case 'run': {
          const job = String(a[1] ?? '');
          await this.gate(variant, job, `Module ${variant.toUpperCase()}`);
          if ((await this.safetyOf(variant, job)) !== 'read') this.o.onActivity?.(`Helper ran ${job} on ${variant.toUpperCase()} (approved)`, false);
          r = await s.run(variant, job, a[2] as string | undefined);
          break;
        }
        case 'abort':
          r = true;
          break;
        default:
          throw new Error('Unknown request');
      }
      reply({ r });
    } catch (e) {
      reply({ e: (e as Error).message || String(e) });
    }
  }

  close() {
    this.pipe.onmessage = null;
    this.pipe.close();
  }
}

// ---------------------------------------------------------------- helper (the remote computer)

export class RemoteSession implements Session {
  kind: Session['kind'] = 'ediabas';
  /** the helper may unlock locally; the host still asks its owner and enforces its own access */
  safetyMode: SafetyMode = 'read';
  info: HelloInfo | null = null;
  open = true;
  lastAnswer = 0;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; partial?: (p: unknown) => void }>();

  constructor(private pipe: Pipe, private onClose?: () => void) {
    pipe.onmessage = (t) => {
      const res = decode<Res>(t);
      const w = this.waiting.get(res.id);
      if (!w) return;
      this.lastAnswer = Date.now();
      if (res.partial !== undefined) return w.partial?.(res.partial);
      this.waiting.delete(res.id);
      if (res.e !== undefined) w.reject(new Error(res.e));
      else w.resolve(res.r);
    };
    pipe.onclose = () => {
      this.open = false;
      for (const w of this.waiting.values()) w.reject(new Error('The shared car disconnected'));
      this.waiting.clear();
      this.onClose?.();
    };
  }

  private call<T>(m: Method, a: unknown[] = [], partial?: (p: unknown) => void): Promise<T> {
    if (!this.open) return Promise.reject(new Error('The shared car disconnected'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, partial });
      this.pipe.send(encode({ id, m, a } satisfies Req));
    });
  }

  async hello(): Promise<HelloInfo> {
    this.info = await this.call<HelloInfo>('hello');
    this.kind = this.info.kind;
    return this.info;
  }

  private firstScan = true;
  async scan(modules?: ModuleDef[], onEntry?: (e: ScanEntry) => void): Promise<ScanEntry[]> {
    const list = modules ?? E46_MODULES;
    const useCache = this.firstScan;
    this.firstScan = false;
    let streamed = false;
    const r = await this.call<ScanEntry[]>('scan', [list, useCache], (p) => { streamed = true; onEntry?.(p as ScanEntry); });
    // entries from the cache come in one go: hand them to the screen like a scan would
    if (!streamed) r.forEach((e) => onEntry?.(e));
    return r;
  }
  readDtcs(variant: string) {
    return this.call<{ dtcs: Dtc[]; error?: string; variant: string; notSupported?: boolean }>('readDtcs', [variant]).catch((e: Error) => ({ dtcs: [], error: e.message, variant }));
  }
  clearDtcs(variant: string) {
    return this.call<{ ok: boolean; error?: string }>('clearDtcs', [variant]).catch((e: Error) => ({ ok: false, error: e.message }));
  }
  readValues(variant: string, job: string, args?: string) {
    return this.call<{ values: Value[]; error?: string; status: string }>('readValues', [variant, job, args]).catch((e: Error) => ({ values: [], error: e.message, status: '' }));
  }
  checkAvailability(variant: string, ident: Record<string, unknown>, onProgress?: (done: number, total: number) => void): Promise<Availability> {
    onProgress?.(0, 0);
    return this.call<Availability>('checkAvailability', [variant, ident]);
  }
  listJobs(variant: string) {
    return this.call<JobListEntry[]>('listJobs', [variant]).catch(() => [] as JobListEntry[]);
  }
  run(variant: string, job: string, args?: string): Promise<JobResponse> {
    return this.call<JobResponse>('run', [variant, job, args]).catch((e: Error) => ({ sgbd: variant, job, resultSets: [], error: { code: -1, text: e.message } }));
  }
  abort() {
    void this.call('abort').catch(() => undefined);
  }
  close() {
    this.pipe.close();
  }
}

/** Two connected in-memory pipe ends (tests, and the same-computer demo). */
export function pipePair(): [Pipe, Pipe] {
  const mk = (): Pipe & { peer?: Pipe; closed?: boolean } => ({
    onmessage: null,
    onclose: null,
    send(t) { const p = this.peer!; setTimeout(() => p.onmessage?.(t), 0); },
    close() { if (this.closed) return; this.closed = true; const p = this.peer as Pipe & { closed?: boolean }; this.onclose?.(); if (!p.closed) p.close(); },
  });
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// ---------------------------------------------------------------- invite / reply codes (WebRTC offer and answer)

const PREFIX = { offer: 'E46-INVITE-', answer: 'E46-REPLY-' } as const;

async function deflate(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const out = new Response(new Blob([text]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}
async function inflate(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('deflate-raw');
  return new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds)).text();
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** SDP lines a data channel does not need (smaller code to paste). */
function trimSdp(sdp: string): string {
  return sdp.split(/\r?\n/).filter((l) => l && !/^a=(extmap|rtcp-fb|ssrc|msid-semantic)/.test(l)).join('\n');
}

export async function makeCode(type: 'offer' | 'answer', sdp: string): Promise<string> {
  return PREFIX[type] + b64url(await deflate(trimSdp(sdp)));
}

export async function readCode(code: string): Promise<{ type: 'offer' | 'answer'; sdp: string }> {
  const c = code.replace(/\s+/g, '');
  const type = c.startsWith(PREFIX.offer) ? 'offer' : c.startsWith(PREFIX.answer) ? 'answer' : null;
  if (!type) throw new Error('This is not an E46Fanatics Scan code. Copy the whole code, starting with E46-INVITE- or E46-REPLY-.');
  try {
    const sdp = (await inflate(unb64url(c.slice(PREFIX[type].length)))).split('\n').join('\r\n') + '\r\n';
    if (!sdp.startsWith('v=0')) throw new Error();
    return { type, sdp };
  } catch {
    throw new Error('The code is incomplete or damaged. Ask for it again and copy all of it.');
  }
}
