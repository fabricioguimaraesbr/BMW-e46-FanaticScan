// Simulated ELM327 adapter on the simulated E46: AT commands, "SEARCHING...", OBD-II answers of the engine.
// Only the engine's OBD-II is reachable, as with a real ELM327 on an E46.

import { QueuedChannel, SerialConfig, sleep } from '../transport/ByteChannel';
import type { SimEcu } from './SimChannel';

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export class SimElmChannel extends QueuedChannel {
  readonly name = 'ELM327 simulator';
  private open_ = false;
  private line = '';
  private echo = true;
  private spaces = true;
  private connected = false;
  /** ms before an answer, like a Bluetooth adapter on ISO 9141 */
  answerDelay = 40;
  state: 'connected' | 'unplugged' | 'reconnecting' = 'connected';
  onState: ((s: 'connected' | 'unplugged' | 'reconnecting') => void) | null = null;

  constructor(private ecus: SimEcu[], private ignitionOn = true) {
    super();
  }
  /** Simulator pill: switch the adapter off / on. */
  unplug() {
    this.open_ = false;
    this.state = 'unplugged';
    this.onState?.('unplugged');
  }
  async plug() {
    this.open_ = true;
    this.connected = false;
    this.state = 'connected';
    this.onState?.('connected');
  }
  get isOpen() {
    return this.open_;
  }
  async open(_cfg: SerialConfig) {
    this.open_ = true;
  }
  async close() {
    this.open_ = false;
  }
  async setSignals() {}

  private send(text: string) {
    this.onData(new TextEncoder().encode(text));
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Adapter disconnected');
    for (const c of new TextDecoder().decode(data)) {
      if (c !== '\r') {
        this.line += c;
        continue;
      }
      const cmd = this.line.trim().toUpperCase().replace(/\s+/g, '');
      this.line = '';
      await sleep(this.answerDelay);
      const reply = this.answer(cmd);
      this.send(`${this.echo ? cmd + '\r' : ''}${reply}\r\r>`);
    }
  }

  private answer(cmd: string): string {
    if (cmd.startsWith('AT')) {
      const a = cmd.slice(2);
      if (a === 'Z') {
        this.echo = true;
        this.connected = false;
        return '\r\rELM327 v1.5';
      }
      if (a === 'I') return 'ELM327 v1.5';
      if (a === 'E0') this.echo = false;
      if (a === 'S0') this.spaces = false;
      if (a === 'S1') this.spaces = true;
      if (a === 'DP') return this.connected ? 'AUTO, ISO 9141-2' : 'AUTO';
      if (a === 'DPN') return this.connected ? 'A3' : 'A0';
      return 'OK';
    }
    if (!/^([0-9A-F]{2})+$/.test(cmd)) return '?';
    const ecu = this.ecus.find((e) => e.handleObd);
    if (!this.ignitionOn || !ecu) return this.connected ? 'NO DATA' : 'SEARCHING...\rUNABLE TO CONNECT';
    const req = new Uint8Array(cmd.match(/../g)!.map((x) => parseInt(x, 16)));
    const msgs = ecu.handleObd!(req);
    const pre = this.connected ? '' : 'SEARCHING...\r';
    this.connected = true;
    if (!msgs?.length) return pre + 'NO DATA';
    return pre + msgs.map((m) => (this.spaces ? hex(m) : hex(m).replace(/ /g, ''))).join('\r');
  }
}
