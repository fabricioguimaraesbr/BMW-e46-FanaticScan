// BEST/2 interpreter — TypeScript port of the EDIABAS runtime semantics.
// Behaviour follows EdiabasLib (GPLv3) by Ulrich Holeschak, which documents EDIABAS byte-code execution.

import { PrgFile, TableInfo } from '../prg/PrgFile';
import { encode } from '../util/cp1252';
import { stringToValue } from '../util/numbers';
import { EdInterface, IfhHost } from './EdInterface';
import { EdiabasError, ErrorCodes, TRAP_BITS, errorDescription } from './errors';
import { AddrMode, Flags, Operand, Register, StringData, VmCore, bytesText, getRegister } from './vmtypes';
import { OPCODES } from './ops';

export const EDIABAS_VERSION = 0x773;

import { ResultType, ResultData, ResultSet } from './results';
export { ResultType };
export type { ResultData, ResultSet };

/** Source of SGBD files (the user's C:\EDIABAS\Ecu folder). */
export interface EcuFileProvider {
  /** Returns the file by base name (lower-case, no extension) and extension 'prg' | 'grp', or null. */
  load(baseName: string, ext: 'prg' | 'grp'): Promise<PrgFile | null>;
}

export interface JobRequest {
  sgbd: string; // group or variant name, e.g. "d_motor" or "ms430ds0"
  job: string;
  args?: string | Uint8Array;
  results?: string; // ';' separated list of requested results (optional)
}

export interface JobResponse {
  sgbd: string; // resolved variant
  job: string;
  resultSets: ResultSet[]; // [0] = system results
  error?: { code: number; text: string };
  log?: string[];
}

interface JobInfoExt {
  name: string;
  offset: number;
  arraySize: number;
  file: PrgFile; // file containing the code
  fromUses: boolean;
}

const MAX_FILES = 5;
const SHARED = new Map<string, Uint8Array>();

export interface EdiabasOptions {
  files: EcuFileProvider;
  iface?: EdInterface | null;
  config?: Record<string, string>;
  logLevel?: number; // 0 off, 1 ifh, 2 errors, 3 info (op trace)
  logger?: (line: string) => void;
}

export class Ediabas implements VmCore, IfhHost {
  // ---- VmCore ----
  byteRegs = new Uint8Array(32);
  floatRegs = new Float64Array(16);
  stringRegs: StringData[];
  arrayMaxBufSize = 1024;
  get arrayMaxSize() {
    return this.arrayMaxBufSize - 1;
  }

  readonly files: EcuFileProvider;
  iface: EdInterface | null;
  private config = new Map<string, string>();
  logLevel: number;
  private logger: ((line: string) => void) | null;
  private logBuffer: string[] | null = null;

  // job state
  flags = new Flags();
  stack: number[] = [];
  pc = 0;
  jobEnd = false;
  sgbd: PrgFile | null = null; // currently opened variant / group file
  sgbdBase: PrgFile | null = null; // base file when executing a "uses" job
  tableFile: PrgFile | null = null;
  tableIndex = -1;
  tableRowIndex = -1;
  resultDict = new Map<string, ResultData>();
  resultSysDict = new Map<string, ResultData>();
  resultSetsTemp: ResultSet[] = [];
  resultsRequest = new Set<string>();
  resultJobStatus = '';
  errorTrapBitNr = -1;
  errorTrapMask = 0;
  floatPrecision = 4;
  tokenSeparator = '';
  tokenIndex = 0;
  requestInit = true;
  jobStd = false;
  jobStdExit = false;
  infoProgressRange = -1;
  infoProgressPos = -1;
  infoProgressText = '';
  userFiles: (Uint8Array | null)[] = new Array(MAX_FILES).fill(null);
  abortRequested = false;

  private argString = '';
  private argBinary: Uint8Array | null = null;
  private argStrings: string[] | null = null;
  private argStringStd = '';
  private argBinaryStd: Uint8Array | null = null;
  private argStringsStd: string[] | null = null;

  private jobs = new Map<string, JobInfoExt>();
  private jobList: JobInfoExt[] = [];
  private groupMapping = new Map<string, { variant: string; family: string }>();
  groupName = '';
  familyName = '';
  private sgbdResolveLast = '';
  private sgbdFileName = '';

