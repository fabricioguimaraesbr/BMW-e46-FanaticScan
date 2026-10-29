// Simulated KWP-speaking E46 modules, for the protocol tests and the "MS45 car" in the simulator:
//   MS45 DME (M54 from 2003) on KWP2000* (9600 8E1, B8 header, XOR): silent on BMW-FAST, like the real one.
//   MRS5 airbag on BMW-FAST (115200 8N1, 8-bit sum).
// Answers are KWP payloads (positive response = service + 0x40). The byte layouts were worked out by running the
// SGBDs' jobs against this simulator, not taken from BMW documents.

import type { SimEcu } from './SimChannel';
import { DriveCycle } from './drive';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

interface KwpDtc {
  code: number;
  /** KWP status byte as the SGBD decodes it: 0x40 = present now (0x44 present, 0x24 stored only) */
  status: number;
}

class KwpEcu implements SimEcu {
  dtcs: KwpDtc[];
  /** VIN of the simulated car (not a real one) */
  vin = '';
  constructor(
    readonly address: number,
    readonly name: string,
    readonly protocol: 'kwp2000s' | 'bmwfast',
    private identData: number[],
    dtcs: KwpDtc[],
  ) {
    this.dtcs = dtcs.slice();
  }
  /** DS2 requests: not answered (these modules only speak KWP). */
  handle() {
    return null;
  }
  /** One KWP request (service + parameters) → positive or negative response payload, or null for silence. */
  handleKwp(d: Uint8Array): number[] | null {
    const sid = d[0];
    switch (sid) {
      case 0x1a: // ReadEcuIdentification (0x90: vehicle identification number)
        if (d[1] === 0x90 && this.vin) return [0x5a, 0x90, ...ascii(this.vin)];
        return [0x5a, d[1] ?? 0x80, ...this.identData];
      case 0xa2: // BMW identification used by the D_0012 group to pick the variant
        return [0xe2, ...this.hardwareIdent()];
      case 0x18: // ReadDiagnosticTroubleCodesByStatus
        return [0x58, this.dtcs.length, ...this.dtcs.flatMap((e) => [e.code >> 8, e.code & 0xff, e.status])];
      case 0x17: {
        // ReadStatusOfDiagnosticTroubleCodes (one fault, with its environment)
        const code = ((d[1] ?? 0) << 8) | (d[2] ?? 0);
        const e = this.dtcs.find((x) => x.code === code);
        if (!e) return [0x57, 0x00];
        return [0x57, 0x01, code >> 8, code & 0xff, e.status, ...this.environment()];
      }
      case 0x14: // ClearDiagnosticInformation
        this.dtcs = [];
        return [0x54, d[1] ?? 0xff, d[2] ?? 0xff];
      case 0x21: // ReadDataByLocalIdentifier
      case 0x22: // ReadDataByCommonIdentifier
        return [sid + 0x40, ...d.slice(1), ...this.values(sid, [...d.slice(1)])];
      case 0x30: // InputOutputControl (actuator tests)
      case 0x31: // StartRoutine
      case 0x3e: // TesterPresent
      case 0x10: // StartDiagnosticSession
      case 0x20: // StopDiagnosticSession
        return [sid + 0x40, ...d.slice(1, 3)];
      default:
        return [0x7f, sid, 0x11]; // service not supported
    }
  }
  protected hardwareIdent(): number[] {
    return ascii('0000000').concat(new Array(17).fill(0x30));
  }
  protected environment(): number[] {
    return new Array(24).fill(0);
  }
  protected values(_sid: number, _id: number[]): number[] {
    return new Array(48).fill(0);
  }
}

/** MS45 DME: variant resolved by the D_0012 group from the hardware number 4462741 (its own HW7 table). */
export class Ms45 extends KwpEcu {
  vin = 'SM00001'; // short VIN (2 letters + 5 digits), as C_FG_LESEN returns it
  constructor(readonly drive: DriveCycle) {
    // ident 1A 80: 3 ASCII + 3 BCD (part number), HW, coding index, diag index, variant index, date (BCD yyyy mm dd), …, 4×SW
    super(0x12, 'DME MS45.0', 'kwp2000s', [
      ...ascii('007'), 0x54, 0x51, 0x50, 0x07, 0x05, 0x00, 0x12, 0x00, 0x03, 0x20, 0x04, 0x03, 0x15,
      ...new Array(14).fill(0), 40, 0, 1, 41, 0, 1, 42, 0, 1, 43, 0, 1,
    ], [
      { code: 0x2718, status: 0x44 },
      { code: 0x271a, status: 0x25 },
    ]);
  }
  protected hardwareIdent() {
    return ascii('4462741').concat(ascii('00000000000000000'));
  }
  protected environment() {
    const e = this.drive.state();
    return [0x00, 0x2a, 0x94, u8(e.rpm / 32), u8(e.clt + 48), u8(e.speed), u8(e.ubatt * 10), ...new Array(17).fill(0)];
  }
  /** Measured values: a few bytes follow the drive model so live data moves; the rest stays constant. */
  protected values(_sid: number, _id: number[]) {
    const e = this.drive.state();
    const rpm = Math.round(e.rpm);
    const b = new Array(48).fill(0x40);
    b[0] = u8(e.inj * 10);
    b[1] = u8(e.pedal * 2.55);
    b[2] = rpm >> 8;
    b[3] = rpm & 0xff;
    b[4] = u8(e.clt + 48);
    b[5] = u8(e.iat + 48);
    b[6] = u8(e.speed);
    b[7] = u8(e.ubatt * 10);
    return b;
  }
}

/** MRS5 airbag: BMW-FAST at 0x01 (its SGBD) and KWP2000* at 0x58 (how the D_00A4 group finds it). */
export class Mrs5 extends KwpEcu {
  constructor(address = 0x01, protocol: 'kwp2000s' | 'bmwfast' = 'bmwfast') {
    super(address, 'Airbag MRS5', protocol, [...ascii('691'), 0x03, 0x10, 0x00, 0x05, 0x01, 0x00, 0x05, 0x00, 0x01, 0x20, 0x11, 0x02, 0x08, ...new Array(14).fill(0), 10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [{ code: 0x9354, status: 0x24 }]);
  }
}
