// Simulated E46 325i (M54 / MS43, GS8.60.4 5HP19, ASC MK20) — data taken from the owner's BMW Scanner logs.
// Used for the demo mode and automated tests. Answers are DS2 payloads (status byte 0xA0 = OK).

import type { SimEcu } from './SimChannel';
import { DriveCycle } from './drive';
import { Ms45, Mrs5 } from './kwp';

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
    if (d[0] === 0x06 && d[1] === 0x00) return [0xa0, ...new Array(d[5] || 0x2e).fill(0)]; // AIF: empty
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
    const e0 = this.engine();
    const warm = e0.running && e0.clt > 60;
    // VANOS target / actual (STATUS_VANOS_NW_LAGE_IST_SOLL_REF_*): the cam follows its target with a small lag
    if (d[0] === 0x0b && d[1] === 0x90) {
      const b = new Array(40).fill(0);
      const wobble = Math.sin(Date.now() / 700);
      const inSoll = e0.vanosIn + (e0.running ? 1.2 * wobble : 0);
      const outSoll = e0.vanosOut - (e0.running ? 1.0 * wobble : 0);
      b[1] = u8((inSoll - 60) / 0.375);
      b[7] = u8((-60 - outSoll) / 0.375);
      b[20] = u8((e0.vanosIn - 60) / 0.375);
      b[21] = u8((-60 - e0.vanosOut) / 0.375);
      return [0xa0, ...b];
    }
    // pre-cat oxygen sensor voltage (STATUS_L_SONDE / _2): switching about once a second in closed loop
    if (d[0] === 0x0b && d[1] === 0x02 && d[2] === 0x0e) {
      const bank = d[5] === 2 ? 1 : 0;
      const v = !e0.running ? 0.02 : warm ? 0.45 + 0.38 * Math.sin(Date.now() / 170 + bank * 1.7) : 0.45;
      return [0xa0, ...u16(v / 0.004883), ...new Array(6).fill(0)];
    }
    // mixture adaptations (STATUS_LAMBDA_ADD_* / MUL_*)
    if (d[0] === 0x0b && d[1] === 0x91) return [0xa0, 0, ...u16((0.6 + 131.072) / 0.004), ...u16((2.1 + 50) / 0.0015259), ...u16((0.4 + 131.072) / 0.004), ...u16((1.6 + 50) / 0.0015259), ...new Array(20).fill(0)];
    // rough running per cylinder and misfire counters (STATUS_SYSTEMCHECK_LAUFUNRUHE), firing order 1-5-3-6-2-4
    if (d[0] === 0x2b && d[1] === 0x05) {
      const b = [0x01];
      const rough: Record<number, number> = { 1: 0.32, 5: 0.95, 3: 0.36, 6: 0.3, 2: 0.41, 4: 0.34 };
      const count: Record<number, number> = { 1: 0, 5: e0.running ? 4 : 0, 3: 0, 6: 0, 2: 0, 4: 0 };
      for (const c of [1, 5, 3, 6, 2, 4]) b.push(...u16(e0.running ? (rough[c] + 0.04 * Math.sin(Date.now() / 900 + c)) / 0.00122 : 0));
      for (const c of [1, 5, 3, 6, 2, 4]) b.push(...u16(count[c]));
      return [0xa0, ...b, ...new Array(15).fill(0)];
    }
    // user information field (AIF_LESEN): empty, as on many original DMEs
    if (d[0] === 0x06 && d[1] === 0x00) return [0xa0, ...new Array(d[5] || 0x2e).fill(0)];
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

/** Factory order of the simulated car (made up for the demo: a 2001 325i automatic). */
export const SIM_FA = 'E46_#0301*AV31%0354&N6SW$205$210$249$302$401$423$428$441$473$494$508$520$522$534$540$550$676$785';

/**
 * Instrument cluster KOMBI46 (up to 2002) or KOMBI46R (2003+) at 0x80: binary ident (diagnosis index 53 / 64), empty
 * fault memory, the coolant temperature it gets over CAN, and an EEPROM with the coolant gauge curve where the real
 * clusters keep it, answering the DS2 memory read (06 03) and write (07 03) services.
 */
