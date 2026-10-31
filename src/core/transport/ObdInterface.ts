// "STD:OBD" interface for FTDI based cables (K+DCAN in K-line mode, BMW Scanner 1.4 cable).
// EDIABAS concepts on the K-line:
//   5 / 6     DS1 / DS2        9600 8E1 (rate from the SGBD), XOR checksum, answer length from xawlen
//   0x10D     KWP2000*         9600 8E1, XOR checksum, header B8 <tgt> <src> <len>, answer = byte3 + 4 + checksum
//   0x10F     BMW-FAST         115200 8N1, 8-bit sum, length in the low 6 bits of byte 0 (or byte 3 / bytes 4-5)
// Telegram timing parameters come from the SGBD via xsetpar, exactly as EDIABAS does.
// MS45 (M54 from 2003), ME9 (N42/N46) and MRS5 use the 0x10D / 0x10F concepts; everything older is DS2.
// Concept handling follows the documented EdiabasLib behaviour (GPLv3) and BMWeb's notes (GPLv3, github.com/dader34/BMWeb).

import type { EdInterface, IfhHost } from '../ediabas/EdInterface';
import { ErrorCodes } from '../ediabas/errors';
import { ByteChannel, SerialConfig, sleep } from './ByteChannel';

export type EchoMode = 'auto' | 'on' | 'off';
/**
 * How the cable's DTR line is driven.
 *  'off'    : DTR and RTS low all the time (works with most FTDI K-line cables and the BMW Scanner cable).
 *  'kdcan'  : K+DCAN line control: DTR high only while a K-line telegram is sent (transmit enable), high while idle
 *             on BMW-FAST. Some K+DCAN cables only reach the K-line this way.
 */
export type DtrMode = 'off' | 'kdcan';

export interface ObdOptions {
  /** K-line cables echo every sent byte back. 'auto' detects it on the first telegram. */
  echo?: EchoMode;
  /** Extra milliseconds added to all timeouts (USB latency, slow adapters). */
  extraTimeout?: number;
  /** DTR/RTS levels applied after opening (K+DCAN ignores them in K-line mode). */
  dtr?: boolean;
  rts?: boolean;
  /** Line control of K+DCAN cables (see DtrMode). Default 'off'. */
  dtrMode?: DtrMode;
  /** Called for every telegram (for the protocol log in the UI). */
  onTraffic?: (dir: 'tx' | 'rx' | 'info', bytes: Uint8Array | string) => void;
  /** Result of every telegram: answered, no answer (ignition off / module absent), or cable problem. */
  onLink?: (s: 'answer' | 'noanswer' | 'nocable') => void;
  /** Called once when the errors look like a slow USB adapter (FTDI latency timer at 16 ms). */
  onHint?: (hint: 'latency') => void;
}

export const CONCEPT_DS1 = 5;
export const CONCEPT_DS2 = 6;
export const CONCEPT_KWP2000S = 0x10d;
export const CONCEPT_BMW_FAST = 0x10f;
const SUPPORTED = new Set([CONCEPT_DS1, CONCEPT_DS2, CONCEPT_KWP2000S, CONCEPT_BMW_FAST]);

export const conceptName = (c: number) =>
  c === CONCEPT_DS2 ? 'DS2' : c === CONCEPT_DS1 ? 'DS1' : c === CONCEPT_KWP2000S ? 'KWP2000*' : c === CONCEPT_BMW_FAST ? 'BMW-FAST' : `0x${c.toString(16)}`;
const isKline = (c: number) => c === CONCEPT_DS1 || c === CONCEPT_DS2 || c === CONCEPT_KWP2000S;
const isDs = (c: number) => c === CONCEPT_DS1 || c === CONCEPT_DS2;

/** KWP negative response (7F <service> <code>) with code 78 = "response pending, keep waiting". */
const NEGATIVE = 0x7f;
const PENDING = 0x78;
/** A started answer always gets at least this long to complete (a long fault memory at 9600 baud). */
const FRAME_COMPLETE_MIN_MS = 1500;
/** Extra sends allowed when a transfer was disturbed (echo lost or answer cut off). */
const GARBLED_EXTRA_TRIES = 2;
/** Silence on the line before a disturbed telegram is sent again. */
const QUIET_MS = 60;
/** A late echo (USB scheduling on Windows, a busy laptop) still counts if it arrives within this time. */
const LATE_ECHO_MS = 250;

export class ObdInterface implements EdInterface {
  readonly interfaceType = 'OBD';
  readonly interfaceVersion = 209;
  host: IfhHost | null = null;
  commRepeats = 1;
  loopTest = 1;

