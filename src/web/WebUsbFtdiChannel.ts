// WebUSB driver for the FTDI chip of the K+DCAN / BMW Scanner cable (Chrome on Android, phone with USB OTG).
//
// Chrome on Android has no Web Serial (Android has no serial-port API), but it has WebUSB, and Android
// does not bind a kernel driver to FTDI chips. So the app talks to the chip itself, the way Android
// diagnostic apps do: vendor control requests for the line settings, bulk endpoints for the data.
// Protocol as in the open FTDI drivers (libftdi, Linux ftdi_sio, usb-serial-for-android).
//
// On Windows/macOS/Linux the operating system already drives the FTDI chip, so WebUSB cannot claim it
// there: desktops keep using Web Serial (WebSerialChannel).

import { QueuedChannel, SerialConfig } from '../core/transport/ByteChannel';
import type { CableState } from './WebSerialChannel';

// Minimal WebUSB typings (lib.dom does not ship them)
interface UsbEndpoint { endpointNumber: number; direction: 'in' | 'out'; type: string; packetSize: number }
interface UsbInterface { interfaceNumber: number; alternate: { endpoints: UsbEndpoint[] } }
interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  productName?: string;
  opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  controlTransferOut(setup: { requestType: 'vendor'; recipient: 'device'; request: number; value: number; index: number }, data?: BufferSource): Promise<{ status: string }>;
  transferIn(ep: number, len: number): Promise<{ status: string; data?: DataView }>;
  transferOut(ep: number, data: Uint8Array): Promise<{ status: string }>;
  clearHalt(dir: 'in' | 'out', ep: number): Promise<void>;
}
interface UsbLike extends EventTarget {
  requestDevice(o: { filters: { vendorId?: number }[] }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
}

export const FTDI_VENDOR = 0x0403;
const usbApi = () => (navigator as unknown as { usb: UsbLike }).usb;

export function webUsbAvailable() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

// FTDI vendor requests
const SIO_RESET = 0;
const SIO_MODEM_CTRL = 1;
const SIO_SET_FLOW_CTRL = 2;
const SIO_SET_BAUDRATE = 3;
const SIO_SET_DATA = 4;
const SIO_SET_LATENCY_TIMER = 9;
const RESET_SIO = 0;
const PURGE_RX = 1;
const PURGE_TX = 2;

/**
 * Baud-rate divisor of the FT232R/FT232BM: 3 MHz base clock, divisor in eighths.
 * Returns [wValue, wIndex] (wIndex upper bits for a single-port chip).
 * 9600 → 0x4138, 10400 → 0x4120, 115200 → 0x001a.
 */
export function ftdiBaudDivisor(baud: number): [number, number] {
  const FRAC = [0, 3, 2, 4, 1, 5, 6, 7];
  let d8 = Math.round(24_000_000 / baud);
  if (d8 < 8) d8 = 8;
  if (d8 > 0x1ffff) d8 = 0x1ffff;
  let enc: number;
  if (d8 === 8) enc = 0; // 3 Mbaud
  else if (d8 === 12) enc = 1; // 2 Mbaud
  else enc = (d8 >> 3) | (FRAC[d8 & 7] << 14);
  return [enc & 0xffff, (enc >> 16) & 0xffff];
}

/** wValue of SIO_SET_DATA: data bits, parity, stop bits, break. */
export function ftdiLineValue(cfg: SerialConfig, brk: boolean) {
  const parity = cfg.parity === 'none' ? 0 : cfg.parity === 'odd' ? 1 : 2;
  const stop = cfg.stopBits === 2 ? 2 : 0;
  return cfg.dataBits | (parity << 8) | (stop << 11) | (brk ? 1 << 14 : 0);
}

/** Removes the 2 modem-status bytes the chip puts at the start of every USB packet. */
export function stripStatus(raw: Uint8Array, packetSize: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += packetSize) {
    const end = Math.min(i + packetSize, raw.length);
    for (let j = i + 2; j < end; j++) out.push(raw[j]);
  }
  return new Uint8Array(out);
}

