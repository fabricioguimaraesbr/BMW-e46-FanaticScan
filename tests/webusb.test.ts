// WebUSB FTDI driver (Chrome on Android): the divisor and status-byte helpers, and the whole
// plug-and-play session running through a fake FTDI chip in front of the simulated E46.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSession, ENGINE_VARIANT } from '../src/core/native/NativeSession';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import type { SerialConfig } from '../src/core/transport/ByteChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { WebUsbFtdiChannel, ftdiBaudDivisor, ftdiLineValue, stripStatus } from '../src/web/WebUsbFtdiChannel';

/** Inverse of the FT232R divisor, the way the chip reads wValue/wIndex. */
function chipBaud(value: number, index: number) {
  const inv = [0, 4, 2, 1, 3, 5, 6, 7]; // frac code → eighths
  const code = ((value >> 14) & 3) | ((index & 1) << 2);
  const int = value & 0x3fff;
  if (int === 0 && code === 0) return 3_000_000;
  if (int === 1 && code === 0) return 2_000_000;
  return 24_000_000 / (int * 8 + inv[code]);
}

describe('FTDI helpers', () => {
  it('encodes the baud divisor like the open FTDI drivers', () => {
    expect(ftdiBaudDivisor(9600)).toEqual([0x4138, 0]);
    expect(ftdiBaudDivisor(115200)).toEqual([0x001a, 0]);
    for (const b of [9600, 10400, 115200]) {
      const [v, i] = ftdiBaudDivisor(b);
      expect(Math.abs(chipBaud(v, i) - b) / b).toBeLessThan(0.01);
    }
  });
  it('encodes 8E1, 8N1 and break', () => {
    expect(ftdiLineValue({ baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 }, false)).toBe(0x0208);
    expect(ftdiLineValue({ baudRate: 10400, dataBits: 8, parity: 'none', stopBits: 1 }, true)).toBe(0x4008);
  });
  it('drops the two status bytes of every USB packet', () => {
    const raw = new Uint8Array([0x01, 0x60, 1, 2, 3, 0x01, 0x60, 4]);
    expect(Array.from(stripStatus(raw, 5))).toEqual([1, 2, 3, 4]);
    expect(stripStatus(new Uint8Array([0x01, 0x60]), 64)).toHaveLength(0);
  });
});

/** A fake FT232R on the USB bus, wired to the simulated car (SimChannel stands for the K-line). */
class FakeFtdi {
  vendorId = 0x0403;
  productId = 0x6001;
  opened = false;
  configuration: { interfaces: unknown[] } | null = null;
  cfg: SerialConfig = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
  baudValue = 0;
  baudIndex = 0;
  log: string[] = [];
  constructor(readonly sim: SimChannel) {}
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration() {
    this.configuration = {
      interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
        { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
        { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
      ] } }],
    };
  }
  async claimInterface() {}
  async releaseInterface() {}
  async clearHalt() {}
  async controlTransferOut(s: { request: number; value: number; index: number }) {
    this.log.push(`${s.request}:${s.value.toString(16)}`);
    if (s.request === 3) {
      this.baudValue = s.value;
      this.baudIndex = s.index;
    }
    if (s.request === 4) {
      const parity = (['none', 'odd', 'even'] as const)[(s.value >> 8) & 7];
      const cfg: SerialConfig = { baudRate: Math.round(chipBaud(this.baudValue, this.baudIndex)), dataBits: 8, parity, stopBits: 1 };
      // the sim keys its protocols on the exact baud rate
      for (const b of [9600, 10400, 115200]) if (Math.abs(cfg.baudRate - b) / b < 0.01) cfg.baudRate = b;
      if (cfg.baudRate !== this.cfg.baudRate || cfg.parity !== this.cfg.parity || !this.sim.isOpen) await this.sim.reconfigure(cfg);
      this.cfg = cfg;
      await this.sim.setSignals({ brk: !!(s.value & 0x4000) });
    }
    if (s.request === 0 && s.value === 1) this.sim.discardInput();
    return { status: 'ok' };
  }
  async transferIn(_ep: number, len: number) {
    if (!this.opened) throw new Error('closed');
    const data = await this.sim.read(62, 2); // latency timer: a packet every few ms, even when empty
    const out: number[] = [];
    for (let i = 0; i < data.length || out.length === 0; i += 62) out.push(0x01, 0x60, ...data.subarray(i, i + 62));
    expect(out.length).toBeLessThanOrEqual(len);
    return { status: 'ok', data: new DataView(new Uint8Array(out).buffer) };
  }
  async transferOut(_ep: number, data: Uint8Array) {
    await this.sim.write(data);
    return { status: 'ok' };
  }
}

describe('WebUSB FTDI channel with the simulated E46', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('identifies the modules and reads the engine over OBD-II through the USB driver', async () => {
    const usb = new EventTarget() as EventTarget & { requestDevice: unknown; getDevices: unknown };
    const dev = new FakeFtdi(new SimChannel(createE46({ obdStored: ['P0171'] })));
    usb.requestDevice = async () => dev;
    usb.getDevices = async () => [dev];
    vi.stubGlobal('navigator', { usb });

    const channel = await WebUsbFtdiChannel.request();
    const iface = new ObdInterface(channel);
    await iface.connect();
    const s = new NativeSession({ channel, iface });
    const found = (await s.scan()).filter((e) => e.variant).map((e) => e.module.short);
    expect(found).toEqual(['DME', 'EGS', 'ABS', 'IKE']);
    // 9600 8E1 for DS2: divisor 0x4138, line value 0x208
    expect(dev.log).toContain('3:4138');
    expect(dev.log).toContain('4:208');
    const r = await s.readDtcs(ENGINE_VARIANT);
    expect(r.dtcs.map((d) => d.label)).toEqual(['P0171']);
    // OBD-II: break for the 5-baud wake-up at 10400 8N1
    expect(dev.log).toContain('4:4008');
    s.iso.stopKeepAlive();
    await channel.close();
    channel.dispose();
  }, 40000);
});
