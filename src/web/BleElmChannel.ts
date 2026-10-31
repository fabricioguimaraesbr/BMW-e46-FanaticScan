// Bluetooth Low Energy ELM327 adapters (Vgate iCar BLE, vLinker, "IOS-Vlink" clones…): a serial-like stream
// over a notify characteristic (adapter → app) and a write characteristic (app → adapter).
// Uses the Capacitor BLE plugin: Web Bluetooth in Chrome (desktop and Android), native Bluetooth in the app.
// Classic Bluetooth adapters (most cheap "ELM327 v1.5") are not BLE: see BtClassicChannel (Android app) or a
// paired serial port on the computer.

import { BleClient, numberToUUID, type BleService } from '@capacitor-community/bluetooth-le';
import { QueuedChannel, type SerialConfig } from '../core/transport/ByteChannel';
import type { CableState } from './WebSerialChannel';

/** Service / characteristic layouts used by BLE OBD adapters: [service, notify, write]. */
const KNOWN: [string, string, string][] = [
  [numberToUUID(0xfff0), numberToUUID(0xfff1), numberToUUID(0xfff2)],
  [numberToUUID(0xffe0), numberToUUID(0xffe1), numberToUUID(0xffe1)],
  [numberToUUID(0x18f0), numberToUUID(0x2af0), numberToUUID(0x2af1)],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
];
const OPTIONAL = [...new Set(KNOWN.map((k) => k[0]))];

/** Picks the notify/write pair: a known layout first, else any service with a notify and a write characteristic. */
export function pickUart(services: BleService[]): { service: string; notify: string; write: string; noResponse: boolean } | null {
  const lc = (u: string) => u.toLowerCase();
  for (const [sv, n, w] of KNOWN) {
    const s = services.find((x) => lc(x.uuid) === sv);
    const nc = s?.characteristics.find((c) => lc(c.uuid) === n && (c.properties.notify || c.properties.indicate));
    const wc = s?.characteristics.find((c) => lc(c.uuid) === w && (c.properties.write || c.properties.writeWithoutResponse));
    if (s && nc && wc) return { service: s.uuid, notify: nc.uuid, write: wc.uuid, noResponse: !wc.properties.write };
  }
  for (const s of services) {
    if (/^0000180[01a]-/.test(lc(s.uuid))) continue; // generic access / attribute / device information
    const nc = s.characteristics.find((c) => c.properties.notify || c.properties.indicate);
    const wc = s.characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (nc && wc) return { service: s.uuid, notify: nc.uuid, write: wc.uuid, noResponse: !wc.properties.write };
  }
  return null;
}

let initialized = false;
async function init() {
  if (initialized) return;
  await BleClient.initialize({ androidNeverForLocation: true });
  initialized = true;
}

export function bleAvailable() {
  // the app has native Bluetooth; Chrome has Web Bluetooth
  return typeof navigator !== 'undefined' && ('bluetooth' in navigator || !!(globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
}

export class BleElmChannel extends QueuedChannel {
  private open_ = true;
  state: CableState = 'connected';
  onState: ((s: CableState) => void) | null = null;

  private constructor(
    private deviceId: string,
    private deviceName: string,
    private uart: { service: string; notify: string; write: string; noResponse: boolean },
  ) {
    super();
  }

  /** Lets the user pick the adapter, connects and subscribes to its data. */
  static async request(): Promise<BleElmChannel> {
    await init();
    if (!(await BleClient.isEnabled().catch(() => true))) await BleClient.requestEnable().catch(() => undefined);
    const dev = await BleClient.requestDevice({ optionalServices: OPTIONAL });
    let ch: BleElmChannel | null = null;
    await BleClient.connect(dev.deviceId, () => ch?.lost());
    const uart = pickUart(await BleClient.getServices(dev.deviceId));
    if (!uart) {
      await BleClient.disconnect(dev.deviceId).catch(() => undefined);
      throw new Error('This Bluetooth device is not an OBD adapter (no data channel found)');
    }
    ch = new BleElmChannel(dev.deviceId, dev.name ?? 'adapter', uart);
    await BleClient.startNotifications(dev.deviceId, uart.service, uart.notify, (v) => ch!.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
    return ch;
  }

  private lost() {
    if (!this.open_) return;
    this.open_ = false;
    this.state = 'unplugged';
    this.onState?.('unplugged');
  }

  get name() {
    return `ELM327 Bluetooth LE (${this.deviceName})`;
  }
  get isOpen() {
    return this.open_;
  }
  async open(_cfg: SerialConfig) {}
  async reconfigure(_cfg: SerialConfig) {}
  async setSignals() {}

  async close() {
    if (!this.open_) return;
    this.open_ = false;
    await BleClient.stopNotifications(this.deviceId, this.uart.service, this.uart.notify).catch(() => undefined);
    await BleClient.disconnect(this.deviceId).catch(() => undefined);
  }

  async write(data: Uint8Array) {
    if (!this.open_) throw new Error('Adapter disconnected');
    // 20 bytes per write: the smallest BLE packet every adapter accepts
    for (let i = 0; i < data.length; i += 20) {
      const part = data.slice(i, i + 20);
      const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
      if (this.uart.noResponse) await BleClient.writeWithoutResponse(this.deviceId, this.uart.service, this.uart.write, dv);
      else await BleClient.write(this.deviceId, this.uart.service, this.uart.write, dv);
    }
  }
}
