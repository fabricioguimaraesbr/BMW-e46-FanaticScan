// Module files for what is in the "modulos" folder, plug-and-play for the rest.
// Example: the folder has MS43 only and the car is a 318i (ME9) → the engine is read over OBD-II,
// the other modules with their BMW files. One K-line, so every call goes through one queue.

import type { NativeSession } from '../native/NativeSession';
import type { SafetyMode } from './safety';
import type { DiagSession, ScanEntry, Session } from './DiagSession';
import { E46_MODULES, ModuleDef } from './modules';

const MISSING_FILE = /SGBD not found/i;

export class HybridSession implements Session {
  readonly kind = 'ediabas' as const;
  private queue: Promise<unknown> = Promise.resolve();
  private mode: SafetyMode = 'read';

  constructor(
    private diag: DiagSession,
    readonly native: NativeSession,
    private resetLine: () => void,
  ) {}

  get safetyMode() {
    return this.mode;
  }
  set safetyMode(m: SafetyMode) {
    this.mode = m;
    this.diag.safetyMode = m;
    this.native.safetyMode = m;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }
  private isNative = (variant: string) => variant.startsWith('native:');

  /** Runs on the module files: drop the OBD-II session first (it uses 10400 baud and a keep-alive). */
  private viaDiag<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.native.iso.isReady) {
        this.native.iso.release();
        this.resetLine();
      }
      return fn();
    });
  }
  private route<T>(variant: string, diag: () => Promise<T>, native: () => Promise<T>): Promise<T> {
    return this.isNative(variant) ? this.serial(native) : this.viaDiag(diag);
  }

  abort() {
    this.diag.abort();
    this.native.abort();
  }

  async scan(modules: ModuleDef[] = E46_MODULES, onEntry?: (e: ScanEntry) => void): Promise<ScanEntry[]> {
    const out: ScanEntry[] = [];
    for (const m of modules) {
      let [e] = await this.viaDiag(() => this.diag.scan([m]));
      // the group or the module's own file is not in the folder: identify it without files
      if (!e.variant && e.error && MISSING_FILE.test(e.error)) [e] = await this.serial(() => this.native.scan([m]));
      else if (e.variant && e.error && MISSING_FILE.test(e.error)) [e] = await this.serial(() => this.native.scan([m]));
      out.push(e);
      onEntry?.(e);
    }
    return out;
  }

  readDtcs(variant: string) {
    return this.route(variant, () => this.diag.readDtcs(variant), () => this.native.readDtcs(variant));
  }
  clearDtcs(variant: string) {
    return this.route(variant, () => this.diag.clearDtcs(variant), () => this.native.clearDtcs(variant));
  }
  readValues(variant: string, job: string, args?: string) {
    return this.route(variant, () => this.diag.readValues(variant, job, args), () => this.native.readValues(variant, job));
  }
  checkAvailability(variant: string, ident: Record<string, unknown>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean) {
    return this.route(variant, () => this.diag.checkAvailability(variant, ident, onProgress, shouldStop), () => this.native.checkAvailability(variant));
  }
  listJobs(variant: string) {
    return this.isNative(variant) ? this.native.listJobs(variant) : this.diag.listJobs(variant);
  }
  /** Raw DS2 exchange (cluster EEPROM for the gauge curve), on the same queue as every job. */
  ds2Raw(addr: number, data: number[], timeout?: number) {
    return this.serial(() => this.native.ds2Raw(addr, data, timeout));
  }
  run(variant: string, job: string, args?: string) {
    return this.route(variant, () => this.diag.run(variant, job, args), () => this.native.run(variant, job));
  }
}