  onProgress: ((text: string, percent: number) => void) | null = null;

  constructor(opts: EdiabasOptions) {
    this.files = opts.files;
    this.iface = opts.iface ?? null;
    if (this.iface) this.iface.host = this;
    this.logLevel = opts.logLevel ?? 0;
    this.logger = opts.logger ?? null;
    this.stringRegs = [];
    for (let i = 0; i < 16; i++) this.stringRegs.push(new StringData(this, this.arrayMaxBufSize));
    const defaults: Record<string, string> = {
      EdiabasVersion: '7.7.3',
      Simulation: '0',
      BipDebugLevel: '0',
      ApiTrace: '0',
      IfhTrace: '0',
      CompatMode: '1',
      UbattHandling: '0',
      IgnitionHandling: '0',
      ClampHandling: '0',
      RetryComm: '1',
      SystemResults: '1',
      TaskPriority: '0',
      EcuPath: 'C:\\EDIABAS\\ECU',
      Interface: this.iface ? 'STD:OBD' : '',
    };
    for (const [k, v] of Object.entries(defaults)) this.setConfig(k, v);
    for (const [k, v] of Object.entries(opts.config ?? {})) this.setConfig(k, v);
  }

  setInterface(iface: EdInterface | null) {
    this.iface = iface;
    if (iface) iface.host = this;
  }

  // ---------------------------------------------------------------- config / logging
  getConfig(name: string): string | null {
    return this.config.get(name.toUpperCase()) ?? null;
  }
  setConfig(name: string, value: string | null) {
    const key = name.toUpperCase();
    if (value === null || value === '') this.config.delete(key);
    else this.config.set(key, value);
  }

  log(msg: string) {
    if (this.logBuffer) this.logBuffer.push(msg);
    if (this.logger) this.logger(msg);
  }
  private logIf(level: number, msg: () => string) {
    if (this.logLevel >= level) this.log(msg());
  }

  // ---------------------------------------------------------------- errors
  setError(code: number) {
    this.logIf(2, () => `SetError: ${errorDescription(code)}`);
    if (code !== ErrorCodes.NONE) {
      this.errorTrapBitNr = TRAP_BITS.get(code) ?? 0;
      this.sgbdResolveLast = '';
      const active = ((1 << this.errorTrapBitNr) & ~this.errorTrapMask) >>> 0;
      if (active !== 0) this.raiseError(code);
    } else {
      this.errorTrapBitNr = -1;
    }
  }

  raiseError(code: number): never {
    const c = this.jobStdExit ? ErrorCodes.SYS_0018 : code;
    throw new EdiabasError(c);
  }

  // ---------------------------------------------------------------- arguments
  setArgs(args: string | Uint8Array | undefined, std = false) {
    let str = '';
    let bin: Uint8Array | null = null;
    if (typeof args === 'string') {
      str = args;
      bin = args.length > 0 ? encode(args) : null;
    } else if (args instanceof Uint8Array) {
      bin = args.length > 0 ? args : null;
      str = '';
      // EDIABAS: binary args also readable as string
      if (bin) str = Array.from(bin, (b) => String.fromCharCode(b)).join('');
    }
    if (std) {
      this.argStringStd = str;
      this.argBinaryStd = bin;
      this.argStringsStd = null;
    } else {
      this.argString = str;
      this.argBinary = bin;
      this.argStrings = null;
    }
  }

  activeArgBinary(): Uint8Array {
    return (this.jobStd ? this.argBinaryStd : this.argBinary) ?? new Uint8Array(0);
  }

  activeArgStrings(): string[] {
    if (this.jobStd) {
      if (!this.argStringsStd) this.argStringsStd = this.argStringStd.length > 0 ? this.argStringStd.split(';') : [];
      return this.argStringsStd;
    }
    if (!this.argStrings) this.argStrings = this.argString.length > 0 ? this.argString.split(';') : [];
    return this.argStrings;
  }

  setResultsRequests(value: string) {
    this.resultsRequest.clear();
    for (const w of value.split(';')) if (w.length > 0) this.resultsRequest.add(w.toUpperCase());
  }

