// Byte-level K-line simulator: behaves like an FTDI cable plugged into a car.
// Every byte written is echoed (single-wire K-line), then the addressed ECU answers with a DS2 telegram.

import { QueuedChannel, SerialConfig, sleep } from '../transport/ByteChannel';
import { sum8, xor } from '../transport/ObdInterface';

export interface SimEcu {
  address: number;
  name: string;
  /** Payload of the answer (starting with status byte 0xA0 etc.), or null for no answer. */
  handle(data: Uint8Array): number[] | null;
  /** OBD-II (ISO 9141-2) service request (service id + data) → answer messages (service id + 0x40 …), or null. */
  handleObd?(req: Uint8Array): number[][] | null;
  /** KWP modules (MS45, ME9, MRS5): service request → response payload, or null for no answer. Several payloads
   * are sent one after the other (a "response pending" 7F xx 78 followed by the answer). */
  handleKwp?(req: Uint8Array): number[] | number[][] | null;
  /** Which KWP framing the module answers: KWP2000* on 9600 8E1 or BMW-FAST on 115200 8N1. */
  protocol?: 'kwp2000s' | 'bmwfast';
}

const isoSum = (b: number[]) => b.reduce((a, x) => a + x, 0) & 0xff;
/** Expected request length (bytes after the 3 header bytes, without checksum) per OBD service. */
const isoReqLen: Record<number, number> = { 0x01: 2, 0x02: 3, 0x03: 1, 0x04: 1, 0x07: 1, 0x09: 2 };

export class SimChannel extends QueuedChannel {
  readonly name = 'E46 simulator';
  private open_ = false;
  private cfg: SerialConfig | null = null;
  private ecus = new Map<number, SimEcu>();
  /** ms per byte at 9600 8E1 ≈ 1.15 ms; scaled down to keep demos snappy. */
  byteTime = 0.2;
  answerDelay = 15;

  constructor(ecus: SimEcu[], readonly echo = true) {
    super();
    for (const e of ecus) this.ecus.set(e.address, e);
  }

  /** Simulated cable state: unplug()/plug() behave like pulling the USB cable. */
  state: 'connected' | 'unplugged' | 'reconnecting' = 'connected';
  onState: ((s: 'connected' | 'unplugged' | 'reconnecting') => void) | null = null;
  private cfgBeforeUnplug: SerialConfig | null = null;
  unplug() {
    this.cfgBeforeUnplug = this.cfg;
    this.open_ = false;
    this.state = 'unplugged';
    this.onState?.('unplugged');
  }
  async plug() {
    this.state = 'reconnecting';
    this.onState?.('reconnecting');
    await new Promise((r) => setTimeout(r, 300));
    if (this.cfgBeforeUnplug) await this.open(this.cfgBeforeUnplug);
    this.state = 'connected';
    this.onState?.('connected');
  }

