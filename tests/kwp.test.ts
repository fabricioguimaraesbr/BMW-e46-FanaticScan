// KWP2000* (MS45, ME9) and BMW-FAST (MRS5) on the K-line: framing, checksums, response pending, line control,
// and the MS45 / MRS5 modules end to end through their SGBDs (with ECU_DIR).
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { E46_MODULES } from '../src/core/api/modules';
import { classifyJob } from '../src/core/api/safety';
import type { IfhHost } from '../src/core/ediabas/EdInterface';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel, SimEcu } from '../src/core/sim/SimChannel';
import { ObdInterface, sum8, xor } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';
const KWP = [0x10d, 9600, 500, 25, 20, 0, 2, 5000];
const FAST = [0x10f, 115200, 800, 20, 10, 2, 5000];

function host() {
  const errors: number[] = [];
  const h: IfhHost = { setError: (c) => void errors.push(c), log: () => undefined, getConfig: () => null };
  return { h, errors };
}

/** A KWP test module: positive answer to anything, "response pending" first for service 0x31. */
const testEcu = (address: number, protocol: 'kwp2000s' | 'bmwfast'): SimEcu => ({
  address,
  name: 'test',
  protocol,
  handle: () => null,
  handleKwp: (d) => (d[0] === 0x31 ? [[0x7f, 0x31, 0x78], [0x71, d[1]]] : [d[0] + 0x40, ...d.slice(1), 0x11, 0x22]),
});

async function iface(ecus: SimEcu[], opts = {}) {
  const ch = new SimChannel(ecus);
  const i = new ObdInterface(ch, opts);
  const { h, errors } = host();
  i.host = h;
  await i.connect();
  return { i, ch, errors };
}

describe('KWP2000* and BMW-FAST framing', () => {
  it('KWP2000*: 9600 8E1, XOR checksum, answer length from byte 3', async () => {
    const { i } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    const rx = await i.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]));
    expect([...rx!]).toEqual([0xb8, 0xf1, 0x12, 0x04, 0x5a, 0x80, 0x11, 0x22, xor([0xb8, 0xf1, 0x12, 0x04, 0x5a, 0x80, 0x11, 0x22])]);
  });

  it('BMW-FAST: 115200 8N1, 8-bit sum, length in the header byte', async () => {
    const { i } = await iface([testEcu(0x01, 'bmwfast')]);
    await i.setCommParameter(FAST);
    const rx = await i.transmitData(new Uint8Array([0x82, 0x01, 0xf1, 0x1a, 0x80]));
    const body = [0x84, 0xf1, 0x01, 0x5a, 0x80, 0x11, 0x22];
    expect([...rx!]).toEqual([...body, sum8(body)]);
  });

  it('waits for the real answer after "response pending" (7F xx 78)', async () => {
    const { i } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    const rx = await i.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x31, 0x05]));
    expect([...rx!.slice(4, 6)]).toEqual([0x71, 0x05]);
  });

  it('skips the BMW-FAST try for a module that only answers KWP2000*', async () => {
    const sent: string[] = [];
    const { i, errors } = await iface([testEcu(0x12, 'kwp2000s')], { onTraffic: (d: string, b: Uint8Array | string) => d === 'tx' && sent.push(String(b)) });
    for (let n = 0; n < 2; n++) {
      await i.setCommParameter(FAST);
      expect(await i.transmitData(new Uint8Array([0x82, 0x12, 0xf1, 0x1a, 0x80]))).toBeNull();
      await i.setCommParameter(KWP);
      expect(await i.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]))).not.toBeNull();
    }
    expect(errors.length).toBe(2);
    expect(sent.length).toBe(3); // the second BMW-FAST probe never went on the wire
  });

  it('keeps an xawlen sent before xsetpar (D_00A4 / MRS3KW style KWP telegram on concept 6)', async () => {
    const { i } = await iface([testEcu(0x58, 'kwp2000s')]);
    i.setCommAnswerLen([0xfffd, 5]);
    await i.setCommParameter([6, 9600, 0x58, 0, 0, 100, 100, 20, 0]);
    const rx = await i.transmitData(new Uint8Array([0xb8, 0x58, 0xf7, 0x01, 0x3e]));
    expect(rx?.[4]).toBe(0x7e);
    // no xawlen at all (MRS3KW): a B8 telegram still gets a B8-framed answer
    await i.setCommParameter([6, 9600, 0x58, 0, 0, 100, 100, 20, 0]);
    expect((await i.transmitData(new Uint8Array([0xb8, 0x58, 0xf7, 0x01, 0x3e])))?.[4]).toBe(0x7e);
  });

  it('K+DCAN line control: DTR high only while a K-line telegram is sent', async () => {
    const ch = new SimChannel([testEcu(0x12, 'kwp2000s')]);
    const signals: string[] = [];
    const set = ch.setSignals.bind(ch);
    ch.setSignals = async (s) => {
      if (s.dtr !== undefined) signals.push(s.dtr ? 'DTR+' : 'DTR-');
      return set(s);
    };
    const i = new ObdInterface(ch, { dtrMode: 'kdcan' });
    i.host = host().h;
    await i.connect();
    signals.length = 0;
    await i.setCommParameter(KWP);
    await i.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]));
    expect(signals).toEqual(['DTR+', 'DTR-']);
    // default: DTR never raised
    const j = new ObdInterface(ch);
    j.host = host().h;
    signals.length = 0;
    await j.setCommParameter(KWP);
    await j.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]));
    expect(signals.filter((x) => x === 'DTR+')).toEqual([]);
  });

  it('finds the echo behind a stray byte left on the line', async () => {
    const { i, ch } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    const write = ch.write.bind(ch);
    let first = true;
    ch.write = async (d) => {
      if (first) (ch as unknown as { onData(b: Uint8Array): void }).onData(new Uint8Array([0x55]));
      first = false;
      return write(d);
    };
    const discard = ch.discardInput.bind(ch);
    ch.discardInput = () => undefined; // the stray byte arrives after the input was cleared
    const rx = await i.transmitData(new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]));
    ch.discardInput = discard;
    expect(rx?.[4]).toBe(0x5a);
  });
});

