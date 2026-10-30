// Remote session: the helper's RemoteSession talks to a RemoteHost on the computer at the (simulated) car.
// The host enforces the access the owner chose; writes and raw K-line access never cross.
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { HybridSession } from '../src/core/api/HybridSession';
import { E46_MODULES } from '../src/core/api/modules';
import { hasDs2Link } from '../src/core/coding/clusterEeprom';
import { NativeSession, ENGINE_VARIANT } from '../src/core/native/NativeSession';
import { Approval, RemoteAccess, RemoteHost, RemoteSession, decode, encode, makeCode, pipePair, readCode } from '../src/core/remote/remote';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';

async function link(session: NativeSession | HybridSession, access: RemoteAccess, answer = true) {
  const asked: Approval[] = [];
  const [a, b] = pipePair();
  const host = new RemoteHost(a, { session, access, app: 'test', car: () => 'BMW E46 · M54', approve: async (x) => { asked.push(x); if (answer) session.safetyMode = 'service'; return answer; } });
  const helper = new RemoteSession(b);
  await helper.hello();
  return { host, helper, asked };
}

describe('remote session protocol', () => {
  it('keeps Maps and bytes across the wire', () => {
    const v = decode<{ m: Map<string, { value: Uint8Array }> }>(encode({ m: new Map([['X', { value: new Uint8Array([1, 2, 255]) }]]) }));
    expect(v.m.get('X')!.value).toEqual(new Uint8Array([1, 2, 255]));
  });
  it('packs a WebRTC offer into a code and back', async () => {
    const sdp = 'v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijkl\r\na=fingerprint:sha-256 AA:BB:CC\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=candidate:1 1 udp 2122260223 192.168.0.10 54321 typ host\r\n';
    const code = await makeCode('offer', sdp);
    expect(code.startsWith('E46-INVITE-')).toBe(true);
    const back = await readCode(` ${code.slice(0, 30)}\n${code.slice(30)} `);
    expect(back).toEqual({ type: 'offer', sdp });
    await expect(readCode('hello')).rejects.toThrow(/not an E46Fanatics Scan code/);
    await expect(readCode(code.slice(0, 40))).rejects.toThrow(/incomplete/);
  });
});

describe('remote session on the simulated car (plug and play)', () => {
  it('reads the car remotely; clearing needs the owner; raw access is not offered', async () => {
    const channel = new SimChannel(createE46({ obdStored: ['P0171'] }));
    const iface = new ObdInterface(channel);
    await iface.connect();
    const car = new NativeSession({ channel, iface });
    const { helper, asked } = await link(car, 'read', false);
    expect(helper.info).toMatchObject({ car: 'BMW E46 · M54', access: 'read', kind: 'native' });
    expect(hasDs2Link(helper)).toBe(false);
    const seen: string[] = [];
    const scan = await helper.scan(E46_MODULES.slice(0, 3), (e) => seen.push(e.module.short));
    expect(scan.map((e) => e.variant)).toEqual([ENGINE_VARIANT, 'native:32', 'native:56']);
    expect(seen).toEqual(['DME', 'EGS', 'ABS']);
    const f = await helper.readDtcs(ENGINE_VARIANT);
    expect(f.dtcs.map((d) => d.label)).toEqual(['P0171']);
    const live = await helper.readValues(ENGINE_VARIANT, 'OBD_LIVE');
    expect(live.values.length).toBeGreaterThan(3);
    const c = await helper.clearDtcs(ENGINE_VARIANT);
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/Refused by the car owner/);
    expect(asked.map((x) => x.kind)).toEqual(['clear']);
    expect((await car.readDtcs(ENGINE_VARIANT)).dtcs.length).toBe(1);
    car.iso.stopKeepAlive();
  }, 60000);
});

describe.skipIf(!existsSync(ECU_DIR))('remote session with the BMW files', () => {
  async function hybrid() {
    const channel = new SimChannel(createE46());
    const iface = new ObdInterface(channel);
    await iface.connect();
    return new HybridSession(new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface, jobTimeoutMs: 8000 }), new NativeSession({ channel, iface }), () => iface.resetLine());
  }
  it('read-only access refuses tests and writes; "tests" access asks the owner', async () => {
    const car = await hybrid();
    car.safetyMode = 'service'; // even unlocked at the car, read-only sharing refuses tests
    const ro = await link(car, 'read');
    await ro.helper.scan([E46_MODULES[0]]);
    const read = await ro.helper.run('ms430ds0', 'STATUS_MESSWERTEBLOCK');
    expect(read.error).toBeUndefined();
    expect((await ro.helper.run('ms430ds0', 'STEUERN_EKP')).error?.text).toMatch(/read-only access/);
    expect((await ro.helper.run('kombi46', 'C_FA_AUFTRAG')).error?.text).toMatch(/never allowed/);
    expect((await ro.helper.readValues('ms430ds0', 'STEUERN_EKP')).error).toMatch(/not a reading/);
    expect(ro.asked).toEqual([]);

    car.safetyMode = 'read';
    const t = await link(car, 'tests');
    const r = await t.helper.run('ms430ds0', 'STEUERN_EKP');
    expect(t.asked.map((x) => x.kind)).toEqual(['test']);
    expect(r.error?.code).not.toBe(-1);
    expect((await t.helper.run('kombi46', 'C_FA_AUFTRAG')).error?.text).toMatch(/never allowed/);
    car.native.iso.stopKeepAlive();
  }, 90000);
});
