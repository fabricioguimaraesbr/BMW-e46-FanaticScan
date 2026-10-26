// ISO 9141-2 (OBD-II on the K-line) over a plain FTDI cable.
// Wake-up: address 0x33 sent at 5 baud by toggling the TX break signal (FTDI cannot run at 5 baud).
// Then 10400 baud 8N1: sync 0x55, key bytes, inverted KB2 from the tester, inverted address from the ECU.
// Messages have no length byte: requests are 68 6A F1 <data> <sum>, answers 48 6B <ecu> <data> <sum>.

import { ByteChannel, sleep } from '../transport/ByteChannel';

export const ISO_LINE = { baudRate: 10400, parity: 'none', dataBits: 8, stopBits: 1 } as const;

export interface IsoMessage {
  ecu: number; // source address (0x10/0x12 = engine)
  data: Uint8Array; // service id + payload (e.g. 41 0C 1A F8)
}

export interface IsoOptions {
  onTraffic?: (dir: 'tx' | 'rx' | 'info', bytes: Uint8Array | string) => void;
  onLink?: (s: 'answer' | 'noanswer' | 'nocable') => void;
}

const sum = (b: ArrayLike<number>, n = b.length) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += b[i];
  return s & 0xff;
};

export class Iso9141 {
  private ready = false;
  private lastRx = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  keyBytes: [number, number] | null = null;

  constructor(
    private ch: ByteChannel,
    private opts: IsoOptions = {},
  ) {}

  get isReady() {
    return this.ready;
  }

  private info(s: string) {
    this.opts.onTraffic?.('info', s);
  }

  /** 5-baud initialisation. Returns false when no OBD engine answers. */
  async init(): Promise<boolean> {
    this.stopKeepAlive();
    this.ready = false;
    if (!this.ch.isOpen) {
      this.opts.onLink?.('nocable');
      return false;
    }
    await this.ch.reconfigure({ ...ISO_LINE });
    await this.ch.setSignals({ brk: false });
    await sleep(350); // bus idle before wake-up (W0 / P3)
    this.info('OBD-II: 5-baud wake-up of address 0x33');
    // start bit (0), 8 data bits LSB first, stop bit (1); 200 ms per bit, scheduled on absolute time to avoid drift
    const addr = 0x33;
    const bits = [0, ...Array.from({ length: 8 }, (_, i) => (addr >> i) & 1), 1];
    const t0 = performance.now();
    for (let i = 0; i < bits.length; i++) {
      await this.ch.setSignals({ brk: bits[i] === 0 });
      const wait = t0 + (i + 1) * 200 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    await this.ch.setSignals({ brk: false });
    this.ch.discardInput(); // break echo shows up as junk 0x00 bytes
    // sync byte within W1 (60-300 ms) — allow USB latency
    const sync = await this.readSkippingZeros(1, 600);
    if (sync[0] !== 0x55) {
      this.info(sync.length ? `OBD-II: unexpected sync byte ${sync[0].toString(16)}` : 'OBD-II: no answer to wake-up');
      this.opts.onLink?.('noanswer');
      return false;
    }
    const kb = await this.ch.read(2, 200);
    if (kb.length < 2) {
      this.opts.onLink?.('noanswer');
      return false;
    }
    this.keyBytes = [kb[0], kb[1]];
    await sleep(30); // W4: 25-50 ms
    await this.writeEcho(new Uint8Array([~kb[1] & 0xff]));
    const inv = await this.ch.read(1, 200);
    if (inv[0] !== (~addr & 0xff)) {
      this.info('OBD-II: engine did not confirm the wake-up');
      this.opts.onLink?.('noanswer');
      return false;
    }
    this.info(`OBD-II: connected (key bytes ${kb[0].toString(16)} ${kb[1].toString(16)})`);
    this.ready = true;
    this.lastRx = Date.now();
    this.opts.onLink?.('answer');
    this.startKeepAlive();
    return true;
  }

  private async readSkippingZeros(n: number, timeout: number) {
    const end = Date.now() + timeout;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return new Uint8Array(0);
      const b = await this.ch.read(1, left);
      if (!b.length) return b;
      if (b[0] !== 0x00) return n === 1 ? b : new Uint8Array([b[0], ...(await this.ch.read(n - 1, 200))]);
    }
  }

  /** Tester bytes need 5-20 ms between them (P4); the K-line echoes every byte. */
  private async writeEcho(bytes: Uint8Array) {
    this.opts.onTraffic?.('tx', bytes);
    for (const b of bytes) {
      await this.ch.write(new Uint8Array([b]));
      await this.ch.read(1, 60); // echo
      await sleep(6);
    }
  }

  /** Sends one request and returns every answer (several ECUs may answer). Serialized. */
  /** `until`: stop waiting as soon as the expected answer is complete (single ECU). */
  request(data: number[], quietMs = 120, until?: (msgs: IsoMessage[]) => boolean): Promise<IsoMessage[]> {
    const run = async () => {
      if (!this.ready && !(await this.init())) return [];
      const wait = this.lastRx + 60 - Date.now(); // P3 min 55 ms
      if (wait > 0) await sleep(wait);
      const frame = [0x68, 0x6a, 0xf1, ...data];
      frame.push(sum(frame));
      this.ch.discardInput();
      try {
        await this.writeEcho(new Uint8Array(frame));
      } catch {
        this.ready = false;
        this.opts.onLink?.('nocable');
        return [];
      }
      // collect until the line is quiet; P2 max is 50 ms, plus USB latency
      const bytes: number[] = [];
      const first = await this.ch.read(1, 400);
      if (first.length) {
        bytes.push(first[0]);
        for (;;) {
          if (until && until(splitMessages(bytes))) break;
          const more = await this.ch.read(1, quietMs);
          if (!more.length) break;
          bytes.push(more[0]);
        }
      }
      this.lastRx = Date.now();
      if (!bytes.length) {
        this.opts.onLink?.(this.ch.isOpen ? 'noanswer' : 'nocable');
        if (!this.ch.isOpen) this.ready = false;
        return [];
      }
      this.opts.onTraffic?.('rx', new Uint8Array(bytes));
      this.opts.onLink?.('answer');
      return splitMessages(bytes);
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => undefined);
    return p;
  }

  /** P3 max is 5 s: keep the session alive with "supported PIDs" requests. */
  private startKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      if (this.ready && Date.now() - this.lastRx > 3500) void this.request([0x01, 0x00]);
    }, 1000);
  }
  stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
  /** Another protocol is going to use the line (DS2): the OBD session will need a new wake-up. */
  release() {
    this.stopKeepAlive();
    this.ready = false;
  }
}

/** Splits the received stream into 48 6B xx … cs messages using the checksum (no length byte in ISO 9141). */
export function splitMessages(b: number[]): IsoMessage[] {
  const out: IsoMessage[] = [];
  let i = 0;
  while (i + 4 < b.length + 1) {
    if (b[i] !== 0x48 || b[i + 1] !== 0x6b) {
      i++;
      continue;
    }
    let found = -1;
    for (let j = i + 4; j < b.length; j++) {
      if (sum(b.slice(i, j)) === b[j] && (j + 1 === b.length || (b[j + 1] === 0x48 && b[j + 2] === 0x6b))) {
        found = j;
        break;
      }
    }
    if (found < 0) break;
    out.push({ ecu: b[i + 2], data: new Uint8Array(b.slice(i + 3, found)) });
    i = found + 1;
  }
  return out;
}
