// Web Serial (Chrome / Edge on macOS, Windows, Linux) — talks to the FTDI chip of the K+DCAN / BMW Scanner cable.

import { QueuedChannel, SerialConfig } from '../core/transport/ByteChannel';

// Minimal typings (lib.dom does not ship Web Serial yet)
interface SerialPortLike {
  open(o: { baudRate: number; parity?: string; dataBits?: number; stopBits?: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike extends EventTarget {
  requestPort(o?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

export type CableState = 'connected' | 'unplugged' | 'reconnecting';

const serialApi = () => (navigator as unknown as { serial: SerialLike }).serial;

/**
 * Watches USB serial ports the user already granted, before and after connecting.
 * Calls back with whether a cable (FTDI preferred) is currently plugged in.
 */
export async function watchCable(cb: (present: boolean, name: string) => void): Promise<() => void> {
  if (!webSerialAvailable()) return () => undefined;
  const check = async () => {
    const ports = await serialApi().getPorts();
    const p = ports.find((x) => x.getInfo().usbVendorId === FTDI_VENDOR) ?? ports[0];
    cb(!!p, p ? describePort(p) : '');
  };
  const handler = () => void check();
  serialApi().addEventListener('connect', handler);
  serialApi().addEventListener('disconnect', handler);
  await check();
  return () => {
    serialApi().removeEventListener('connect', handler);
    serialApi().removeEventListener('disconnect', handler);
  };
}

function describePort(p: SerialPortLike) {
  const i = p.getInfo();
  const vid = i.usbVendorId?.toString(16).padStart(4, '0');
  const pid = i.usbProductId?.toString(16).padStart(4, '0');
  return i.usbVendorId === FTDI_VENDOR ? `FTDI cable (${vid}:${pid})` : vid ? `USB serial ${vid}:${pid}` : 'Serial port';
}

export const FTDI_VENDOR = 0x0403;

export function webSerialAvailable() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class WebSerialChannel extends QueuedChannel {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pump: Promise<void> | null = null;
  private open_ = false;
  private lastCfg: SerialConfig | null = null;
  /** Physical state of the cable, updated from USB plug/unplug events. */
  state: CableState = 'connected';
  onState: ((s: CableState) => void) | null = null;
  private disposed = false;

  constructor(private port: SerialPortLike) {
    super();
    serialApi().addEventListener('disconnect', this.onUnplug);
    serialApi().addEventListener('connect', this.onPlug);
  }

  private setState(s: CableState) {
    this.state = s;
    this.onState?.(s);
  }

  private onUnplug = (e: Event) => {
    if ((e.target as unknown) !== this.port || this.disposed) return;
    this.open_ = false;
    this.reader?.cancel().catch(() => undefined);
    this.setState('unplugged');
  };

  /** Same cable plugged back in: reopen it with the last line settings. */
  private onPlug = async (e: Event) => {
    if ((e.target as unknown) !== this.port || this.disposed || !this.lastCfg) return;
    this.setState('reconnecting');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.port.close().catch(() => undefined);
        await this.open(this.lastCfg);
        this.setState('connected');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.setState('unplugged');
  };

  /** Stops watching USB events (on Disconnect). */
  dispose() {
    this.disposed = true;
    serialApi().removeEventListener('disconnect', this.onUnplug);
    serialApi().removeEventListener('connect', this.onPlug);
  }

  /** Asks the user to pick the cable (FTDI preferred, any serial allowed). */
  static async request(): Promise<WebSerialChannel> {
    const port = await serialApi().requestPort({});
    return new WebSerialChannel(port);
  }

  /** Re-uses a port the user already granted before (no prompt). */
  static async previouslyGranted(): Promise<WebSerialChannel | null> {
    if (!webSerialAvailable()) return null;
    const ports = await serialApi().getPorts();
    const ftdi = ports.find((p) => p.getInfo().usbVendorId === FTDI_VENDOR) ?? ports[0];
    return ftdi ? new WebSerialChannel(ftdi) : null;
  }

  get name() {
    return describePort(this.port);
  }
  get isOpen() {
    return this.open_;
  }

  async open(cfg: SerialConfig) {
    this.lastCfg = cfg;
    await this.port.open({ baudRate: cfg.baudRate, parity: cfg.parity, dataBits: cfg.dataBits, stopBits: cfg.stopBits, bufferSize: 4096 });
    this.open_ = true;
    this.reader = this.port.readable!.getReader();
    const reader = this.reader;
    this.pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.onData(value);
        }
      } catch {
        /* port closed or cable unplugged */
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async close() {
    if (!this.open_) {
      if (this.state === 'unplugged') await this.port.close().catch(() => undefined);
      return;
    }
    this.open_ = false;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    await this.pump;
    this.reader = null;
    await this.port.close();
  }

  async write(data: Uint8Array) {
    if (!this.open_ || !this.port.writable) throw new Error('Cable unplugged');
    const w = this.port.writable!.getWriter();
    try {
      await w.write(data);
    } finally {
      w.releaseLock();
    }
  }

  async setSignals(s: { dtr?: boolean; rts?: boolean; brk?: boolean }) {
    const sig: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean } = {};
    if (s.dtr !== undefined) sig.dataTerminalReady = s.dtr;
    if (s.rts !== undefined) sig.requestToSend = s.rts;
    if (s.brk !== undefined) sig.break = s.brk;
    await this.port.setSignals(sig);
  }
}