  private pars: number[] | null = null;
  private awlen: number[] = [-1, 0];
  /** xawlen came before xsetpar for the next telegram (D_00A4 does this): keep it instead of the concept default. */
  private awlenPending = false;
  private kwpFramed = false;
  private lastRx = 0;
  private echoDetected: boolean | null = null;
  private serialCfg: SerialConfig | null = null;
  private cancelled = false;
  private ports = new Map<number, number>();
  /**
   * Modules that did not answer on BMW-FAST but did on KWP2000* (MS45, ME9: their SGBD tries BMW-FAST first on every
   * initialisation). The BMW-FAST try is skipped for them until the cable is opened again: it saves ~1.6 s per job.
   */
  private notOnFast = new Set<number>();
  private fastSilent = new Set<number>();
  /** Echo/length errors in a row: a slow USB adapter shows up as these. */
  private garbled = 0;
  private hinted = false;

  constructor(
    readonly channel: ByteChannel,
    private opts: ObdOptions = {},
  ) {
    if (opts.echo === 'on') this.echoDetected = true;
    if (opts.echo === 'off') this.echoDetected = false;
  }

  get connected() {
    return this.channel.isOpen;
  }
  get dtrMode(): DtrMode {
    return this.opts.dtrMode ?? 'off';
  }
  /** Changing the line control takes effect on the next telegram. */
  set dtrMode(m: DtrMode) {
    this.opts.dtrMode = m;
    void this.applyIdleSignals().catch(() => undefined);
  }

  private traffic(dir: 'tx' | 'rx' | 'info', b: Uint8Array | string) {
    this.opts.onTraffic?.(dir, b);
  }

  private fail(code: number): null {
    this.host?.setError(code); // throws inside a job when the error is not trapped
    return null;
  }

  private get concept() {
    return this.pars?.[0] ?? CONCEPT_DS2;
  }

  /** Idle level of DTR: low on the K-line concepts, high on BMW-FAST in K+DCAN mode (as EDIABAS drives a plain cable). */
  private async applyIdleSignals() {
    if (!this.channel.isOpen) return;
    const kdcan = this.dtrMode === 'kdcan';
    const dtr = kdcan ? this.concept === CONCEPT_BMW_FAST : this.opts.dtr ?? false;
    await this.channel.setSignals({ dtr, rts: kdcan ? false : this.opts.rts ?? false });
  }

  async connect() {
    if (!this.channel.isOpen) {
      this.serialCfg = { baudRate: 9600, parity: 'even', dataBits: 8, stopBits: 1 };
      await this.channel.open(this.serialCfg);
      this.notOnFast.clear();
      this.fastSilent.clear();
      await this.applyIdleSignals();
    }
    return true;
  }

  async disconnect() {
    if (this.channel.isOpen) await this.channel.close();
    return true;
  }

  async setCommParameter(pars: number[] | null) {
    this.pars = pars && pars.length ? pars : null;
    if (!this.awlenPending) this.awlen = isDs(this.concept) ? [-1, 0] : [0, 0];
    if (!this.pars) return;
    const concept = this.pars[0];
    if (!SUPPORTED.has(concept)) {
      this.traffic('info', `Concept ${conceptName(concept)} not supported on this cable`);
      return;
    }
    const cfg: SerialConfig =
      concept === CONCEPT_BMW_FAST
        ? { baudRate: this.pars[1] || 115200, parity: 'none', dataBits: 8, stopBits: 1 }
        : { baudRate: this.pars[1] || 9600, parity: 'even', dataBits: 8, stopBits: 1 };
    if (!this.serialCfg || cfg.baudRate !== this.serialCfg.baudRate || cfg.parity !== this.serialCfg.parity) {
      this.serialCfg = cfg;
      if (this.channel.isOpen) {
        await this.channel.reconfigure(cfg);
        await this.applyIdleSignals();
      }
    }
  }

  /** Another protocol changed the line settings (OBD-II at 10400 8N1): reconfigure on the next xsetpar. */
  resetLine() {
    this.serialCfg = null;
  }

  setCommAnswerLen(len: number[]) {
    this.awlen = [len[0] ?? 0, len[1] ?? 0].map((v) => (v > 0x7fff ? v - 0x10000 : v));
    this.awlenPending = true;
  }