  // ---------------------------------------------------------------- results
  setResult(r: ResultData) {
    this.resultDict.set(r.name.toUpperCase(), r);
  }
  setSysResult(r: ResultData) {
    this.resultSysDict.set(r.name.toUpperCase(), r);
  }

  private systemResults(jobName: string, usesName: string | null, setCount: number): ResultSet {
    const m: ResultSet = new Map();
    const variant = this.sgbdFileName.replace(/\.(prg|grp)$/i, '').toUpperCase();
    const add = (type: ResultType, name: string, value: number | string) => m.set(name, { type, name, value });
    add(ResultType.S, 'VARIANTE', variant);
    add(ResultType.S, 'GRUPPE', this.groupName.toLowerCase());
    add(ResultType.S, 'FAMILIE', this.familyName.toLowerCase());
    add(ResultType.S, 'OBJECT', usesName ?? this.sgbdFileName.replace(/\.(prg|grp)$/i, ''));
    add(ResultType.S, 'JOBNAME', jobName);
    add(ResultType.W, 'SAETZE', setCount);
    const sysResults = stringToValue(this.getConfig('SystemResults') ?? '0').value;
    if (sysResults !== 0) {
      add(ResultType.S, 'JOBSTATUS', this.resultJobStatus);
      add(ResultType.I, 'UBATTCURRENT', -1);
      add(ResultType.I, 'UBATTHISTORY', -1);
      add(ResultType.I, 'IGNITIONCURRENT', -1);
      add(ResultType.I, 'IGNITIONHISTORY', -1);
    }
    for (const [k, v] of this.resultSysDict) if (!m.has(k)) m.set(k, v);
    return m;
  }

  // ---------------------------------------------------------------- files / tables
  private async loadFile(base: string): Promise<PrgFile | null> {
    const b = base.toLowerCase().replace(/\.(prg|grp)$/, '');
    return (await this.files.load(b, 'prg')) ?? (await this.files.load(b, 'grp'));
  }

  private async openSgbd(): Promise<void> {
    if (this.sgbd) return;
    const base = this.sgbdFileName.toLowerCase().replace(/\.(prg|grp)$/, '');
    const ext = this.sgbdFileName.toLowerCase().endsWith('.grp') ? 'grp' : 'prg';
    const f = await this.files.load(base, ext);
    if (!f) throw new EdiabasError(ErrorCodes.SYS_0002, `SGBD not found: ${this.sgbdFileName}`);
    this.sgbd = f;
    // build job table (own jobs first, then jobs of used base files)
    this.jobs.clear();
    this.jobList = [];
    for (const j of f.ownJobs) this.addJob({ name: j.name, offset: j.offset, arraySize: j.arraySize, file: f, fromUses: false });
    for (const u of f.uses) {
      const uf = await this.files.load(u.toLowerCase(), 'prg');
      if (!uf) {
        this.log(`ReadAllJobs file not found: ${u}`);
        continue;
      }
      for (const j of uf.ownJobs) {
        const up = j.name.toUpperCase();
        if (up === 'INITIALISIERUNG' || up === 'ENDE') {
          this.jobList.push({ name: j.name, offset: j.offset, arraySize: j.arraySize, file: uf, fromUses: true });
          continue;
        }
        this.addJob({ name: j.name, offset: j.offset, arraySize: j.arraySize, file: uf, fromUses: true });
      }
    }
    this.requestInit = true;
  }

  private addJob(j: JobInfoExt) {
    this.jobList.push(j);
    const k = j.name.toUpperCase();
    if (!this.jobs.has(k)) this.jobs.set(k, j);
  }

  private async closeSgbd(): Promise<void> {
    if (this.sgbd) {
      try {
        if (!this.requestInit) await this.executeExitJob();
      } finally {
        this.sgbd = null;
      }
    }
  }

  get currentSgbd(): PrgFile | null {
    return this.sgbd;
  }
  get jobNames(): string[] {
    return this.jobList.filter((j) => !j.fromUses).map((j) => j.name);
  }

  getTableFile(): PrgFile {
    return this.tableFile ?? this.sgbd!;
  }
  closeTable() {
    this.tableFile = null;
    this.tableIndex = -1;
    this.tableRowIndex = -1;
  }
  setTableFile(f: PrgFile) {
    this.tableFile = f;
  }

