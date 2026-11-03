// ELM327 adapters (PIC18F25K80) reflashed with the Deep OBD replacement firmware (EdiabasLib project,
// github.com/uholeschak/ediabaslib, GPLv3): the adapter puts each telegram on the K-line with the baud rate
// and parity given in a small header, so DS2 works over Bluetooth or BLE, like the K+DCAN cable.
// Telegram layouts from EdiabasLib's EdCustomAdapterCommon.cs (reimplemented here, same licence).
//
// DeepObdChannel wraps the raw Bluetooth stream and behaves like a cable: the line settings come from
// open()/reconfigure(), each write() is one telegram, and the K-line echo is never returned.

import { QueuedChannel, sleep, type ByteChannel, type SerialConfig } from './ByteChannel';

const KLINEF1_PARITY_NONE = 0x0;
const KLINEF1_PARITY_EVEN = 0x1;
const KLINEF1_PARITY_ODD = 0x2;
const KLINEF1_SEND_PULSE = 0x10;
const KLINEF1_NO_ECHO = 0x20;

export const sum8 = (b: ArrayLike<number>, n = b.length) => {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + b[i]) & 0xff;
  return s;
};

const parityFlags = (p: SerialConfig['parity']) => (p === 'even' ? KLINEF1_PARITY_EVEN : p === 'odd' ? KLINEF1_PARITY_ODD : KLINEF1_PARITY_NONE);

/** One K-line telegram: header, baud/2, flags, inter-byte time, length, data, sum. telType 2 from firmware 0.8 on. */
export function klineTelegram(cfg: SerialConfig, data: ArrayLike<number>, version: number, interByteMs = 0): Uint8Array {
  const tel2 = version >= 0x0008;
  const head = tel2 ? 10 : 8;
  const out = new Uint8Array(data.length + head + 1);
  const half = cfg.baudRate >> 1;
  out[0] = 0x00;
  out[1] = tel2 ? 0x02 : 0x00;
  out[2] = half >> 8;
  out[3] = half & 0xff;
  out[4] = KLINEF1_NO_ECHO | parityFlags(cfg.parity); // K-line only (no L-line); the adapter drops the K-line echo
  if (tel2) {
    out[5] = 0x00; // flags 2
    out[6] = interByteMs;
    out[7] = 60; // KWP1281 timeout (unused)
    out[8] = data.length >> 8;
    out[9] = data.length & 0xff;
  } else {
    out[5] = interByteMs;
    out[6] = data.length >> 8;
    out[7] = data.length & 0xff;
  }
  out.set(Array.from(data), head);
  out[out.length - 1] = sum8(out, out.length - 1);
  return out;
}

/** Slow init: `length` bits of `dataBits` (LSB first, 1 = idle) of `pulseMs` each; the adapter can answer the key byte itself. */
export function pulseTelegram(cfg: SerialConfig, dataBits: number, length: number, pulseMs: number, version: number, autoKeyByteDelayMs = 0): Uint8Array {
  const tel2 = version >= 0x0008;
  const head = tel2 ? 10 : 8;
  const nBytes = (length + 7) >> 3;
  const out = new Uint8Array(head + 2 + nBytes + 2);
  const half = cfg.baudRate >> 1;
  out[0] = 0x00;
  out[1] = tel2 ? 0x02 : 0x00;
  out[2] = half >> 8;
  out[3] = half & 0xff;
  out[4] = KLINEF1_SEND_PULSE | KLINEF1_NO_ECHO | parityFlags(cfg.parity);
  if (tel2) {
    out[5] = 0x00;
    out[6] = 0x00;
    out[7] = 60;
    out[8] = 0x00;
    out[9] = nBytes + 3;
  } else {
    out[5] = 0x00;
    out[6] = 0x00;
    out[7] = nBytes + 3;
  }
  out[head] = pulseMs;
  out[head + 1] = length;
  for (let i = 0; i < nBytes; i++) out[head + 2 + i] = (dataBits / 2 ** (8 * i)) & 0xff;
  out[out.length - 2] = autoKeyByteDelayMs;
  out[out.length - 1] = sum8(out, out.length - 1);
  return out;
}

/** Adapter requests (answered by the adapter itself, echoed first): [request, answer length]. */
export const ADAPTER_REQ = {
  ignition: [[0x82, 0xf1, 0xf1, 0xfe, 0xfe], 6],
  version: [[0x82, 0xf1, 0xf1, 0xfd, 0xfd], 9],
  voltage: [[0x82, 0xf1, 0xf1, 0xfc, 0xfc], 6],
} as const;

export interface DeepObdInfo {
  type: number;
  version: number; // 0x0010 = 0.16
  voltage?: number; // volts at the OBD socket
  ignition?: number;
}

export const versionText = (v: number) => `${v >> 8}.${v & 0xff}`;

/**
 * The Deep OBD adapter on top of a raw Bluetooth stream. Answers of the car come back without the K-line echo;
 * at 115200 baud (BMW-FAST) telegrams are sent raw and the adapter echoes them, which is removed here too.
 */
/** True while a Deep OBD (Bluetooth) adapter is connected: permanent writes stay on the cable. */
export const deepObdState = { connected: false };

