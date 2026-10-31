// Classic Bluetooth ELM327 adapters in the Android app (native BtSerial plugin): the adapter is paired in
// Android's Bluetooth settings, then picked from the list of paired devices.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { QueuedChannel, type SerialConfig } from '../core/transport/ByteChannel';
import { isNativeApp } from './nativeApp';
import type { CableState } from './WebSerialChannel';

export interface PairedDevice { name: string; address: string; type: number }
interface BtSerial {
  listPaired(): Promise<{ devices: PairedDevice[] }>;
  connect(o: { address: string }): Promise<void>;
  write(o: { data: string }): Promise<void>;
  close(): Promise<void>;
  addListener(ev: 'data', cb: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'closed', cb: () => void): Promise<PluginListenerHandle>;
}

const bt = () => registerPlugin<BtSerial>('BtSerial');
export const btClassicAvailable = () => isNativeApp();

/** Paired devices, OBD-looking names first. */
export async function pairedAdapters(): Promise<PairedDevice[]> {
  const { devices } = await bt().listPaired();
  const obd = (d: PairedDevice) => /obd|elm|v-?link|vgate|icar|konnwei|scan|car/i.test(d.name);
  return devices.filter((d) => d.type !== 2).sort((a, b) => Number(obd(b)) - Number(obd(a)) || a.name.localeCompare(b.name));
}

export class BtClassicChannel extends QueuedChannel {
  private open_ = false;
  private subs: PluginListenerHandle[] = [];
  state: CableState = 'connected';
  onState: ((s: CableState) => void) | null = null;

  private constructor(private dev: PairedDevice) {
    super();
  }

  static async connect(dev: PairedDevice): Promise<BtClassicChannel> {
    const ch = new BtClassicChannel(dev);
    const p = bt();
    ch.subs.push(await p.addListener('data', (e) => ch.onData(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)))));
    ch.subs.push(await p.addListener('closed', () => ch.lost()));
    try {
      await p.connect({ address: dev.address });
    } catch (e) {
      for (const s of ch.subs) await s.remove();
      throw e;
    }
    ch.open_ = true;
    return ch;
  }

  private lost() {
    if (!this.open_) return;
    this.open_ = false;
    this.state = 'unplugged';
    this.onState?.('unplugged');
  }

  get name() {
    return `ELM327 Bluetooth (${this.dev.name})`;
  }
  get isOpen() {
    return this.open_;
  }
  async open(_cfg: SerialConfig) {}
  async reconfigure(_cfg: SerialConfig) {}
  async setSignals() {}

  async close() {
    this.open_ = false;
    for (const s of this.subs) await s.remove().catch(() => undefined);
    this.subs = [];
    await bt().close().catch(() => undefined);
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Adapter disconnected');
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    await bt().write({ data: btoa(s) });
  }
}