export class WebUsbFtdiChannel extends QueuedChannel {
  private open_ = false;
  private claimed = false;
  private cfg: SerialConfig | null = null;
  private brk = false;
  private epIn = 1;
  private epOut = 2;
  private packetSize = 64;
  private iface = 0;
  private pump: Promise<void> | null = null;
  private stopPump = false;
  private disposed = false;
  state: CableState = 'connected';
  onState: ((s: CableState) => void) | null = null;

  constructor(private dev: UsbDeviceLike) {
    super();
    usbApi().addEventListener('disconnect', this.onUnplug);
    usbApi().addEventListener('connect', this.onPlug);
  }

  /** Asks the user to pick the cable (FTDI chips only). */
  static async request(): Promise<WebUsbFtdiChannel> {
    const dev = await usbApi().requestDevice({ filters: [{ vendorId: FTDI_VENDOR }] });
    return new WebUsbFtdiChannel(dev);
  }

  static async previouslyGranted(): Promise<WebUsbFtdiChannel | null> {
    if (!webUsbAvailable()) return null;
    const d = (await usbApi().getDevices()).find((x) => x.vendorId === FTDI_VENDOR);
    return d ? new WebUsbFtdiChannel(d) : null;
  }

  get name() {
    const pid = this.dev.productId.toString(16).padStart(4, '0');
    return `FTDI cable over USB (0403:${pid})`;
  }
  get isOpen() {
    return this.open_;
  }

  private setState(s: CableState) {
    this.state = s;
    this.onState?.(s);
  }

  private onUnplug = (e: Event) => {
    const d = (e as unknown as { device: UsbDeviceLike }).device;
    if (this.disposed || !isSameDevice(d, this.dev)) return;
    this.open_ = false;
    this.claimed = false;
    this.stopPump = true;
    this.setState('unplugged');
  };

  /** Cable plugged back in: Android hands out a new device object; reopen with the last settings. */
  private onPlug = async (e: Event) => {
    const d = (e as unknown as { device: UsbDeviceLike }).device;
    if (this.disposed || d.vendorId !== FTDI_VENDOR || !this.cfg) return;
    this.dev = d;
    this.setState('reconnecting');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.open(this.cfg);
        this.setState('connected');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.setState('unplugged');
  };

  dispose() {
    this.disposed = true;
    usbApi().removeEventListener('disconnect', this.onUnplug);
    usbApi().removeEventListener('connect', this.onPlug);
  }

  private ctrl(request: number, value: number, index = 0) {
    // single-port chips (FT232R/RL, the K+DCAN cables) take the port number 0 or 1 in wIndex; 1 = port A, as libftdi does
    return this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
  }