  /**
   * Timing from xsetpar. The parameter layout differs per concept:
   *   DS1/DS2:   [concept, baud, addr, ?, ?, timeoutStd, regenTime, telEnd, ...]
   *   KWP2000*:  [concept, baud, timeoutStd, regenTime, telEnd, ?, retryNr78, timeoutNr78]
   *   BMW-FAST:  [concept, baud, timeoutStd, regenTime, telEnd, retryNr78, timeoutNr78]
   */
  private get timing() {
    const p = this.pars ?? [];
    const c = this.concept;
    const extra = this.opts.extraTimeout ?? 0;
    // FTDI latency timer is 16 ms: never wait less than that for the next byte
    if (isDs(c)) return { timeout: (p[5] || 1000) + extra, regen: p[6] ?? 25, telEnd: Math.max(p[7] ?? 20, 40) + extra, nr78: 0, nr78Retries: 0 };
    const nr78 = c === CONCEPT_KWP2000S ? p[7] : p[6];
    const retries = c === CONCEPT_KWP2000S ? p[6] : p[5];
    return { timeout: (p[2] || 1000) + extra, regen: p[3] ?? 25, telEnd: Math.max(p[4] ?? 20, 40) + extra, nr78: (nr78 || 5000) + extra, nr78Retries: retries ?? 2 };
  }

  async transmitData(request: Uint8Array): Promise<Uint8Array | null> {
    if (!this.channel.isOpen) {
      this.opts.onLink?.('nocable');
      return this.fail(ErrorCodes.IFH_0018);
    }
    if (!this.pars) return this.fail(ErrorCodes.IFH_0006);
    const concept = this.concept;
    if (!SUPPORTED.has(concept)) return this.fail(ErrorCodes.IFH_0014);
    if (request.length === 0) return new Uint8Array(0);
    this.awlenPending = false;
    const target = concept === CONCEPT_BMW_FAST || concept === CONCEPT_KWP2000S ? request[1] : request[0];
    if (concept === CONCEPT_BMW_FAST && this.notOnFast.has(target)) {
      this.traffic('info', `0x${hex(target)} answers on KWP2000*, not BMW-FAST: skipped`);
      this.opts.onLink?.('noanswer');
      return this.fail(ErrorCodes.IFH_0009);
    }

    let lastError: number = ErrorCodes.IFH_0009;
    // BMW-FAST probes of a K-line module are sent once: the SGBD falls back to KWP2000* itself
    const repeats = concept === CONCEPT_BMW_FAST ? 0 : this.commRepeats;
    // a disturbed transfer (lost echo, cut answer) is a line hiccup, not a missing module: it gets extra tries
    let garbledTries = concept === CONCEPT_BMW_FAST ? 0 : GARBLED_EXTRA_TRIES;
    for (let attempt = 0; attempt <= repeats; attempt++) {
      if (this.cancelled) return this.fail(ErrorCodes.API_0001);
      if (attempt > 0 && (lastError === ErrorCodes.IFH_0003 || lastError === ErrorCodes.IFH_0010)) await this.waitQuiet();
      let r: Uint8Array | number;
      try {
        r = await this.transaction(request);
      } catch {
        r = ErrorCodes.IFH_0018; // write failed: cable unplugged
      }
      if (r instanceof Uint8Array) {
        this.opts.onLink?.('answer');
        this.garbled = 0;
        if (concept === CONCEPT_KWP2000S && this.fastSilent.has(target)) this.notOnFast.add(target);
        return r;
      }
      lastError = r;
      if (r === ErrorCodes.IFH_0003 || r === ErrorCodes.IFH_0010) {
        this.noteGarbled();
        this.traffic('info', `${r === ErrorCodes.IFH_0003 ? 'Echo lost' : 'Answer cut off'} (attempt ${attempt + 1}): the line was disturbed, sending again`);
        if (attempt === repeats && garbledTries > 0) {
          garbledTries--;
          attempt--; // one more try without using up the SGBD's repeats
        }
      }
      if (r === ErrorCodes.IFH_0018 || !this.channel.isOpen) break;
    }
    if (concept === CONCEPT_BMW_FAST && lastError === ErrorCodes.IFH_0009) this.fastSilent.add(target);
    this.opts.onLink?.(lastError === ErrorCodes.IFH_0018 || !this.channel.isOpen ? 'nocable' : 'noanswer');
    return this.fail(lastError);
  }

  /** After a disturbed transfer: let late bytes (an echo or answer that came too late) arrive, then drop them. */
  private async waitQuiet() {
    const quiet = Math.max(this.timing.regen, QUIET_MS);
    for (let i = 0; i < 20; i++) {
      const late = await this.channel.read(256, quiet);
      if (!late.length) break;
      this.traffic('info', `Dropped ${late.length} late byte(s) before sending again`);
    }
    this.channel.discardInput();
    this.lastRx = Date.now();
  }