export class Kombi46 extends DtcEcu {
  readonly eeprom: Uint8Array;
  writes = 0;
  constructor(readonly drive: DriveCycle, readonly kind: 'kombi46' | 'kombi46r' = 'kombi46') {
    super(0x80, kind === 'kombi46' ? 'KOMBI46' : 'KOMBI46R', [0xa0, 0x06, 0x91, 0x13, 0x42, 0x30, 0x04, kind === 'kombi46' ? 0x53 : 0x64, 0x10, 0x20, 0x01, 0x00, 0x00, 0x00, 0x30, 0x00, ...new Array(20).fill(0)], []);
    this.eeprom = new Uint8Array(kind === 'kombi46' ? 0x200 : 0x800);
    // filler that never looks like a curve
    for (let i = 0; i < this.eeprom.length; i++) this.eeprom[i] = (i * 37 + 11) & 0xff;
    if (kind === 'kombi46') this.eeprom.set([0x0f, 0x00, 0x32, 0x1f, 0x4b, 0x5a, 0x73, 0x5a, 0x7c, 0x94, 0x7d, 0xa4, 0x06, 0x0e, 0x1e, 0x0f], 0xf0);
    else this.eeprom.set([0x06, 0x0f, 0x32, 0x4b, 0x73, 0x7d, 0x8f, 0x00, 0x10, 0x2d, 0x2d, 0x4f, 0x54], 0x34d);
  }
  protected status(d: Uint8Array): number[] {
    const words = this.eeprom.length / 2;
    if ((d[0] === 0x06 || d[0] === 0x07) && d[1] === 0x03) {
      const w = (d[3] << 8) | d[4];
      const n = d[5];
      if (!n || w + n > words || (d[0] === 0x06 && n > 16)) return [0xa2];
      if (d[0] === 0x06) return [0xa0, ...this.eeprom.subarray(w * 2, (w + n) * 2)];
      if (d.length < 6 + n * 2) return [0xa2];
      this.eeprom.set(d.subarray(6, 6 + n * 2), w * 2);
      this.writes++;
      return [0xa0];
    }
    if (d[0] === 0x06 && d[1] === 0x0a && this.kind === 'kombi46') return [0xa0, u8((this.drive.state().clt + 48) / 0.75)];
    if (d[0] === 0x12) return [0xa0];
    // odometer (AIF_GWSZ_LESEN) and short VIN (AIF_FG_NR_LESEN), BCD like the real cluster
    if (d[0] === 0x02 && d[1] === 0x01) return [0xa0, 0x00, 0x18, 0x64, 0x32]; // 186 432 km
    if (d[0] === 0x02 && d[1] === 0x02) return [0xa0, 0x00, 0x4b, 0x4c, 0x12, 0x34, 0x50]; // KL12345
    // factory order (C_FA_LESEN): ASCII, words 0x10-0xDF of memory 08, ended by 00
    if (d[0] === 0x06 && d[1] === 0x08) {
      const w = (d[3] << 8) | d[4];
      const n = d[5];
      const fa = new TextEncoder().encode(SIM_FA);
      return [0xa0, ...Array.from({ length: n * 2 }, (_, k) => { const i = w * 2 + k - 0x20; return i >= 0 && i < fa.length ? fa[i] : 0; })];
    }
    return super.status(d);
  }
}

/**
 * The simulated car. Engine and gearbox follow one drive cycle (see drive.ts). By default it starts at warm idle
 * (tests); the app passes a cycle that starts with the key on and the engine off.
 */
export interface SimOptions {
  obdStored?: string[];
  obdPending?: string[];
  drive?: DriveCycle;
  /** 'ms43' (default): the owner's 325i. 'ms45': a 2003+ M54 whose DME speaks KWP2000*. */
  engine?: 'ms43' | 'ms45';
  /** Add an MRS5 airbag module (BMW-FAST at 115200 baud). */
  mrs5?: boolean;
  /** Instrument cluster type (default 'kombi46', like the owner's 2001 car); false: no cluster. */
  cluster?: 'kombi46' | 'kombi46r' | false;
}

export function createE46(opts: SimOptions = {}): SimEcu[] {
  const drive = opts.drive ?? new DriveCycle(340);
  let dme: SimEcu;
  if (opts.engine === 'ms45') dme = new Ms45(drive);
  else {
    const ms43 = new Ms43(drive);
    ms43.obdStored = opts.obdStored ?? [];
    ms43.obdPending = opts.obdPending ?? [];
    dme = ms43;
  }
  return [
    dme,
    // MRS5: the D_00A4 group finds it with KWP2000* at 0x58; MRS5.PRG talks BMW-FAST to 0x01
    ...(opts.mrs5 ? [new Mrs5(0x01, 'bmwfast'), new Mrs5(0x58, 'kwp2000s')] : []),
    Object.assign(new Gs8604(0x32, 'EGS GS8.60.4', ident({ bmw: '7548312', hw: '2H', cod: '00', diag: '11', bus: '60', week: '02', year: '01', sw: '22' }), [
      { code: 0x61, type: 0xc1 },
    ], 19), { drive }),
    // MK20 uses a binary ident: BMW-Nr as hex nibbles, then HW, COD, DIAG, BUS, day, month, year, supplier, SW
    new DtcEcu(0x56, 'ASC MK20', [0xa0, 0x06, 0x75, 0x17, 0x67, 0x06, 0x04, 0x69, 0x60, 0x06, 0x11, 0x04, 0x33, ...new Array(27).fill(0)], [
      { code: 0x94, type: 0x37 },
      { code: 0x95, type: 0x37 },
    ], 3, false),
    ...(opts.cluster === false ? [] : [new Kombi46(drive, opts.cluster ?? 'kombi46')]),
  ];
}
