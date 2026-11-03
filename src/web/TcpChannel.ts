// Wi-Fi OBD adapters in the Android app (native TcpSocket plugin): ELM327 Wi-Fi (192.168.0.10:35000) and
// Deep OBD Wi-Fi adapters with esp-link (192.168.4.1:23). The phone joins the adapter's Wi-Fi first.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { QueuedChannel, type SerialConfig } from '../core/transport/ByteChannel';
import { isNativeApp } from './nativeApp';
import type { CableState } from './WebSerialChannel';

interface TcpSocket {
  connect(o: { host: string; port: number; timeout?: number }): Promise<{ wifi: boolean }>;
  write(o: { data: string }): Promise<void>;
  close(): Promise<void>;
  addListener(ev: 'data', cb: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'closed', cb: () => void): Promise<PluginListenerHandle>;
}

const tcp = () => registerPlugin<TcpSocket>('TcpSocket');
export const wifiAvailable = () => isNativeApp();

/** Where Wi-Fi adapters listen: stock ELM327 first, then Deep OBD / esp-link. */
export const WIFI_ADAPTERS: { host: string; port: number }[] = [
  { host: '192.168.0.10', port: 35000 },
  { host: '192.168.4.1', port: 23 },
  { host: '192.168.4.1', port: 35000 },
];

export class TcpChannel extends QueuedChannel {
  private open_ = false;
  private subs: PluginListenerHandle[] = [];
  state: CableState = 'connected';
  onState: ((s: CableState) => void) | null = null;
  /** Wi-Fi links of some adapters drop 0x00 bytes: escape them (Deep OBD escape mode). */
  readonly wifi = true;

  private constructor(readonly host: string, readonly port: number) {
    super();
  }

  static async connect(host: string, port: number): Promise<TcpChannel> {
    const ch = new TcpChannel(host, port);
    const p = tcp();
    ch.subs.push(await p.addListener('data', (e) => ch.onData(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)))));
    ch.subs.push(await p.addListener('closed', () => ch.lost()));
    try {
      await p.connect({ host, port, timeout: 2500 });
    } catch (e) {
      for (const s of ch.subs) await s.remove();
      throw e;
    }
    ch.open_ = true;
    return ch;
  }

  /** Tries the usual adapter addresses. */
  static async find(log?: (s: string) => void): Promise<TcpChannel> {
    let last: unknown = null;
    for (const a of WIFI_ADAPTERS) {
      try {
        log?.(`Wi-Fi adapter: trying ${a.host}:${a.port}`);
        return await TcpChannel.connect(a.host, a.port);
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`no Wi-Fi OBD adapter found. Join the adapter's Wi-Fi (WiFi_OBDII or similar) in Android's settings and keep it connected even without internet. ${(last as Error)?.message ?? ''}`);
  }

  private lost() {
    if (!this.open_) return;
    this.open_ = false;
    this.state = 'unplugged';
    this.onState?.('unplugged');
  }

  get name() {
    return `ELM327 Wi-Fi (${this.host}:${this.port})`;
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
    await tcp().close().catch(() => undefined);
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Adapter disconnected');
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    await tcp().write({ data: btoa(s) });
  }
}
