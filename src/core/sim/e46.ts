// Simulated E46 325i (M54 / MS43, GS8.60.4 5HP19, ASC MK20) — data taken from the owner's BMW Scanner logs.
// Used for the demo mode and automated tests. Answers are DS2 payloads (status byte 0xA0 = OK).

import type { SimEcu } from './SimChannel';
import { DriveCycle } from './drive';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** DS2 ident: BMW-Nr(7) HW(2) COD(2) DIAG(2) BUS(2) KW(2) YEAR(2) SUPPLIER(10) SW(2) AI(2) X PROD(8) */
function ident(p: {
  bmw: string; hw: string; cod: string; diag: string; bus: string; week: string; year: string;
  lief?: string; sw: string; ai?: string;
}) {
  return [0xa0, ...ascii(p.bmw + p.hw + p.cod + p.diag + p.bus + p.week + p.year + (p.lief ?? '0000000000').padEnd(10, '0').slice(0, 10) + p.sw + (p.ai ?? '00') + 'X' + '00000000')];
}

interface Dtc {
  code: number;
  type: number;
  env?: number[];
}

/** Base ECU: ident, error memory read/clear, generic status answer. */
class DtcEcu implements SimEcu {
  dtcs: Dtc[];
  constructor(
    readonly address: number,
    readonly name: string,
    private identPayload: number[],
    dtcs: Dtc[],
    private recordLen = 10,
    /** true: answer starts with the error count (EGS), false: records only (MK20) */
    private withCount = true,
  ) {
    this.dtcs = dtcs.slice();
  }
  handle(d: Uint8Array): number[] | null {
    const cmd = d[0];
    if (cmd === 0x00) return this.identPayload;
    if (cmd === 0x04) return this.errorMemory(d[1] ?? 0);
    if (cmd === 0x05) {
      this.dtcs = [];
      return [0xa0];
    }
    return this.status(d);
  }
  protected errorMemory(_block: number): number[] {
    const out = this.withCount ? [0xa0, this.dtcs.length] : [0xa0];
    for (const e of this.dtcs) {
      const rec = [e.code, e.type, ...(e.env ?? [])];
      while (rec.length < this.recordLen) rec.push(0);
      out.push(...rec.slice(0, this.recordLen));
    }
    return out;
  }
  protected status(_d: Uint8Array): number[] {
    return [0xa0, ...new Array(40).fill(0)];
  }
}

const u16 = (v: number) => {
  const x = Math.max(0, Math.min(0xffff, Math.round(v)));
  return [x >> 8, x & 0xff];
};
const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function encodeDtc(code: string): [number, number] {
  const sys = 'PCBU'.indexOf(code[0]);
  const n = parseInt(code.slice(1), 16);
  return [(sys << 6) | ((n >> 8) & 0x3f), n & 0xff];
}

/** GS8.60.4: STATUS_IO_LESEN (0B 03) driven by the engine model. */
class Gs8604 extends DtcEcu {
  drive = new DriveCycle(340);
  protected status(d: Uint8Array): number[] {
    if (d[0] === 0x0b && d[1] === 0x03) {
      const e = this.drive.state();
      const gear = e.gear;
      const b = new Array(30).fill(0);
      b[0] = u8(e.rpm / 32);
      b[1] = u8(e.turbine / 32);
      b[2] = u8(e.output / 32);
      b[3] = u8(e.pedal / 0.39);
      b[4] = u8(e.load / 4 / 4);
      b[5] = u8(e.clt + 48);
      b[6] = u8(e.atf + 40);
      b[7] = u8(e.ubatt / 0.0808);
      for (let i = 8; i < 12; i++) b[i] = u8((e.speed * 8.2) / 16);
      for (let i = 12; i < 16; i++) b[i] = e.running ? 0x10 : 0;
      b[20] = gear << 5;
      return [0xa0, ...b];
    }
    return super.status(d);
  }
}