  private async claim() {
    if (!this.dev.opened) await this.dev.open();
    if (!this.dev.configuration) await this.dev.selectConfiguration(1);
    const ifc = this.dev.configuration!.interfaces[0];
    this.iface = ifc.interfaceNumber;
    for (const ep of ifc.alternate.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in') {
        this.epIn = ep.endpointNumber;
        this.packetSize = ep.packetSize || 64;
      } else this.epOut = ep.endpointNumber;
    }
    await this.dev.claimInterface(this.iface);
    this.claimed = true;
    await this.ctrl(SIO_RESET, RESET_SIO, 1);
    await this.ctrl(SIO_SET_FLOW_CTRL, 0, 1); // no flow control
    // 2 ms: answers come back quickly (the desktop default of 16 ms garbles DS2 timing)
    await this.ctrl(SIO_SET_LATENCY_TIMER, 2, 1);
    await this.ctrl(SIO_MODEM_CTRL, 0x0300, 1); // DTR and RTS low
  }

  private async applyLine(cfg: SerialConfig) {
    const [v, i] = ftdiBaudDivisor(cfg.baudRate);
    // single-port chip: wIndex carries the top divisor bit, not the port number (libftdi does the same)
    await this.ctrl(SIO_SET_BAUDRATE, v, i);
    await this.ctrl(SIO_SET_DATA, ftdiLineValue(cfg, this.brk), 1);
  }

  async open(cfg: SerialConfig) {
    this.cfg = cfg;
    this.brk = false;
    if (!this.claimed) await this.claim();
    await this.applyLine(cfg);
    await this.ctrl(SIO_RESET, PURGE_RX, 1);
    await this.ctrl(SIO_RESET, PURGE_TX, 1);
    this.discardInput();
    this.open_ = true;
    if (!this.pump) this.startPump();
  }

  private startPump() {
    this.stopPump = false;
    this.pump = (async () => {
      try {
        while (!this.stopPump) {
          const r = await this.dev.transferIn(this.epIn, this.packetSize * 4);
          if (r.status !== 'ok' || !r.data) {
            if (r.status === 'stall') await this.dev.clearHalt('in', this.epIn).catch(() => undefined);
            continue;
          }
          const raw = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          const data = stripStatus(raw, this.packetSize);
          if (data.length && this.open_) this.onData(data);
        }
      } catch {
        /* device closed or unplugged */
      } finally {
        this.pump = null;
      }
    })();
  }

  /** The chip changes baud/parity on the fly: no close/reopen needed (faster than Web Serial). */
  async reconfigure(cfg: SerialConfig) {
    if (!this.claimed) return this.open(cfg);
    this.cfg = cfg;
    this.brk = false;
    await this.applyLine(cfg);
    await this.ctrl(SIO_RESET, PURGE_RX, 1);
    this.discardInput();
    this.open_ = true;
  }

  async close() {
    this.open_ = false;
    this.stopPump = true;
    if (!this.claimed) return;
    this.claimed = false;
    try {
      await this.dev.releaseInterface(this.iface);
    } catch {
      /* ignore */
    }
    await this.dev.close().catch(() => undefined); // also ends a pending transferIn
    await this.pump;
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Cable unplugged');
    const r = await this.dev.transferOut(this.epOut, data);
    if (r.status !== 'ok') throw new Error(`USB write failed (${r.status})`);
  }

  async setSignals(s: { dtr?: boolean; rts?: boolean; brk?: boolean }) {
    if (s.dtr !== undefined) await this.ctrl(SIO_MODEM_CTRL, 0x0100 | (s.dtr ? 1 : 0), 1);
    if (s.rts !== undefined) await this.ctrl(SIO_MODEM_CTRL, 0x0200 | (s.rts ? 2 : 0), 1);
    if (s.brk !== undefined && this.cfg) {
      this.brk = s.brk;
      await this.ctrl(SIO_SET_DATA, ftdiLineValue(this.cfg, s.brk), 1);
    }
  }
}

function isSameDevice(a: UsbDeviceLike, b: UsbDeviceLike) {
  return a === b || (a.vendorId === b.vendorId && a.productId === b.productId && !b.opened);
}

/** Watches for a granted FTDI cable being plugged in or out (start screen indicator). */
export async function watchUsbCable(cb: (present: boolean, name: string) => void): Promise<() => void> {
  if (!webUsbAvailable()) return () => undefined;
  const check = async () => {
    const d = (await usbApi().getDevices()).find((x) => x.vendorId === FTDI_VENDOR);
    cb(!!d, d ? `FTDI cable over USB (0403:${d.productId.toString(16).padStart(4, '0')})` : '');
  };
  const handler = () => void check();
  usbApi().addEventListener('connect', handler);
  usbApi().addEventListener('disconnect', handler);
  await check();
  return () => {
    usbApi().removeEventListener('connect', handler);
    usbApi().removeEventListener('disconnect', handler);
  };
}