  tableGetIndex(f: PrgFile, name: string): { idx: number; found: boolean } {
    const i = f.tableIndex.get(name.toUpperCase());
    if (i !== undefined) {
      f.indexTable(f.tables[i]);
      return { idx: i, found: true };
    }
    return { idx: f.tables.length - 1, found: false };
  }

  private table(f: PrgFile, idx: number): TableInfo | null {
    if (idx < 0 || idx >= f.tables.length) return null;
    return f.tables[idx];
  }

  tableColumns(f: PrgFile, idx: number): number {
    return this.table(f, idx)?.columns ?? 0;
  }
  tableRows(f: PrgFile, idx: number): number {
    return this.table(f, idx)?.rows ?? 0;
  }

  tableLine(f: PrgFile, idx: number, line: number): { row: number; found: boolean } {
    const t = this.table(f, idx);
    if (!t) return { row: -1, found: false };
    if (line >= t.rows) return { row: t.rows - 1, found: false };
    return { row: line, found: true };
  }

  tableSeekString(f: PrgFile, idx: number, column: string, value: string): { row: number; found: boolean } {
    const t = this.table(f, idx);
    if (!t) return { row: -1, found: false };
    f.indexTable(t);
    const col = t.columnIndex!.get(column.toUpperCase());
    if (col === undefined) return { row: -1, found: false };
    if (!t.seekString) t.seekString = new Array(t.columns);
    let dict = t.seekString[col];
    if (!dict) {
      dict = new Map();
      for (let i = 1; i < t.entries!.length; i++) {
        const s = f.stringAt(t.entries![i][col]).toUpperCase();
        if (!dict.has(s)) dict.set(s, i - 1);
      }
      t.seekString[col] = dict;
    }
    const r = dict.get(value.toUpperCase());
    if (r !== undefined) return { row: r, found: true };
    return { row: t.rows - 1, found: false };
  }

  tableSeekValue(f: PrgFile, idx: number, column: string, value: number): { row: number; found: boolean } {
    const t = this.table(f, idx);
    if (!t) return { row: -1, found: false };
    f.indexTable(t);
    const col = t.columnIndex!.get(column.toUpperCase());
    if (col === undefined) return { row: -1, found: false };
    if (!t.seekValue) t.seekValue = new Array(t.columns);
    let dict = t.seekValue[col];
    if (!dict) {
      dict = new Map();
      for (let i = 1; i < t.entries!.length; i++) {
        const v = stringToValue(f.stringAt(t.entries![i][col])).value >>> 0;
        if (!dict.has(v)) dict.set(v, i - 1);
      }
      t.seekValue[col] = dict;
    }
    const r = dict.get(value >>> 0);
    if (r !== undefined) return { row: r, found: true };
    return { row: t.rows - 1, found: false };
  }

  tableEntry(f: PrgFile, idx: number, row: number, column: string): { entry: string | null; columnInvalid: boolean } {
    const t = this.table(f, idx);
    if (!t) return { entry: null, columnInvalid: false };
    f.indexTable(t);
    const col = t.columnIndex!.get(column.toUpperCase());
    if (col === undefined) return { entry: null, columnInvalid: true };
    if (row < 0 || row >= t.rows) return { entry: null, columnInvalid: false };
    return { entry: f.stringAt(t.entries![row + 1][col]), columnInvalid: false };
  }

  async findTableFileExt(baseName: string): Promise<PrgFile | null> {
    return this.loadFile(baseName);
  }

  // ---------------------------------------------------------------- progress
  progressInform() {
    if (this.onProgress) {
      const pct = this.infoProgressPos < 0 || this.infoProgressRange <= 0 ? -1 : Math.floor((this.infoProgressPos * 100) / this.infoProgressRange);
      this.onProgress(this.infoProgressText, pct);
    }
  }

