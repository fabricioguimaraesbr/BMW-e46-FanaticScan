// ELM327 adapters: OBD-II of the engine only (no DS2), on the simulated E46.
import { describe, expect, it } from 'vitest';
import { Elm327, parseElmAnswer } from '../src/core/native/elm327';
import { ENGINE_VARIANT, NativeSession } from '../src/core/native/NativeSession';
import { createE46 } from '../src/core/sim/e46';
import { SimElmChannel } from '../src/core/sim/elmSim';

async function session(opts: Parameters<typeof createE46>[0] = {}, ignition = true) {
  const channel = new SimElmChannel(createE46(opts), ignition);
  await channel.open({ baudRate: 38400, dataBits: 8, parity: 'none', stopBits: 1 });
  const elm = new Elm327(channel);
  return { s: new NativeSession({ channel, elm }), elm };
}

describe('ELM327', () => {
  it('parses answers', () => {
    expect(parseElmAnswer('SEARCHING...\r41 0C 1A F8\r').map((m) => Array.from(m.data))).toEqual([[0x41, 0x0c, 0x1a, 0xf8]]);
    expect(parseElmAnswer('410D32').map((m) => Array.from(m.data))).toEqual([[0x41, 0x0d, 0x32]]);
    expect(parseElmAnswer('43 01 71 00 00 00 00\r43 03 00 00 00 00 00')).toHaveLength(2);
    expect(parseElmAnswer('NO DATA')).toHaveLength(0);
    expect(parseElmAnswer('?')).toHaveLength(0);
  });

  it('finds only the engine, reads faults and live data, clears', async () => {
    const { s, elm } = await session({ obdStored: ['P0171'], obdPending: ['P0300'] });
    const found = (await s.scan()).filter((e) => e.variant);
    expect(found.map((e) => [e.module.short, e.variant])).toEqual([['DME', ENGINE_VARIANT]]);
    expect(found[0].ident.ID_PROTOCOL).toMatch(/ELM327 \(ISO 9141-2\)/);
    expect(elm.version).toBe('ELM327 v1.5');
    const r = await s.readDtcs(ENGINE_VARIANT);
    expect(r.dtcs.map((d) => d.label)).toEqual(['P0171', 'P0300']);
    const v = await s.readValues(ENGINE_VARIANT, 'OBD_LIVE');
    expect(v.values.find((x) => x.key === 'OBD_0C')?.value).toBeTypeOf('number');
    expect((await s.clearDtcs(ENGINE_VARIANT)).ok).toBe(true);
    expect((await s.readDtcs(ENGINE_VARIANT)).dtcs).toHaveLength(0);
  }, 30000);

  it('reports an engine that does not answer (ignition off)', async () => {
    const { s } = await session({}, false);
    expect((await s.scan()).filter((e) => e.variant)).toHaveLength(0);
  }, 30000);
});
