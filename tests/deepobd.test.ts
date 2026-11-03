// ELM327 with the Deep OBD firmware: DS2 and OBD-II of the whole simulated E46 over the adapter protocol.
import { describe, expect, it } from 'vitest';
import { ENGINE_VARIANT, NativeSession } from '../src/core/native/NativeSession';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { SimDeepObdAdapter } from '../src/core/sim/deepObdSim';
import { DeepObdChannel, klineTelegram, pulseTelegram, sum8 } from '../src/core/transport/DeepObdChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';

describe('Deep OBD telegrams', () => {
  it('builds K-line telegrams like EdiabasLib', () => {
    const t = klineTelegram({ baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 }, [0x12, 0x04, 0x00, 0x16], 0x0010);
    expect(Array.from(t.slice(0, 10))).toEqual([0x00, 0x02, 0x12, 0xc0, 0x21, 0x00, 0x00, 60, 0x00, 0x04]);
    expect(t[t.length - 1]).toBe(sum8(t, t.length - 1));
    const old = klineTelegram({ baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 }, [1, 2], 0x0005);
    expect(Array.from(old.slice(0, 8))).toEqual([0x00, 0x00, 0x12, 0xc0, 0x21, 0x00, 0x00, 0x02]);
  });
  it('builds the 5-baud pulse telegram', () => {
    const t = pulseTelegram({ baudRate: 10400, dataBits: 8, parity: 'none', stopBits: 1 }, (0x33 << 1) | 0x200, 10, 200, 0x0010, 30);
    expect(Array.from(t.slice(0, 16))).toEqual([0x00, 0x02, 0x14, 0x50, 0x30, 0x00, 0x00, 60, 0x00, 0x05, 200, 10, 0x66, 0x02, 30, t[15]]);
  });
});

describe('Deep OBD adapter on the simulated E46', () => {
  it('reads the version, then every DS2 module and the engine over OBD-II', async () => {
    const raw = new SimDeepObdAdapter(new SimChannel(createE46({ obdStored: ['P0171'] })));
    const ch = await DeepObdChannel.probe(raw);
    expect(ch?.info.version).toBe(0x0010);
    expect(await ch!.readVoltage()).toBeCloseTo(13.8);
    const iface = new ObdInterface(ch!);
    await iface.connect();
    const s = new NativeSession({ channel: ch!, iface });
    const found = (await s.scan()).filter((e) => e.variant).map((e) => e.module.short);
    expect(found).toEqual(['DME', 'EGS', 'ABS', 'IKE']);
    expect((await s.readDtcs(ENGINE_VARIANT)).dtcs.map((d) => d.label)).toEqual(['P0171']);
    // DS2 again after OBD-II
    const raw2 = await s.ds2Raw(0x32, [0x00]);
    expect(raw2?.[2]).toBe(0xa0);
    s.iso.stopKeepAlive();
    await ch!.close();
  }, 60000);

  it('is not mistaken for a stock ELM327', async () => {
    const { SimElmChannel } = await import('../src/core/sim/elmSim');
    const elm = new SimElmChannel(createE46());
    await elm.open({ baudRate: 38400, dataBits: 8, parity: 'none', stopBits: 1 });
    expect(await DeepObdChannel.probe(elm)).toBeNull();
  });
});