  // ---------------------------------------------------------------- SGBD resolution
  async resolveSgbd(fileName: string): Promise<string> {
    const base = fileName.toLowerCase().replace(/\.(prg|grp)$/, '');
    if (this.sgbdResolveLast === base) return this.sgbdFileName;
    try {
      let f = await this.files.load(base, 'prg');
      let isGroup = false;
      if (!f) {
        f = await this.files.load(base, 'grp');
        if (!f) throw new EdiabasError(ErrorCodes.SYS_0002, `File not found: ${base}`);
      }
      isGroup = f.fileType === 0;
      if (isGroup) {
        let mapping = this.groupMapping.get(base);
        if (!mapping) {
          await this.setSgbdFileName(base + '.grp');
          const { variant, family } = await this.executeIdentJob();
          if (!variant) throw new EdiabasError(ErrorCodes.SYS_0012, 'ResolveSgbdFile: No variant found');
          mapping = { variant: variant.toLowerCase(), family: family.toLowerCase() };
          this.groupMapping.set(base, mapping);
        }
        this.groupName = base;
        this.familyName = mapping.family;
        await this.setSgbdFileName(mapping.variant + '.prg');
      } else {
        this.groupName = '';
        this.familyName = '';
        await this.setSgbdFileName(base + '.prg');
      }
      this.sgbdResolveLast = base;
      return this.sgbdFileName;
    } catch (e) {
      this.groupName = '';
      this.familyName = '';
      this.sgbdFileName = '';
      this.sgbdResolveLast = '';
      throw e;
    }
  }

  private async setSgbdFileName(name: string) {
    if (this.sgbdFileName.toLowerCase() !== name.toLowerCase()) {
      await this.closeSgbd();
      this.sgbdFileName = name;
    }
  }

  clearGroupMapping() {
    this.groupMapping.clear();
    this.sgbdResolveLast = '';
  }

  // ---------------------------------------------------------------- job execution
  private async executeInitJob() {
    const oldStd = this.jobStd;
    try {
      this.jobStd = true;
      let sets: ResultSet[];
      try {
        sets = await this.executeJobPrivate('INITIALISIERUNG', true);
      } catch (e) {
        this.sgbd = null; // force reload
        throw e;
      }
      const done = sets.length > 1 ? sets[1].get('DONE') : undefined;
      if (done && done.value === 1) {
        this.requestInit = false;
        return;
      }
      this.log('executeInitJob failed');
      this.sgbd = null;
      this.setError(ErrorCodes.SYS_0010);
    } finally {
      this.jobStd = oldStd;
    }
  }

  private async executeExitJob() {
    const oldStd = this.jobStd;
    try {
      this.jobStd = true;
      this.jobStdExit = true;
      if (this.jobs.has('ENDE')) await this.executeJobPrivate('ENDE', false);
    } finally {
      this.jobStd = oldStd;
      this.jobStdExit = false;
    }
  }

  private async executeIdentJob(): Promise<{ variant: string; family: string }> {
    const oldStd = this.jobStd;
    try {
      this.jobStd = true;
      this.resultDict.clear();
      const sets = await this.executeJobPrivate('IDENTIFIKATION', false);
      let family = '';
      if (sets.length > 1) {
        const f = sets[1].get('FAMILIE');
        if (f && typeof f.value === 'string') family = f.value;
        const v = sets[1].get('VARIANTE');
        if (v && typeof v.value === 'string') return { variant: v.value, family };
      }
      return { variant: '', family };
    } finally {
      this.jobStd = oldStd;
    }
  }

  private lastResultSets: ResultSet[] = [];

  private async executeJobPrivate(jobName: string, recursive: boolean): Promise<ResultSet[]> {
    this.logIf(1, () => `executeJob(${this.sgbdFileName}): ${jobName} ${this.activeArgStrings().join(', ')}`);
    await this.openSgbd();
    const bip = this.sgbd!.version.bipVersion;
    const ediabasBip = (((EDIABAS_VERSION >> 8) & 0xf) << 16) | (((EDIABAS_VERSION >> 4) & 0xf) << 8) | (EDIABAS_VERSION & 0xf);
    if (bip > ediabasBip) {
      this.setError(ErrorCodes.BIP_0009);
      return [];
    }
    const job = this.jobs.get(jobName.toUpperCase());
    if (!job) {
      const vjob = VJOBS[jobName.toUpperCase()];
      if (vjob) return this.executeVJob(jobName, vjob);
      this.setError(ErrorCodes.SYS_0008);
      return [];
    }
    if (job.fromUses) {
      this.sgbdBase = job.file;
      try {
        return await this.runJob(job, recursive);
      } finally {
        this.closeTable();
        this.sgbdBase = null;
      }
    }
    return this.runJob(job, recursive);
  }