describe('unstable line (report of 31/10/2026: IFH-0003 in live data on Windows)', () => {
  const REQ = new Uint8Array([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80]);
  type Raw = { onData(b: Uint8Array): void };

  it('accepts an echo that arrives late', async () => {
    const { i, ch } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    expect(await i.transmitData(REQ)).not.toBeNull(); // echo learned
    // a slow USB driver: everything the cable receives reaches the app 90 ms later
    const raw = ch as unknown as Raw;
    const onData = raw.onData.bind(ch);
    raw.onData = (b) => void setTimeout(() => onData(b), 90);
    const rx = await i.transmitData(REQ);
    raw.onData = onData;
    expect(rx?.[4]).toBe(0x5a);
  });

  it('sends again when the echo is lost, even with no SGBD repeats left', async () => {
    const { i, ch, errors } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    expect(await i.transmitData(REQ)).not.toBeNull(); // echo learned
    i.commRepeats = 0;
    const write = ch.write.bind(ch);
    let lost = 2; // the first two telegrams never reach the line
    ch.write = async (d) => {
      if (lost-- > 0) return;
      return write(d);
    };
    const rx = await i.transmitData(REQ);
    expect(rx?.[4]).toBe(0x5a);
    expect(errors).toEqual([]);
  });

  it('still fails when the line stays dead', async () => {
    const { i, ch, errors } = await iface([testEcu(0x12, 'kwp2000s')]);
    await i.setCommParameter(KWP);
    expect(await i.transmitData(REQ)).not.toBeNull();
    i.commRepeats = 0;
    ch.write = async () => undefined;
    expect(await i.transmitData(REQ)).toBeNull();
    expect(errors.length).toBe(1);
  });
});

describe('write protection by job description', () => {
  it('EWS transponder "self test" is a write, the cluster self test is not', () => {
    expect(classifyJob('STEUERN_SELBSTTEST', 'ews3')).toBe('write');
    expect(classifyJob('STEUERN_SELBSTTEST', 'kombi46')).toBe('test');
    expect(classifyJob('STEUERN_CO_PROGRAMM', 'me9k_ng4', 'LL-CO-WERT programmieren')).toBe('write');
    expect(classifyJob('STEUERN_MOTOR_KLAPPENPOSITION', 'ihka46', 'Es ist moeglich auch nur einzelne Argumente zu schreiben')).toBe('test');
  });
});

describe.skipIf(!existsSync(ECU_DIR))('MS45 and MRS5 through their SGBDs (simulated)', () => {
  async function session() {
    const i = new ObdInterface(new SimChannel(createE46({ engine: 'ms45', mrs5: true })));
    await i.connect();
    return new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface: i, jobTimeoutMs: 15000 });
  }

  it('the DME group identifies the MS45 over KWP2000*, the airbag group the KWP airbag', async () => {
    const s = await session();
    const r = await s.scan(E46_MODULES.filter((m) => m.short === 'DME' || m.short === 'MRS'));
    expect(r.map((e) => e.variant)).toEqual(['ms450ds0', 'mrs3kw']);
  }, 30000);

  it('reads MS45 faults with their conditions (FS_LESEN + FS_LESEN_DETAIL)', async () => {
    const s = await session();
    const { dtcs, error } = await s.readDtcs('ms450ds0');
    expect(error).toBeUndefined();
    expect(dtcs.map((d) => d.code)).toEqual([0x2718, 0x271a]);
    expect(dtcs[0].text).toMatch(/crankshaft/i);
    expect(dtcs[0].present).toBe(true);
    expect(dtcs[1].present).toBe(false);
    expect(dtcs[0].env.length).toBeGreaterThan(0);
    expect(dtcs[0].frequency).not.toBeNull();
  }, 30000);

  it('reads MS45 live values with English labels', async () => {
    const s = await session();
    const r = await s.readValues('ms450ds0', 'STATUS_MESSWERTE');
    expect(r.error).toBeUndefined();
    const labels = r.values.map((v) => v.label);
    expect(labels).toContain('Engine speed');
    expect(labels).toContain('Coolant temp');
  }, 30000);
});