  get isOpen() {
    return this.open_;
  }
  async open(cfg: SerialConfig) {
    this.cfg = cfg;
    this.open_ = true;
  }
  async close() {
    this.open_ = false;
    if (this.cfg?.baudRate === 10400) this.iso = 'idle';
  }
  // ------------------------------------------------------------ ISO 9141-2 (OBD-II) emulation
  private iso: 'idle' | 'waitKb' | 'ready' = 'idle';
  private brkEdges: { t: number; brk: boolean }[] = [];
  private brkTimer: ReturnType<typeof setTimeout> | null = null;
  private isoBuf: number[] = [];
  private isoLast = 0;
  /** 5-baud wake-up: decode the address from the break timing (200 ms per bit). */
  async setSignals(s: { dtr?: boolean; rts?: boolean; brk?: boolean }) {
    if (s.brk === undefined || this.cfg?.baudRate !== 10400) return;
    const last = this.brkEdges[this.brkEdges.length - 1];
    if (!last || last.brk !== s.brk) this.brkEdges.push({ t: performance.now(), brk: s.brk });
    if (this.brkTimer) clearTimeout(this.brkTimer);
    this.brkTimer = setTimeout(() => this.finishWakeup(), 260);
  }
  private finishWakeup() {
    const e = this.brkEdges;
    this.brkEdges = [];
    const start = e.findIndex((x) => x.brk);
    if (start < 0) return;
    const bits: number[] = [];
    for (let i = start; i < e.length - 1; i++) {
      const n = Math.round((e[i + 1].t - e[i].t) / 200);
      for (let k = 0; k < n; k++) bits.push(e[i].brk ? 0 : 1);
    }
    // bits[0] start, bits[1..8] data LSB first (trailing 1s after the last edge are the stop bit / idle)
    while (bits.length < 9) bits.push(1);
    let addr = 0;
    for (let i = 0; i < 8; i++) addr |= bits[1 + i] << i;
    const obd = [...this.ecus.values()].find((x) => x.handleObd);
    if (addr !== 0x33 || !obd || !this.open_) return;
    this.iso = 'waitKb';
    setTimeout(() => this.open_ && this.onData(new Uint8Array([0x55])), 80);
    setTimeout(() => this.open_ && this.onData(new Uint8Array([0x08, 0x08])), 95);
  }
  private isoWrite(data: Uint8Array) {
    for (const b of data) {
      if (this.iso === 'waitKb') {
        if (b === (~0x08 & 0xff)) {
          this.iso = 'ready';
          this.isoLast = Date.now();
          setTimeout(() => this.open_ && this.onData(new Uint8Array([~0x33 & 0xff])), 30);
        }
        continue;
      }
      if (this.iso !== 'ready') continue;
      if (Date.now() - this.isoLast > 5000) {
        this.iso = 'idle'; // P3 max exceeded: session lost
        return;
      }
      this.isoBuf.push(b);
      const buf = this.isoBuf;
      if (buf.length >= 4 && buf[0] === 0x68 && buf[1] === 0x6a && buf[2] === 0xf1) {
        const need = 3 + (isoReqLen[buf[3]] ?? 1) + 1;
        if (buf.length >= need) {
          this.isoBuf = [];
          if (isoSum(buf.slice(0, need - 1)) !== buf[need - 1]) continue;
          this.isoLast = Date.now();
          const ecu = [...this.ecus.values()].find((x) => x.handleObd)!;
          const msgs = ecu.handleObd!(new Uint8Array(buf.slice(3, need - 1)));
          if (!msgs) continue;
          const out: number[] = [];
          for (const m of msgs) {
            const tel = [0x48, 0x6b, 0x12, ...m];
            tel.push(isoSum(tel));
            out.push(...tel);
          }
          setTimeout(() => {
            if (this.open_) this.onData(new Uint8Array(out));
            this.isoLast = Date.now();
          }, 30);
        }
      } else if (buf.length >= 3 && !(buf[0] === 0x68 && buf[1] === 0x6a)) this.isoBuf = [];
    }
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Cable unplugged');
    if (this.echo) this.onData(data.slice());
    if (this.cfg?.baudRate === 10400 && this.cfg.parity === 'none') return this.isoWrite(data);
    if (this.cfg?.baudRate === 115200 && this.cfg.parity === 'none') return this.fastWrite(data);
    if (this.cfg?.baudRate !== 9600 || this.cfg.parity !== 'even') return; // wrong line settings: garbage, no answer
    // KWP2000*: B8 <target> <source> <len> data... xor
    if (data.length >= 5 && data[0] === 0xb8 && data[3] + 5 === data.length && xor(data) === 0) return this.kwpWrite(data);
    // DS2 telegram: addr, len, data..., xor
    if (data.length < 3 || data[1] !== data.length || xor(data) !== 0) return;
    const ecu = this.ecus.get(data[0]);
    if (!ecu) return;
    const payload = ecu.handle(data.subarray(2, data.length - 1));
    if (!payload) return;
    const tel = [ecu.address, payload.length + 3, ...payload];
    tel.push(xor(tel));
    await sleep(this.answerDelay + tel.length * this.byteTime);
    if (this.open_) this.onData(new Uint8Array(tel));
  }

  private async kwpWrite(data: Uint8Array) {
    const ecu = this.ecus.get(data[1]);
    if (!ecu?.handleKwp || ecu.protocol !== 'kwp2000s') return;
    const ans = ecu.handleKwp(data.subarray(4, data.length - 1));
    for (const body of frames(ans)) {
      const tel = [0xb8, data[2], data[1], body.length, ...body];
      tel.push(xor(tel));
      await sleep(this.answerDelay + tel.length * this.byteTime);
      if (this.open_) this.onData(new Uint8Array(tel));
    }
  }

  /** BMW-FAST: <0x80|len> <target> <source> data... sum (long form: 0x80 tgt src len data... sum). */
  private async fastWrite(data: Uint8Array) {
    if (data.length < 4 || (data[0] & 0xc0) !== 0x80 || sum8(data.subarray(0, data.length - 1)) !== data[data.length - 1]) return;
    const short = data[0] & 0x3f;
    const body = short ? data.subarray(3, 3 + short) : data.subarray(4, 4 + data[3]);
    const ecu = this.ecus.get(data[1]);
    if (!ecu?.handleKwp || ecu.protocol !== 'bmwfast') return;
    for (const ans of frames(ecu.handleKwp(body))) {
      const tel = ans.length < 64 ? [0x80 | ans.length, data[2], data[1], ...ans] : [0x80, data[2], data[1], ans.length, ...ans];
      tel.push(sum8(tel));
      await sleep(this.answerDelay + tel.length * this.byteTime * 0.1);
      if (this.open_) this.onData(new Uint8Array(tel));
    }
  }
}

const frames = (a: number[] | number[][] | null): number[][] => (!a ? [] : Array.isArray(a[0]) ? (a as number[][]) : [a as number[]]);