  private async executeVJob(name: string, fn: (e: Ediabas, sets: ResultSet[]) => void): Promise<ResultSet[]> {
    if (this.requestInit) await this.executeInitJob();
    const sets: ResultSet[] = [];
    try {
      fn(this, sets);
    } finally {
      sets.unshift(this.systemResults(name.toUpperCase(), null, sets.length));
      this.lastResultSets = sets;
    }
    return sets;
  }

  private async runJob(job: JobInfoExt, recursive: boolean): Promise<ResultSet[]> {
    if (this.requestInit && !recursive) await this.executeInitJob();
    this.iface?.transmitCancel(false);

    this.resultSetsTemp = [];
    this.resultDict.clear();
    this.resultSysDict.clear();
    this.stack = [];
    this.flags.init();
    for (const s of this.stringRegs) s.clear();
    this.errorTrapBitNr = -1;
    this.errorTrapMask = 0;
    this.infoProgressRange = -1;
    this.infoProgressPos = -1;
    this.infoProgressText = '';
    this.resultJobStatus = '';
    this.setConfig('BipEcuFile', this.sgbdFileName.replace(/\.(prg|grp)$/i, ''));

    this.arrayMaxBufSize = job.arraySize;
    for (const s of this.stringRegs) s.newArrayLength(this.arrayMaxBufSize);
    this.pc = job.offset;
    this.closeTable();
    this.userFiles.fill(null);
    this.jobEnd = false;

    const code = job.file.dec;
    const arg0 = new Operand(this);
    const arg1 = new Operand(this);
    let steps = 0;
    try {
      while (!this.jobEnd) {
        const pcOld = this.pc;
        let p = this.pc;
        const opCode = code[p++];
        const modes = code[p++];
        const op = OPCODES[opCode];
        if (!op) throw new Error(`Opcode out of range: ${opCode.toString(16)} at ${pcOld.toString(16)}`);
        p = readOpArg(this, code, p, (modes >> 4) & 0x0f, arg0);
        p = readOpArg(this, code, p, modes & 0x0f, arg1);
        this.pc = p;
        if (op.nearAddr && arg0.mode === AddrMode.Imm32) {
          arg0.d1 = ((this.pc + (arg0.d1 as number)) >>> 0);
        }
        if (this.abortRequested) {
          this.iface?.transmitCancel(true);
          throw new EdiabasError(ErrorCodes.API_0001, 'Job aborted');
        }
        if (!op.fn) throw new Error(`Opcode not implemented: ${op.name}`);
        if (this.logLevel >= 3) this.log(`>${pcOld.toString(16).padStart(8, '0')}: ${op.name} ${arg0.text()}${arg1.mode ? ', ' + arg1.text() : ''}`);
        const r = op.fn(this, arg0, arg1);
        if (r) await r;
        if (++steps > 50_000_000) throw new Error('Job step limit exceeded');
        if ((steps & 0x3ffff) === 0) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
      }
      if (this.resultDict.size > 0) this.resultSetsTemp.push(new Map(this.resultDict));
      this.resultDict.clear();
    } finally {
      this.closeTable();
      this.userFiles.fill(null);
      const sys = this.systemResults(job.name, job.fromUses ? job.file.name : null, this.resultSetsTemp.length);
      this.resultSetsTemp.unshift(sys);
      this.lastResultSets = this.resultSetsTemp;
      this.setConfig('BipEcuFile', null);
    }
    return this.resultSetsTemp;
  }