  private noteGarbled() {
    this.garbled++;
    if (this.garbled >= 3 && !this.hinted) {
      this.hinted = true;
      this.traffic('info', 'Several garbled answers in a row: if this is an FTDI cable, set its latency timer to 1 ms (Windows: Device Manager → port → Advanced)');
      this.opts.onHint?.('latency');
    }
  }

  /** Frame the request with the concept's checksum. */
  private frame(request: Uint8Array) {
    const tx = new Uint8Array(request.length + 1);
    tx.set(request);
    tx[request.length] = this.concept === CONCEPT_BMW_FAST ? sum8(request) : xor(request);
    return tx;
  }

  private checksumOk(rx: Uint8Array) {
    if (rx.length < 2) return false;
    if (this.concept === CONCEPT_BMW_FAST) return sum8(rx.subarray(0, rx.length - 1)) === rx[rx.length - 1];
    return xor(rx) === 0;
  }

  /** Total answer length including the checksum, or null while too few bytes are in. */
  private answerLength(buf: number[]): number | null {
    const c = this.concept;
    if (c === CONCEPT_KWP2000S) return buf.length >= 4 ? buf[3] + 5 : null;
    if (c === CONCEPT_BMW_FAST) {
      if (!buf.length) return null;
      const short = buf[0] & 0x3f;
      if (short) return short + 4;
      if (buf.length < 4) return null;
      if (buf[3] !== 0) return buf[3] + 5;
      return buf.length >= 6 ? ((buf[4] << 8) | buf[5]) + 7 : null;
    }
    return null; // DS1/DS2: the SGBD's xawlen rule, handled in readAnswer
  }

  /** Payload of a KWP answer (after the header), for the response-pending check. */
  private kwpBody(rx: Uint8Array) {
    if (this.concept === CONCEPT_KWP2000S) return rx.subarray(4);
    return rx[0] & 0x3f ? rx.subarray(3) : rx.subarray(rx[3] ? 4 : 6);
  }

  private async send(tx: Uint8Array) {
    const kline = isKline(this.concept);
    const lineCtl = this.dtrMode === 'kdcan' && kline;
    if (lineCtl) await this.channel.setSignals({ dtr: true });
    this.channel.discardInput();
    this.traffic('tx', tx);
    await this.channel.write(tx);
    if (lineCtl) {
      // DTR is the transmit enable: hold it exactly for the telegram's byte time
      const bits = this.serialCfg?.parity === 'none' ? 10 : 11;
      const ms = (tx.length * bits * 1000) / (this.serialCfg?.baudRate || 9600);
      await sleep(Math.max(1, Math.round(ms + 0.3)));
      await this.channel.setSignals({ dtr: false });
    }
  }

  private async transaction(request: Uint8Array): Promise<Uint8Array | number> {
    const { timeout, regen, telEnd, nr78, nr78Retries } = this.timing;
    const tx = this.frame(request);
    // a KWP-framed telegram (B8 header) sent on concept 6 (D_0012, D_00A4, MRS3KW) gets a KWP-framed answer
    this.kwpFramed = isDs(this.concept) && request[0] === 0xb8 && request.length >= 4;
    const wait = this.lastRx + regen - Date.now();
    if (wait > 0) await sleep(wait);
    await this.send(tx);

    // --- echo (single-wire K-line: every byte sent comes back)
    let pending: Uint8Array = new Uint8Array(0);
    if (this.echoDetected !== false) {
      let echo = await this.channel.read(tx.length, telEnd + tx.length * 2);
      if (echo.length === 0 && this.echoDetected) {
        // the echo is late, not lost: the USB driver or the computer held the bytes back
        echo = await this.channel.read(tx.length, LATE_ECHO_MS);
        if (echo.length) this.traffic('info', 'Late echo');
      }
      if (equal(echo, tx)) {
        this.echoDetected = true;
      } else if (echo.length === 0 && this.echoDetected) {
        return ErrorCodes.IFH_0003;
      } else {
        // the echo split across reads or behind a stray byte (a late answer from before): look for it
        const more = echo.length ? await this.channel.read(tx.length, telEnd) : new Uint8Array(0);
        const all = new Uint8Array([...echo, ...more]);
        const at = indexOf(all, tx);
        if (at >= 0) {
          this.echoDetected = true;
          pending = all.subarray(at + tx.length);
        } else if (this.echoDetected === null) {
          // nothing at all came back: no conclusion about the echo yet (cable not on the car, K-line dead)
          if (!all.length) return ErrorCodes.IFH_0009;
          this.echoDetected = false; // cable without echo: what we read already is the answer
          pending = all;
          this.traffic('info', 'Cable without echo detected');
        } else {
          this.traffic('info', 'Invalid echo');
          return ErrorCodes.IFH_0003;
        }
      }
    }

    let rx = await this.readAnswer(pending, timeout, telEnd);
    if (typeof rx === 'number') return rx;
    // KWP: 7F xx 78 = the module needs more time; the real answer follows
    if (!isDs(this.concept)) {
      for (let i = 0; i <= Math.max(nr78Retries, 10) && this.isPending(rx); i++) {
        this.traffic('info', 'Response pending (7F 78), waiting');
        const next = await this.readAnswer(new Uint8Array(0), nr78, telEnd);
        if (typeof next === 'number') return next;
        rx = next;
      }
    }
    return rx;
  }