/** MS43 with a simple engine model (idle → rev → cruise cycle) for live data. */
class Ms43 extends DtcEcu {
  constructor(readonly drive: DriveCycle) {
    super(
      0x12,
      'DME MS43',
      ident({ bmw: '7545150', hw: '19', cod: '00', diag: '15', bus: '60', week: '03', year: '01', sw: '81' }),
      [
        { code: 0x83, type: 0xe8, env: [0x0c, 0x80, 0x55, 0x8c, 0x71] },
        { code: 0x84, type: 0xe8, env: [0x0c, 0x80, 0x55, 0x8c, 0x71] },
      ],
    );
  }
  // MS43: block 0 holds the error count, block 1 the 10-byte records (after status + 1 byte)
  protected errorMemory(block: number): number[] {
    const records = this.dtcs.flatMap((e) => {
      const rec = [e.code, e.type, ...(e.env ?? [])];
      while (rec.length < 10) rec.push(0);
      return rec.slice(0, 10);
    });
    const body = block === 0 ? [this.dtcs.length] : [this.dtcs.length, ...records];
    while (body.length < 21) body.push(0);
    return [0xa0, ...body];
  }
  engine() {
    return this.drive.state();
  }
  /** OBD-II / EOBD view of the same engine (supported PIDs like an EU MS43). */
  obdStored: string[] = [];
  obdPending: string[] = [];
  handleObd(req: Uint8Array): number[][] | null {
    const e = this.drive.state();
    const sid = req[0];
    if (sid === 0x01) {
      const pid = req[1];
      const supported: Record<number, number[]> = {
        0x00: [0xbf, 0xbf, 0xb9, 0x93], // 01,03-09,0B-11,13-15,18,19,1C,1F,20
        0x20: [0x80, 0x00, 0x00, 0x00],
      };
      if (supported[pid]) return [[0x41, pid, ...supported[pid]]];
      const t = (pct: number) => Math.max(0, Math.min(255, Math.round(128 + (pct * 128) / 100)));
      const map: Record<number, number[]> = {
        0x01: [(this.obdStored.length ? 0x80 : 0) | this.obdStored.length, 0x07, 0x65, 0x00],
        0x03: [0x02, 0x00],
        0x04: [Math.round(((e.load / 1000) * 255) / 1)],
        0x05: [Math.round(e.clt + 40)],
        0x06: [t((e.lambda1 - 1) * 100)],
        0x07: [t(1.6)],
        0x08: [t((e.lambda2 - 1) * 100)],
        0x09: [t(-0.8)],
        0x0b: [Math.round(30 + (e.load / 520) * 70)],
        0x0c: [(Math.round(e.rpm * 4) >> 8) & 0xff, Math.round(e.rpm * 4) & 0xff],
        0x0d: [Math.round(e.speed)],
        0x0e: [Math.round((e.ign + 64) * 2)],
        0x0f: [Math.round(e.iat + 40)],
        0x10: [(Math.round((e.maf / 3.6) * 100) >> 8) & 0xff, Math.round((e.maf / 3.6) * 100) & 0xff],
        0x11: [Math.round((e.throttle / 100) * 255)],
        0x13: [0x33],
        0x14: [Math.round((e.running ? 0.45 + Math.sin(Date.now() / 300) * 0.35 : 0.45) * 200), t((e.lambda1 - 1) * 100)],
        0x15: [Math.round(0.68 * 200), 0xff],
        0x18: [Math.round((e.running ? 0.45 + Math.cos(Date.now() / 280) * 0.35 : 0.45) * 200), t((e.lambda2 - 1) * 100)],
        0x19: [Math.round(0.66 * 200), 0xff],
        0x1c: [0x06],
        0x1f: [0x01, 0x2c],
        0x21: [0x00, 0x00],
      };
      return map[pid] ? [[0x41, pid, ...map[pid]]] : null;
    }
    if (sid === 0x03 || sid === 0x07) {
      const codes = (sid === 0x03 ? this.obdStored : this.obdPending).map(encodeDtc);
      const msgs: number[][] = [];
      for (let i = 0; i < Math.max(1, codes.length); i += 3) {
        const chunk = codes.slice(i, i + 3);
        while (chunk.length < 3) chunk.push([0, 0]);
        msgs.push([sid + 0x40, ...chunk.flat()]);
      }
      return msgs;
    }
    if (sid === 0x04) {
      this.obdStored = [];
      this.obdPending = [];
      return [[0x44]];
    }
    return null;
  }
  protected status(d: Uint8Array): number[] {
    // ECU_CONFIG / ABGAS_VARIANTE_LESEN: CAT + AT, A/C + MIL + e-fan + cluster, ASC + MFL + pre/post-cat sensors (no SLP, no flap)
    if (d[0] === 0x0b && d[1] === 0x94) return [0xa0, 0x16, 0x9a, 0xca, 0, 0, 0, 0, 0];
    if (d[0] === 0x0b && d[1] === 0x03) {
      const e = this.engine();
      const b = new Array(41).fill(0);
      const put = (i: number, bytes: number[]) => bytes.forEach((x, k) => (b[i - 3 + k] = x));
      put(3, u16(e.rpm));
      put(5, [u8(e.speed)]);
      put(6, u16(e.pedal / 0.0018311));
      put(8, u16(e.throttle / 0.0018311));
      put(10, u16(e.maf / 0.25));
      put(12, [u8((e.iat + 48) / 0.75)]);
      put(13, [u8((e.clt + 48) / 0.75)]);
      put(14, [u8((e.oil + 48) / 0.796)]);
      put(15, [u8((e.cltOut + 48) / 0.75)]);
      put(17, u16(e.inj / 0.005333));
      put(19, u16(30 / 0.0015));
      put(21, u16(32 / 0.0015));
      put(23, [u8((e.vanosIn - 60) / 0.375)]);
      put(24, [u8((-60 - e.vanosOut) / 0.375)]);
      put(25, [u8(e.kl15 / 0.10156)]);
      put(26, u16(0x8000 + (e.lambda1 - 1) / 1.526e-5));
      put(28, u16(0x8000 + (e.lambda2 - 1) / 1.526e-5));
      for (let i = 30; i <= 33; i++) put(i, [u8(e.o2heat / 0.391)]);
      put(34, u16(e.load / 0.0212));
      put(40, [u8(e.fan / 0.3906)]);
      put(41, u16(e.pressure / 0.08292));
      put(43, [u8(e.ubatt / 0.10156)]);
      return [0xa0, ...b];
    }
    return super.status(d);
  }
}