  /** Public API: resolve group/variant and execute a job. Never throws; errors are returned. */
  async executeJob(req: JobRequest): Promise<JobResponse> {
    const log: string[] = [];
    this.logBuffer = log;
    this.abortRequested = false;
    let resolved = '';
    try {
      this.setArgs(req.args);
      this.setResultsRequests(req.results ?? '');
      this.jobStd = false;
      this.jobStdExit = false;
      resolved = await this.resolveSgbd(req.sgbd);
      const sets = await this.executeJobPrivate(req.job, false);
      return { sgbd: resolved.replace(/\.(prg|grp)$/i, ''), job: req.job, resultSets: sets, log };
    } catch (e) {
      const code = e instanceof EdiabasError ? e.code : ErrorCodes.SYS_0000;
      const text = e instanceof EdiabasError ? e.message : String((e as Error)?.message ?? e);
      return {
        sgbd: (resolved || req.sgbd).replace(/\.(prg|grp)$/i, ''),
        job: req.job,
        resultSets: this.lastResultSets ?? [],
        error: { code, text },
        log,
      };
    } finally {
      this.argBinary = null;
      this.argString = '';
      this.argStrings = null;
      this.argBinaryStd = null;
      this.argStringStd = '';
      this.argStringsStd = null;
      this.logBuffer = null;
      this.jobStd = false;
    }
  }

  abort() {
    this.abortRequested = true;
  }

  /** Close the current SGBD (runs the ENDE job if present). */
  async close() {
    await this.closeSgbd();
    this.sgbdFileName = '';
    this.sgbdResolveLast = '';
  }

  // ---------------------------------------------------------------- user files (fopen etc.) – not supported in browser
  userFile(h: number): Uint8Array | null {
    return h >= 0 && h < MAX_FILES ? this.userFiles[h] : null;
  }

  sharedGet(key: string) {
    return SHARED.get(key.toUpperCase());
  }
  sharedSet(key: string, v: Uint8Array) {
    SHARED.set(key.toUpperCase(), v);
  }

  get jobListAll() {
    return this.jobList;
  }
}

// ---------------------------------------------------------------------------- operand decoding
function readOpArg(vm: Ediabas, code: Uint8Array, p: number, mode: number, op: Operand): number {
  const u16 = (o: number) => code[o] | (code[o + 1] << 8);
  switch (mode as AddrMode) {
    case AddrMode.None:
      op.init(AddrMode.None);
      return p;
    case AddrMode.RegS:
    case AddrMode.RegAb:
    case AddrMode.RegI:
    case AddrMode.RegL:
      op.init(mode, getRegister(code[p]));
      return p + 1;
    case AddrMode.Imm8:
      op.init(mode, code[p]);
      return p + 1;
    case AddrMode.Imm16:
      op.init(mode, u16(p));
      return p + 2;
    case AddrMode.Imm32:
      op.init(mode, (code[p] | (code[p + 1] << 8) | (code[p + 2] << 16) | (code[p + 3] << 24)) >>> 0);
      return p + 4;
    case AddrMode.ImmStr: {
      const len = (u16(p) << 16) >> 16;
      const n = Math.max(0, len);
      op.init(mode, code.slice(p + 2, p + 2 + n));
      return p + 2 + n;
    }
    case AddrMode.IdxImm:
      op.init(mode, getRegister(code[p]), u16(p + 1));
      return p + 3;
    case AddrMode.IdxReg:
      op.init(mode, getRegister(code[p]), getRegister(code[p + 1]));
      return p + 2;
    case AddrMode.IdxRegImm:
      op.init(mode, getRegister(code[p]), getRegister(code[p + 1]), u16(p + 2));
      return p + 4;
    case AddrMode.IdxImmLenImm:
      op.init(mode, getRegister(code[p]), u16(p + 1), u16(p + 3));
      return p + 5;
    case AddrMode.IdxImmLenReg:
      op.init(mode, getRegister(code[p]), u16(p + 1), getRegister(code[p + 3]));
      return p + 4;
    case AddrMode.IdxRegLenImm:
      op.init(mode, getRegister(code[p]), getRegister(code[p + 1]), u16(p + 2));
      return p + 4;
    case AddrMode.IdxRegLenReg:
      op.init(mode, getRegister(code[p]), getRegister(code[p + 1]), getRegister(code[p + 2]));
      return p + 3;
  }
  void vm;
  throw new Error('Unsupported address mode ' + mode);
}

