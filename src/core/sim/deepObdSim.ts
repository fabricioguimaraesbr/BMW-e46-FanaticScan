// Simulated ELM327 adapter with the Deep OBD firmware, plugged into the simulated E46 (SimChannel stands for the
// K-line). It is the raw Bluetooth stream the app sees: adapter requests, K-line telegrams with a settings header,
// 5-baud pulses with the automatic key byte answer, and no K-line echo.

import { QueuedChannel, sleep, type SerialConfig } from '../transport/ByteChannel';
import { sum8 } from '../transport/DeepObdChannel';
import type { SimChannel } from './SimChannel';

export class SimDeepObdAdapter extends QueuedChannel {
  readonly name = 'Deep OBD simulator';
  private open_ = true;
  private inBuf: number[] = [];
  private drop = 0;
  private kbWatch: { left: number; bytes: number[]; delay: number } | null = null;
  private busy: Promise<void> = Promise.resolve();
  version = 0x0010;
  voltage = 13.8;
  state: 'connected' | 'unplugged' | 'reconnecting' = 'connected';
  onState: ((s: 'connected' | 'unplugged' | 'reconnecting') => void) | null = null;

  constructor(readonly car: SimChannel) {
    super();
    void car.open({ baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 });
    void this.pump();
  }

  get isOpen() {
    return this.open_;
  }
  async open(_cfg: SerialConfig) {}
  async close() {
    this.open_ = false;
  }
  async setSignals() {}

  /** K-line → app, without the echo of what the adapter sent. */
  private async pump() {
    while (this.open_) {
      const b = await this.car.read(1, 500);
      if (!b.length) continue;
      if (this.drop > 0) {
        this.drop--;
        continue;
      }
      this.onData(b);
      const w = this.kbWatch;
      if (w) {
        w.bytes.push(b[0]);
        if (w.bytes.length === 3) {
          // auto key byte: answer ~KB2 after the delay, like the firmware
          this.kbWatch = null;
          const kb2 = w.bytes[2];
          setTimeout(() => {
            this.drop = 1;
            void this.car.write(new Uint8Array([~kb2 & 0xff]));
          }, w.delay);
        }
      }
    }
  }

  private cur = '';
  /** Changes the K-line settings only when they differ (a reconfigure ends the simulated ISO session). */
  private async line(cfg: SerialConfig) {
    const k = `${cfg.baudRate}/${cfg.parity}`;
    if (k === this.cur) return;
    this.cur = k;
    await this.car.reconfigure(cfg);
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Adapter disconnected');
    for (const b of data) this.inBuf.push(b);
    this.busy = this.busy.then(() => this.process());
    await this.busy;
  }

  private async process() {
    for (;;) {
      const b = this.inBuf;
      if (!b.length) return;
      if (b[0] === 0x82 && b.length >= 6 && b[1] === 0xf1 && b[2] === 0xf1) {
        const req = b.splice(0, 6);
        this.onData(new Uint8Array(req)); // adapter echo
        const kind = req[3];
        const ans =
          kind === 0xfd ? [0x86, 0xf1, 0xf1, 0xfd, 0x00, 0x02, this.version >> 8, this.version & 0xff] :
          kind === 0xfc ? [0x82, 0xf1, 0xf1, 0xfc, Math.round(this.voltage * 10)] :
          kind === 0xfe ? [0x82, 0xf1, 0xf1, 0xfe, 0x01] : null;
        if (ans) this.onData(new Uint8Array([...ans, sum8(ans)]));
        continue;
      }
      if (b[0] !== 0x00) {
        // raw BMW-FAST at 115200: echo and pass on
        const raw = b.splice(0, b.length);
        this.onData(new Uint8Array(raw));
        await this.line({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
        this.drop += raw.length;
        await this.car.write(new Uint8Array(raw));
        continue;
      }
      const tel2 = b[1] === 0x02;
      const head = tel2 ? 10 : 8;
      if (b.length < head) return;
      const len = (b[head - 2] << 8) | b[head - 1];
      if (b.length < head + len + 1) return;
      const t = b.splice(0, head + len + 1);
      if (sum8(t, t.length - 1) !== t[t.length - 1]) continue; // bad checksum: ignored by the firmware
      const baud = ((t[2] << 8) | t[3]) * 2;
      const f1 = t[4];
      const parity = (['none', 'even', 'odd'] as const)[f1 & 7] ?? 'none';
      const data = t.slice(head, head + len);
      await this.line({ baudRate: baud, dataBits: 8, parity, stopBits: 1 });
      if (f1 & 0x10) {
        // pulses: [width ms, bit count, bits…, auto key byte delay]
        const width = data[0];
        const count = data[1];
        let bits = 0;
        for (let i = 0; i < (count + 7) >> 3; i++) bits += data[2 + i] * 2 ** (8 * i);
        const delay = data[data.length - 1];
        const t0 = performance.now();
        for (let i = 0; i < count; i++) {
          await this.car.setSignals({ brk: Math.floor(bits / 2 ** i) % 2 === 0 });
          const wait = t0 + (i + 1) * width - performance.now();
          if (wait > 0) await sleep(wait);
        }
        await this.car.setSignals({ brk: false });
        if (delay) this.kbWatch = { left: 3, bytes: [], delay };
        continue;
      }
      this.drop += data.length; // K-line echo is not passed on (NO_ECHO)
      await this.car.write(new Uint8Array(data));
    }
  }
}
