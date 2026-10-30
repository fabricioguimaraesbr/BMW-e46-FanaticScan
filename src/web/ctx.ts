// What the extra screens (Garage, Data Logger, Service) need from the main app.

import type { Availability, Dtc, JobListEntry, ScanEntry, Session } from '../core/api/DiagSession';
import type { ModuleDef } from '../core/api/modules';

export interface ModInfo {
  def: ModuleDef;
  scan?: ScanEntry;
  dtcs?: Dtc[];
  dtcNA?: string;
  dtcError?: string;
  jobs?: JobListEntry[];
  avail?: Availability;
}

export interface PageCtx {
  session(): Session | null;
  mode(): 'cable' | 'sim' | 'remote' | null;
  scanning(): boolean;
  /** modules that answered the scan, in E46_MODULES order */
  found(): ModInfo[];
  /** loads (and caches) the job list of a found module */
  jobs(group: string): Promise<JobListEntry[]>;
  /** value groups of a module that live data may read (supported and fitted) */
  liveJobs(group: string): string[];
  cableOk(): boolean;
  isService(): boolean;
  unlockService(): Promise<void>;
  /** stops the Live Data loop (one K-line: the logger and live data never run together) */
  stopLive(): void;
  busy(): boolean;
  setBusy(b: string): void;
  carTitle(): string;
  log(cls: string, text: string): void;
  rerender(): void;
  /** opens Live Data of a found module (by its short name, e.g. 'DME') */
  goLive(short: string): void;
  /** switches to another screen (service, library…) */
  goPage(page: string): void;
  /** re-reads the fault memory of every found module */
  readAllFaults(): Promise<void>;
}
