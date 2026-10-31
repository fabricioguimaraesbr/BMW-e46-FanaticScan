// ELM327 adapters (Bluetooth, BLE, Wi-Fi bridges, USB): OBD-II only.
// The ELM327 speaks the standard OBD-II protocols through AT commands; it cannot send DS2, so on an E46 it
// reaches only the engine's generic OBD-II (P-codes, clearing, live data). Same request/answer shape as
// Iso9141, so Obd2 and NativeSession work on top of either.

import { sleep, type ByteChannel } from '../transport/ByteChannel';
import type { IsoMessage } from './iso9141';

/** What Obd2 needs from the line: the K-line itself (Iso9141) or an ELM327. */
export interface ObdTransport {
  readonly isReady: boolean;
  init(): Promise<boolean>;
  request(data: number[], quietMs?: number, until?: (msgs: IsoMessage[]) => boolean): Promise<IsoMessage[]>;
  release(): void;
  stopKeepAlive(): void;
}

export interface ElmOptions {
  onTraffic?: (dir: 'tx' | 'rx' | 'info', bytes: Uint8Array | string) => void;
  onLink?: (s: 'answer' | 'noanswer' | 'nocable') => void;
  /** USB / serial-port adapters: baud rates to try until the adapter answers (Bluetooth ignores the baud rate). */
  bauds?: number[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Hex lines of an answer → messages (header off: "41 0C 1A F8"; CAN multi-frame "0: …" prefixes dropped). */
export function parseElmAnswer(text: string): IsoMessage[] {
  const out: IsoMessage[] = [];
  for (let line of text.split(/[\r\n]+/)) {
    line = line.trim().replace(/^[0-9A-F]:\s*/i, '');
    if (!line || /SEARCHING|BUS INIT|NO DATA|ERROR|UNABLE|STOPPED|\?|ELM|OK$/i.test(line)) continue;
    const hex = line.replace(/\s+/g, '');
    if (!/^([0-9A-F]{2})+$/i.test(hex)) continue;
    const bytes = hex.match(/../g)!.map((x) => parseInt(x, 16));
    out.push({ ecu: 0x10, data: new Uint8Array(bytes) });
  }
  return out;
}

export class Elm327 implements ObdTransport {
  private ready = false;
  private busy: Promise<unknown> = Promise.resolve();
  /** "ELM327 v1.5" etc., from ATI */
  version = '';
  /** protocol the adapter found ("ISO 9141-2", …), from ATDP */
  protocol = '';

  constructor(
    private ch: ByteChannel,
    private opts: ElmOptions = {},
  ) {}

  get isReady() {
    return this.ready;
  }

  private info(s: string) {
    this.opts.onTraffic?.('info', s);
  }

  /** Sends one command line and returns everything up to the ">" prompt. */
  private async cmd(line: string, timeoutMs = 2000): Promise<string> {
    this.ch.discardInput();
    this.opts.onTraffic?.('tx', line);
    await this.ch.write(enc.encode(line + '\r'));
    let text = '';
    const t0 = Date.now();
    // byte by byte: stop at the ">" prompt instead of waiting for the read timeout
    while (Date.now() - t0 < timeoutMs) {
      const b = await this.ch.read(1, Math.max(1, timeoutMs - (Date.now() - t0)));
      if (!b.length) break;
      text += dec.decode(b);
      if (b[0] === 0x3e) break;
    }
    text = text.replace(/\0/g, '').replace('>', '').trim();
    if (text) this.opts.onTraffic?.('rx', text.replace(/\s*[\r\n]+\s*/g, ' | '));
    return text;
  }

  /** Resets the adapter and connects to the engine. Returns false when the adapter or the engine does not answer. */
  init(): Promise<boolean> {
    const p = this.busy.then(() => this.doInit(), () => this.doInit());
    this.busy = p.catch(() => undefined);
    return p;
  }

  private async doInit(): Promise<boolean> {
      this.ready = false;
      if (!this.ch.isOpen) {
        this.opts.onLink?.('nocable');
        return false;
      }
      this.info('ELM327: reset');
      let id = '';
      for (const baud of this.opts.bauds ?? [0]) {
        if (baud) {
          await this.ch.reconfigure({ baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1 });
          this.info(`ELM327: trying ${baud} baud`);
        }
        id = await this.cmd('ATZ', 3000);
        if (!/ELM|OBD|STN|v\d/i.test(id)) {
          await sleep(300);
          id = await this.cmd('ATZ', 3000);
        }
        if (/ELM|OBD|STN|v\d/i.test(id)) break;
      }
      if (!id) {
        this.info('ELM327: the adapter did not answer');
        this.opts.onLink?.('nocable');
        return false;
      }
      for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATAT1']) await this.cmd(c, 1500);
      this.version = (await this.cmd('ATI', 1500)).split(/[\r\n]/).find((l) => l.trim()) ?? '';
      // automatic protocol; the first request makes the adapter wake the engine (5-baud on an E46: several seconds)
      await this.cmd('ATSP0', 1500);
      const first = await this.cmd('0100', 15000);
      const ok = parseElmAnswer(first).some((m) => m.data[0] === 0x41 && m.data[1] === 0x00);
      this.protocol = ok ? (await this.cmd('ATDP', 1500)).replace(/^AUTO,\s*/i, '') : '';
      this.info(ok ? `ELM327: engine answered (${this.protocol})` : `ELM327: engine did not answer (${first.replace(/[\r\n]+/g, ' ') || 'no reply'})`);
      this.opts.onLink?.(ok ? 'answer' : 'noanswer');
      this.ready = ok;
      return ok;
  }

  request(data: number[], _quietMs = 120, _until?: (msgs: IsoMessage[]) => boolean): Promise<IsoMessage[]> {
    const run = async () => {
      if (!this.ready && !(await this.doInit())) return [];
      let text: string;
      try {
        // mode 04 can take a while on some engines
        text = await this.cmd(data.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), data[0] === 0x04 ? 5000 : 3000);
      } catch {
        this.ready = false;
        this.opts.onLink?.('nocable');
        return [];
      }
      const msgs = parseElmAnswer(text);
      if (/UNABLE TO CONNECT|BUS ERROR|CAN ERROR/i.test(text)) this.ready = false;
      this.opts.onLink?.(msgs.length ? 'answer' : this.ch.isOpen ? 'noanswer' : 'nocable');
      return msgs;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => undefined);
    return p;
  }

  /** The adapter keeps the engine session alive by itself. */
  release() {}
  stopKeepAlive() {}
}
