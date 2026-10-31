// Android app (Capacitor): the WebView has no WebUSB and no file downloads.
// - navigator.usb is provided over the native UsbBridge plugin, shaped like WebUSB, so the same FTDI
//   driver (WebUsbFtdiChannel) runs in Chrome on Android and in the app. The plugin strips the FTDI
//   status bytes natively; this shim puts them back so the driver sees real FTDI packets.
// - "download" links are saved to Documents/E46Fanatics on the phone.
// In a browser none of this runs.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export interface NativeDev { deviceId: number; vendorId: number; productId: number; productName?: string; hasPermission: boolean }
export interface UsbBridge {
  list(): Promise<{ devices: NativeDev[] }>;
  requestPermission(o: { deviceId: number }): Promise<{ granted: boolean }>;
  open(o: { deviceId: number }): Promise<{ packetSize: number }>;
  control(o: { request: number; value: number; index: number }): Promise<void>;
  write(o: { data: string }): Promise<void>;
  close(): Promise<void>;
  addListener(ev: 'data', cb: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'attached' | 'detached', cb: (e: NativeDev) => void): Promise<PluginListenerHandle>;
}

export const isNativeApp = () => Capacitor.isNativePlatform();

const PACKET = 64;
const b64 = (u: Uint8Array) => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

class ShimDevice {
  opened = false;
  configuration: { interfaces: unknown[] } | null = null;
  vendorId: number;
  productId: number;
  productName?: string;
  private queue: number[] = [];
  private waiter: (() => void) | null = null;
  private sub: PluginListenerHandle | null = null;

  constructor(private bridge: UsbBridge, readonly info: NativeDev) {
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
  }

  async open() {
    await this.bridge.open({ deviceId: this.info.deviceId });
    this.sub = await this.bridge.addListener('data', (e) => {
      for (const b of unb64(e.data)) this.queue.push(b);
      const w = this.waiter;
      this.waiter = null;
      w?.();
    });
    this.opened = true;
  }
  async close() {
    this.opened = false;
    await this.sub?.remove();
    this.sub = null;
    const w = this.waiter;
    this.waiter = null;
    w?.();
    await this.bridge.close();
  }
  async selectConfiguration() {
    this.configuration = {
      interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
        { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: PACKET },
        { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: PACKET },
      ] } }],
    };
  }
  async claimInterface() {}
  async releaseInterface() {}
  async clearHalt() {}
  async controlTransferOut(s: { request: number; value: number; index: number }) {
    await this.bridge.control({ request: s.request, value: s.value, index: s.index });
    return { status: 'ok' };
  }
  async transferOut(_ep: number, data: Uint8Array) {
    await this.bridge.write({ data: b64(data) });
    return { status: 'ok' };
  }
  /** Like the chip: returns what arrived, or an empty status packet after a short wait. */
  async transferIn(_ep: number, len: number) {
    if (!this.opened) throw new Error('Cable closed');
    if (!this.queue.length)
      await new Promise<void>((r) => {
        const t = setTimeout(() => { this.waiter = null; r(); }, 30);
        this.waiter = () => { clearTimeout(t); r(); };
      });
    if (!this.opened) throw new Error('Cable closed');
    const maxData = Math.floor(len / PACKET) * (PACKET - 2);
    const data = this.queue.splice(0, maxData);
    const out: number[] = [];
    for (let i = 0; i < data.length || out.length === 0; i += PACKET - 2) out.push(0x01, 0x60, ...data.slice(i, i + PACKET - 2));
    return { status: 'ok', data: new DataView(new Uint8Array(out).buffer) };
  }
}

/** A WebUSB-shaped navigator.usb over the native bridge (exported for the tests). */
export function createUsbShim(bridge: UsbBridge) {
  const usb = new EventTarget() as EventTarget & Record<string, unknown>;
  const devices = new Map<number, ShimDevice>();
  const get = (d: NativeDev) => {
    let s = devices.get(d.deviceId);
    if (!s) devices.set(d.deviceId, (s = new ShimDevice(bridge, d)));
    return s;
  };
  usb.getDevices = async () => (await bridge.list()).devices.filter((d) => d.hasPermission).map(get);
  usb.requestDevice = async () => {
    const list = (await bridge.list()).devices;
    if (!list.length) throw new Error('No device selected: plug the cable in with the OTG adapter');
    const d = list[0];
    if (!(await bridge.requestPermission({ deviceId: d.deviceId })).granted) throw new Error('No device selected: Android did not allow the cable');
    return get({ ...d, hasPermission: true });
  };
  const fire = (type: string, d: NativeDev) => {
    const e = new Event(type) as Event & { device?: ShimDevice };
    e.device = get(d);
    usb.dispatchEvent(e);
    if (type === 'disconnect') devices.delete(d.deviceId);
  };
  void bridge.addListener('attached', (d) => fire('connect', d));
  void bridge.addListener('detached', (d) => fire('disconnect', d));
  return usb;
}

function installUsb() {
  Object.defineProperty(navigator, 'usb', { value: createUsbShim(registerPlugin<UsbBridge>('UsbBridge')), configurable: true });
}

/** <a download> does nothing in the WebView: write the file to Documents/E46Fanatics instead. */
function installDownloads() {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
    const name = this.download.replace(/[\\/:*?"<>|]/g, '_');
    void (async () => {
      try {
        const bytes = new Uint8Array(await (await fetch(this.href)).arrayBuffer());
        await Filesystem.writeFile({ path: `E46Fanatics/${name}`, data: b64(bytes), directory: Directory.Documents, recursive: true });
        toast(`Saved to Documents/E46Fanatics/${name}`);
      } catch (e) {
        toast(`Could not save ${name}: ${(e as Error).message ?? e}`);
      }
    })();
  };
}

function toast(text: string) {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = 'position:fixed;left:16px;right:16px;bottom:56px;z-index:9999;padding:12px 14px;border-radius:10px;background:#1d2229;color:#fff;border:1px solid #4290f6;font:14px system-ui;box-shadow:0 6px 20px #0008';
  document.body.append(d);
  setTimeout(() => d.remove(), 4000);
}

if (isNativeApp()) {
  installUsb();
  installDownloads();
}