// ---------------------------------------------------------------------------- virtual jobs
const VJOBS: Record<string, (e: Ediabas, sets: ResultSet[]) => void> = {
  _JOBS: (e, sets) => {
    const all = e.activeArgStrings()[0]?.toUpperCase() === 'ALL';
    const seen = new Set<string>();
    for (const j of e.jobListAll) {
      const k = j.name.toUpperCase();
      if ((all && !seen.has(k)) || !j.fromUses) {
        sets.push(new Map([['JOBNAME', { type: ResultType.S, name: 'JOBNAME', value: j.name }]]));
        seen.add(k);
      }
    }
  },
  _JOBCOMMENTS: (e, sets) => {
    const a = e.activeArgStrings();
    if (a.length < 1) return;
    const lines = e.currentSgbd!.descriptions.jobs.get(a[0].toUpperCase());
    if (!lines) return;
    const m: ResultSet = new Map();
    let n = 0;
    for (const d of lines) {
      const c = d.indexOf(':');
      if (c < 0) continue;
      const key = d.substring(0, c);
      if (key.toUpperCase() === 'JOBCOMMENT') {
        const k = key + n++;
        if (!m.has(k)) m.set(k, { type: ResultType.S, name: k, value: d.substring(c + 1) });
      }
    }
    if (m.size) sets.push(m);
  },
  _ARGUMENTS: (e, sets) => docSets(e, sets, 'ARG'),
  _RESULTS: (e, sets) => docSets(e, sets, 'RESULT'),
  _VERSIONINFO: (e, sets) => {
    const f = e.currentSgbd!;
    const v = f.version;
    const m: ResultSet = new Map();
    const add = (name: string, value: string | number, type = ResultType.S) => m.set(name, { type, name, value });
    add('BIP_VERSION', `${(v.bipVersion >> 16) & 0xff}.${(v.bipVersion >> 8) & 0xff}.${v.bipVersion & 0xff}`);
    add('AUTHOR', v.author);
    add('REVISION', v.revision);
    add('FROM', v.from);
    add('PACKAGE', v.packageVersion, ResultType.L);
    let dc = 0;
    let uc = 0;
    for (const d of f.descriptions.global) {
      const c = d.indexOf(':');
      if (c < 0) continue;
      let key = d.substring(0, c);
      if (key.toUpperCase() === 'ECUCOMMENT') key += dc++;
      if (key.toUpperCase() === 'USES') key += uc++;
      if (!m.has(key)) add(key, d.substring(c + 1));
    }
    sets.push(m);
  },
  _TABLES: (e, sets) => {
    for (const t of e.currentSgbd!.tables) sets.push(new Map([['TABLE', { type: ResultType.S, name: 'TABLE', value: t.name }]]));
  },
  _TABLE: (e, sets) => {
    const a = e.activeArgStrings();
    if (a.length < 1) return;
    const rows = e.currentSgbd!.tableRows(a[0]);
    if (!rows) return;
    for (const row of rows) {
      const m: ResultSet = new Map();
      row.forEach((s, j) => m.set('COLUMN' + j, { type: ResultType.S, name: 'COLUMN' + j, value: s }));
      sets.push(m);
    }
  },
};

function docSets(e: Ediabas, sets: ResultSet[], kind: 'ARG' | 'RESULT') {
  const a = e.activeArgStrings();
  if (a.length < 1) return;
  const lines = e.currentSgbd!.descriptions.jobs.get(a[0].toUpperCase());
  if (!lines) return;
  let m: ResultSet | null = null;
  let n = 0;
  for (const d of lines) {
    const c = d.indexOf(':');
    if (c < 0) continue;
    const key = d.substring(0, c);
    const ku = key.toUpperCase();
    const value = d.substring(c + 1);
    if (ku === kind) {
      if (m && m.size) sets.push(m);
      m = new Map();
      n = 0;
    }
    if (!m) continue;
    if (ku === kind || ku === kind + 'TYPE') {
      if (!m.has(key)) m.set(key, { type: ResultType.S, name: key, value });
    } else if (ku === kind + 'COMMENT') {
      const k = key + n++;
      if (!m.has(k)) m.set(k, { type: ResultType.S, name: k, value });
    }
  }
  if (m && m.size) sets.push(m);
}

export { Register, bytesText };