  private isPending(rx: Uint8Array) {
    const b = this.kwpBody(rx);
    return b[0] === NEGATIVE && b[2] === PENDING;
  }

  private async readAnswer(pending: Uint8Array, timeout: number, telEnd: number): Promise<Uint8Array | number> {
    const parts: number[] = [...pending];
    const need = async (n: number) => {
      while (parts.length < n) {
        const first = parts.length === 0;
        const got = await this.channel.read(n - parts.length, first ? timeout : telEnd);
        if (!got.length) break;
        parts.push(...got);
      }
      return parts.length >= n;
    };
    const c = this.concept;
    if (!isDs(c)) {
      if (!(await need(1))) return ErrorCodes.IFH_0009;
      const t0 = Date.now();
      let total: number | null = null;
      while ((total = this.answerLength(parts)) === null || parts.length < total) {
        if (Date.now() - t0 > Math.max(timeout, FRAME_COMPLETE_MIN_MS)) return ErrorCodes.IFH_0010;
        const want = total === null ? 1 : total - parts.length;
        const got = await this.channel.read(want, telEnd);
        if (!got.length) return ErrorCodes.IFH_0010;
        parts.push(...got);
      }
      parts.length = total;
    } else {
      const [a0, a1] = this.kwpFramed ? [-3, 5] : this.awlen;
      if (a0 > 0) {
        await need(a0);
      } else if (a0 < 0) {
        const idx = -a0;
        if (!(await need(idx + 1))) return parts.length ? ErrorCodes.IFH_0010 : ErrorCodes.IFH_0009;
        const total = parts[idx] + a1;
        if (total < idx + 1) return ErrorCodes.IFH_0010;
        if (!(await need(total))) return ErrorCodes.IFH_0010;
      } else {
        // unknown length: read until telegram end gap
        if (!(await need(1))) return ErrorCodes.IFH_0009;
        for (;;) {
          const more = await this.channel.read(1, telEnd);
          if (!more.length) break;
          parts.push(more[0]);
        }
      }
    }
    this.lastRx = Date.now();
    const rx = new Uint8Array(parts);
    this.traffic('rx', rx);
    if (rx.length === 0) return ErrorCodes.IFH_0009;
    if (!this.checksumOk(rx)) return ErrorCodes.IFH_0010;
    return rx;
  }

  // ---- unsupported / trivial IFH functions for K-line cables
  async transmitFrequent() {
    this.fail(ErrorCodes.IFH_0013);
    return false;
  }
  async receiveFrequent() {
    return this.fail(ErrorCodes.IFH_0013);
  }
  async stopFrequent() {
    return true;
  }
  async rawData(request: Uint8Array) {
    await this.channel.write(request);
    return this.channel.read(256, this.timing.telEnd);
  }
  transmitCancel(cancel: boolean) {
    this.cancelled = cancel;
  }
  async reset() {
    this.channel.discardInput();
    return true;
  }
  async boot() {
    return true;
  }
  async getKeyBytes() {
    return new Uint8Array(0);
  }
  async getState() {
    return new Uint8Array([0x00, 0x00]);
  }
  // FTDI cables cannot measure voltages; report "present" like EDIABAS with UbattHandling=0.
  async getBatteryVoltage() {
    return 12000;
  }
  async getIgnitionVoltage() {
    return 12000;
  }
  getPort(i: number) {
    return this.ports.get(i) ?? 0;
  }
  setPort(i: number, v: number) {
    this.ports.set(i, v);
  }
  setProgramVoltage() {}
  switchSiRelais() {}
}

export function xor(b: ArrayLike<number>) {
  let x = 0;
  for (let i = 0; i < b.length; i++) x ^= b[i];
  return x;
}

export function sum8(b: ArrayLike<number>) {
  let x = 0;
  for (let i = 0; i < b.length; i++) x = (x + b[i]) & 0xff;
  return x;
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function indexOf(hay: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}
