// Plug-and-play mode: no BMW files at all. DS2 identification + OBD-II (ISO 9141-2) on the simulated K-line.
import { describe, expect, it } from 'vitest';
import { ENGINE_VARIANT, NativeSession, decodeDs2Ident } from '../src/core/native/NativeSession';
import { splitMessages } from '../src/core/native/iso9141';
import { decodeDtc } from '../src/core/native/obd2';
import { describePcode } from '../src/core/native/pcodes';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';

async function session(opts: Parameters<typeof createE46>[0] = {}, withEngine = true) {
  const ecus = createE46(opts).filter((e) => withEngine || e.address !== 0x12);
  const channel = new SimChannel(ecus);
  const iface = new ObdInterface(channel);
  await iface.connect();
  return new NativeSession({ channel, iface });
}

describe('OBD-II helpers', () => {
  it('decodes DTCs and describes them', () => {
    expect(decodeDtc(0x01, 0x71)).toBe('P0171');
    expect(decodeDtc(0x03, 0x00)).toBe('P0300');
    expect(decodeDtc(0x10, 0x83)).toBe('P1083');
    expect(decodeDtc(0xc1, 0x00)).toBe('U0100');
    expect(describePcode('P0171')).toBe('System too lean (bank 1)');
    expect(describePcode('P0399')).toMatch(/Ignition system or misfire/);
    expect(describePcode('P1083')).toMatch(/Manufacturer-specific/);
  });
  it('splits ISO 9141 answers by checksum', () => {
    const m1 = [0x48, 0x6b, 0x12, 0x41, 0x0c, 0x0b, 0x40];
    m1.push(m1.reduce((a, b) => a + b, 0) & 0xff);
    const m2 = [0x48, 0x6b, 0x12, 0x43, 0x01, 0x71, 0, 0, 0, 0];
    m2.push(m2.reduce((a, b) => a + b, 0) & 0xff);
    const msgs = splitMessages([...m1, ...m2]);
    expect(msgs.map((m) => Array.from(m.data))).toEqual([[0x41, 0x0c, 0x0b, 0x40], [0x43, 0x01, 0x71, 0, 0, 0, 0]]);
  });
  it('decodes ASCII and binary DS2 idents', () => {
    expect(decodeDs2Ident(new Uint8Array([...'7545150190015600301'].map((c) => c.charCodeAt(0)))).ID_BMW_NR).toBe('7545150');
    expect(decodeDs2Ident(new Uint8Array([0x06, 0x75, 0x17, 0x67, 0x06, 0x04, 0x69])).ID_BMW_NR).toBe('6751767');
  });
});

describe('plug-and-play session (simulated E46)', () => {
  it('identifies modules without any BMW file', async () => {
    const s = await session();
    const found = (await s.scan()).filter((e) => e.variant);
    expect(found.map((e) => [e.module.short, e.ident.ID_BMW_NR])).toEqual([['DME', '7545150'], ['EGS', '7548312'], ['ABS', '6751767'], ['IKE', '6911342']]);
  }, 30000);

  it('reads, describes and clears engine faults over OBD-II', async () => {
    const s = await session({ obdStored: ['P0171', 'P1083'], obdPending: ['P0300'] });
    const r = await s.readDtcs(ENGINE_VARIANT);
    expect(r.dtcs.map((d) => d.label)).toEqual(['P0171', 'P1083', 'P0300']);
    expect(r.dtcs[0].text).toBe('System too lean (bank 1)');
    expect(r.dtcs[2].details[0]).toMatch(/Pending/);
    expect((await s.clearDtcs(ENGINE_VARIANT)).ok).toBe(true);
    expect((await s.readDtcs(ENGINE_VARIANT)).dtcs).toHaveLength(0);
    s.iso.stopKeepAlive();
  }, 30000);

  it('reads standard live data', async () => {
    const s = await session();
    const a = await s.checkAvailability(ENGINE_VARIANT);
    expect(a.jobs).toContain('OBD_LIVE');
    const r = await s.readValues(ENGINE_VARIANT, 'OBD_LIVE');
    const get = (k: string) => r.values.find((v) => v.key === k)?.value as number;
    expect(get('OBD_0C')).toBeGreaterThan(600);
    expect(get('OBD_05')).toBeGreaterThan(50);
    expect(r.values.find((v) => v.key === 'OBD_06')?.unit).toBe('%');
    expect(r.values.length).toBeGreaterThan(12);
    s.iso.stopKeepAlive();
  }, 30000);

  it('reports a clear error when the engine does not answer (ignition off)', async () => {
    const s = await session({}, false);
    const r = await s.readDtcs(ENGINE_VARIANT);
    expect(r.error).toMatch(/did not answer/);
  }, 30000);

  it('does not pretend to read DS2 module faults without files', async () => {
    const s = await session();
    const r = await s.readDtcs('native:32');
    expect(r.notSupported).toBe(true);
  });
});