/**
 * The simulated car. Engine and gearbox follow one drive cycle (see drive.ts). By default it starts at warm idle
 * (tests); the app passes a cycle that starts with the key on and the engine off.
 */
export function createE46(opts: { obdStored?: string[]; obdPending?: string[]; drive?: DriveCycle } = {}): SimEcu[] {
  const drive = opts.drive ?? new DriveCycle(340);
  const dme = new Ms43(drive);
  dme.obdStored = opts.obdStored ?? [];
  dme.obdPending = opts.obdPending ?? [];
  return [
    dme,
    Object.assign(new Gs8604(0x32, 'EGS GS8.60.4', ident({ bmw: '7548312', hw: '2H', cod: '00', diag: '11', bus: '60', week: '02', year: '01', sw: '22' }), [
      { code: 0x61, type: 0xc1 },
    ], 19), { drive }),
    // MK20 uses a binary ident: BMW-Nr as hex nibbles, then HW, COD, DIAG, BUS, day, month, year, supplier, SW
    new DtcEcu(0x56, 'ASC MK20', [0xa0, 0x06, 0x75, 0x17, 0x67, 0x06, 0x04, 0x69, 0x60, 0x06, 0x11, 0x04, 0x33, ...new Array(27).fill(0)], [
      { code: 0x94, type: 0x37 },
      { code: 0x95, type: 0x37 },
    ], 3, false),
  ];
}