export class DeepObdChannel extends QueuedChannel {
  private cfg: SerialConfig = { baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 };
  private dropEcho: number[] = [];
  private raw: ByteChannel;
  info: DeepObdInfo = { type: 0, version: 0 };
  /** Whole frames per write (ISO 9141 needs 5–20 ms between tester bytes: the adapter keeps that time). */
  readonly wholeFrames = true;

  private constructor(raw: ByteChannel) {
    super();
    this.raw = raw;
    // forward everything the adapter sends, minus the echo of raw (115200) telegrams
    const pump = async () => {
      while (this.raw.isOpen) {
        const b = await this.raw.read(1, 1000);
        if (!b.length) continue;
        if (this.dropEcho.length && b[0] === this.dropEcho[0]) {
          this.dropEcho.shift();
          continue;
        }
        this.dropEcho.length = 0;
        this.onData(b);
      }
    };
    void pump();
  }

  /** Asks the adapter for its firmware version: null when it is not a Deep OBD adapter (stock ELM327). */
  static async probe(raw: ByteChannel, log?: (s: string) => void): Promise<DeepObdChannel | null> {
    const info = await adapterRequest(raw, 'version', 1200);
    if (!info) return null;
    const ch = new DeepObdChannel(raw);
    deepObdState.connected = true;
    ch.info = { type: (info[4] << 8) | info[5], version: (info[6] << 8) | info[7] };
    if (ch.info.type < 2 || ch.info.version < 3) {
      log?.(`Deep OBD adapter firmware ${versionText(ch.info.version)} is too old: update it with the Deep OBD app`);
    }
    return ch;
  }

  /** Reads the battery voltage at the OBD socket (firmware with type ≥ 2). */
  async readVoltage(): Promise<number | undefined> {
    if (this.info.type < 2) return undefined;
    const r = await this.request('voltage');
    if (r) this.info.voltage = r[4] / 10;
    return this.info.voltage;
  }
  async readIgnition(): Promise<number | undefined> {
    const r = await this.request('ignition');
    if (r) this.info.ignition = r[4];
    return this.info.ignition;
  }

  /** Adapter request while the pump owns the raw stream: answered through the queue. */
  private async request(kind: keyof typeof ADAPTER_REQ): Promise<number[] | null> {
    const [req, len] = ADAPTER_REQ[kind];
    const tel = [...req, 0];
    tel[tel.length - 1] = sum8(tel, tel.length - 1);
    this.discardInput();
    this.dropEcho = [...tel];
    await this.raw.write(new Uint8Array(tel));
    const r = await this.read(len, 600);
    if (r.length < len || sum8(r, len - 1) !== r[len - 1]) return null;
    return Array.from(r);
  }

  get name() {
    return `Deep OBD adapter ${versionText(this.info.version)} (${this.raw.name.replace(/^ELM327\s*/, '')})`;
  }
  get isOpen() {
    return this.raw.isOpen;
  }
  get state() {
    return (this.raw as unknown as { state?: string }).state ?? 'connected';
  }
  set onState(cb: ((s: string) => void) | null) {
    (this.raw as unknown as { onState: ((s: string) => void) | null }).onState = cb;
  }

  async open(cfg: SerialConfig) {
    this.cfg = { ...cfg };
  }
  async reconfigure(cfg: SerialConfig) {
    this.cfg = { ...cfg };
    this.discardInput();
  }
  async close() {
    deepObdState.connected = false;
    await this.raw.close();
  }
  /** Break bit-banging is not possible over Bluetooth: the 5-baud wake-up goes through wake5Baud(). */
  async setSignals() {}

  async write(data: Uint8Array) {
    if (this.cfg.baudRate === 115200) {
      this.dropEcho = Array.from(data);
      await this.raw.write(data);
      return;
    }
    // ISO 9141 (10400 baud): 6 ms between tester bytes, as on the cable
    const ibt = this.cfg.baudRate === 10400 ? 6 : 0;
    await this.raw.write(klineTelegram(this.cfg, data, this.info.version, ibt));
  }

  /**
   * ISO 9141 5-baud wake-up of `addr` (start bit, 8 data bits, stop bit, 200 ms each). The adapter answers the
   * second key byte itself after `autoKeyByteDelayMs` (too fast for a Bluetooth round trip). Resolves after the pulses.
   */
  async wake5Baud(addr: number, autoKeyByteDelayMs = 30) {
    const bits = (addr << 1) | 0x200;
    this.discardInput();
    await this.raw.write(pulseTelegram(this.cfg, bits, 10, 200, this.info.version, autoKeyByteDelayMs));
    await sleep(10 * 200);
  }
}

/** Adapter request on the raw stream before the channel exists: echo, then the answer. */
async function adapterRequest(raw: ByteChannel, kind: keyof typeof ADAPTER_REQ, timeoutMs: number): Promise<number[] | null> {
  const [req, len] = ADAPTER_REQ[kind];
  const tel = [...req, 0];
  tel[tel.length - 1] = sum8(tel, tel.length - 1);
  raw.discardInput();
  await raw.write(new Uint8Array(tel));
  const r = await raw.read(tel.length + len, timeoutMs);
  if (r.length < tel.length + len) return null;
  for (let i = 0; i < tel.length; i++) if (r[i] !== tel[i]) return null;
  const ans = Array.from(r.slice(tel.length, tel.length + len));
  return sum8(ans, len - 1) === ans[len - 1] ? ans : null;
}
