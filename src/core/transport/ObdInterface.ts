// "STD:OBD" interface for FTDI based cables (K+DCAN in K-line mode, BMW Scanner 1.4 cable).
// Implements EDIABAS concept 6 (DS2 / BMW KWP on K-line, XOR checksum) on top of a ByteChannel.
// Telegram timing parameters come from the SGBD via xsetpar, exactly as EDIABAS does.

import type { EdInterface, IfhHost } from '../ediabas/EdInterface';
import { ErrorCodes } from '../ediabas/errors';
import { ByteChannel, SerialConfig, sleep } from './ByteChannel';

export type EchoMode = 'auto' | 'on' | 'off';

export interface ObdOptions {
  /** K-line cables echo every sent byte back. 'auto' detects it on the first telegram. */
  echo?: EchoMode;
  /** Extra milliseconds added to all timeouts (USB latency, slow adapters). */
  extraTimeout?: number;
  /** DTR/RTS levels applied after opening (K+DCAN ignores them in K-line mode). */
  dtr?: boolean;
  rts?: boolean;
  /** Called for every telegram (for the protocol log in the UI). */
  onTraffic?: (dir: 'tx' | 'rx' | 'info', bytes: Uint8Array | string) => void;
  /** Result of every telegram: answered, no answer (ignition off / module absent), or cable problem. */
  onLink?: (s: 'answer' | 'noanswer' | 'nocable') => void;
}

const CONCEPT_DS2 = 6;

export class ObdInterface implements EdInterface {
  readonly interfaceType = 'OBD';
  readonly interfaceVersion = 209;
  host: IfhHost | null = null;
  commRepeats = 1;
  loopTest = 1;

  private pars: number[] | null = null;
  private awlen: number[] = [-1, 0];
  private lastRx = 0;
  private echoDetected: boolean | null = null;
  private serialCfg: SerialConfig | null = null;
  private cancelled = false;
  private ports = new Map<number, number>();

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

  private traffic(dir: 'tx' | 'rx' | 'info', b: Uint8Array | string) {
    this.opts.onTraffic?.(dir, b);
  }

  private fail(code: number): null {
    this.host?.setError(code); // throws inside a job when the error is not trapped
    return null;
  }

  async connect() {
    if (!this.channel.isOpen) {
      this.serialCfg = { baudRate: 9600, parity: 'even', dataBits: 8, stopBits: 1 };
      await this.channel.open(this.serialCfg);
      await this.channel.setSignals({ dtr: this.opts.dtr ?? false, rts: this.opts.rts ?? false });
    }
    return true;
  }

  async disconnect() {
    if (this.channel.isOpen) await this.channel.close();
    return true;
  }

  async setCommParameter(pars: number[] | null) {
    this.pars = pars && pars.length ? pars : null;
    this.awlen = [-1, 0];
    if (!this.pars) return;
    const concept = this.pars[0];
    if (concept === CONCEPT_DS2) {
      const cfg: SerialConfig = { baudRate: this.pars[1] || 9600, parity: 'even', dataBits: 8, stopBits: 1 };
      if (!this.serialCfg || cfg.baudRate !== this.serialCfg.baudRate || cfg.parity !== this.serialCfg.parity) {
        this.serialCfg = cfg;
        if (this.channel.isOpen) await this.channel.reconfigure(cfg);
      }
    } else {
      this.traffic('info', `Concept 0x${concept.toString(16)} not supported yet`);
    }
  }

  /** Another protocol changed the line settings (OBD-II at 10400 8N1): reconfigure on the next xsetpar. */
  resetLine() {
    this.serialCfg = null;
  }

  setCommAnswerLen(len: number[]) {
    this.awlen = [len[0] ?? 0, len[1] ?? 0].map((v) => (v > 0x7fff ? v - 0x10000 : v));
  }

  /** DS2 timing from xsetpar: [concept, baud, addr, ?, ?, timeoutStd, regenTime, telEnd, ...] */
  private get timing() {
    const p = this.pars ?? [];
    const extra = this.opts.extraTimeout ?? 0;
    return {
      timeout: (p[5] || 1000) + extra,
      regen: p[6] ?? 25,
      telEnd: Math.max(p[7] ?? 20, 40) + extra, // FTDI latency timer is 16 ms
    };
  }

  async transmitData(request: Uint8Array): Promise<Uint8Array | null> {
    if (!this.channel.isOpen) {
      this.opts.onLink?.('nocable');
      return this.fail(ErrorCodes.IFH_0018);
    }
    if (!this.pars) return this.fail(ErrorCodes.IFH_0006);
    if (this.pars[0] !== CONCEPT_DS2) return this.fail(ErrorCodes.IFH_0014);
    if (request.length === 0) return new Uint8Array(0);

    let lastError: number = ErrorCodes.IFH_0009;
    for (let attempt = 0; attempt <= this.commRepeats; attempt++) {
      if (this.cancelled) return this.fail(ErrorCodes.API_0001);
      let r: Uint8Array | number;
      try {
        r = await this.ds2Transaction(request);
      } catch {
        r = ErrorCodes.IFH_0018; // write failed: cable unplugged
      }
      if (r instanceof Uint8Array) {
        this.opts.onLink?.('answer');
        return r;
      }
      lastError = r;
      if (r === ErrorCodes.IFH_0018 || !this.channel.isOpen) break;
    }
    this.opts.onLink?.(lastError === ErrorCodes.IFH_0018 || !this.channel.isOpen ? 'nocable' : 'noanswer');
    return this.fail(lastError);
  }

  private async ds2Transaction(request: Uint8Array): Promise<Uint8Array | number> {
    const { timeout, regen, telEnd } = this.timing;
    const tx = new Uint8Array(request.length + 1);
    tx.set(request);
    tx[request.length] = xor(request);

    const wait = this.lastRx + regen - Date.now();
    if (wait > 0) await sleep(wait);
    this.channel.discardInput();
    this.traffic('tx', tx);
    await this.channel.write(tx);

    // --- echo
    let pending: Uint8Array = new Uint8Array(0);
    if (this.echoDetected !== false) {
      const echo = await this.channel.read(tx.length, telEnd + tx.length * 2);
      if (equal(echo, tx)) {
        this.echoDetected = true;
      } else if (this.echoDetected === null) {
        this.echoDetected = false; // cable without echo: what we read already is the answer
        pending = echo;
        this.traffic('info', 'Cable without echo detected');
      } else {
        this.traffic('info', 'Invalid echo');
        return ErrorCodes.IFH_0003;
      }
    }

    // --- answer
    const readMore = async (n: number, first: boolean) => {
      if (n <= 0) return new Uint8Array(0);
      return this.channel.read(n, first ? timeout : telEnd);
    };
    const parts: number[] = [...pending];
    const need = async (n: number) => {
      if (parts.length >= n) return true;
      const got = await readMore(n - parts.length, parts.length === 0);
      parts.push(...got);
      return parts.length >= n;
    };

    const [a0, a1] = this.awlen;
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
    this.lastRx = Date.now();
    const rx = new Uint8Array(parts);
    this.traffic('rx', rx);
    if (rx.length === 0) return ErrorCodes.IFH_0009;
    if (xor(rx) !== 0) return ErrorCodes.IFH_0010;
    return rx;
  }

  // ---- unsupported / trivial IFH functions for K-line DS2 cables
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

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
