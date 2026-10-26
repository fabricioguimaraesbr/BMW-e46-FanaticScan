// BEST/2 opcode implementations.

import type { Ediabas } from './Ediabas';
import { ResultType } from './results';
import { EdiabasError, ErrorCodes, TRAP_BITS } from './errors';
import { AddrMode, F64, Operand, Register, valueMask } from './vmtypes';
import { decode, encode } from '../util/cp1252';
import { dotnetDoubleToString, doubleToS, doubleToU32, hexToByteArray, s16, s32, s8, stringToFloat, stringToValue } from '../util/numbers';

type OpFn = (e: Ediabas, a0: Operand, a1: Operand) => void | Promise<void>;
export interface OpDef {
  name: string;
  fn: OpFn | null;
  nearAddr: boolean;
}

const EMPTY = new Uint8Array(0);

function needReg(a: Operand, op: string) {
  if (!a.isRegister) throw new Error(`${op}: invalid type`);
}
const argsLen = (a0: Operand) => a0.dataLen(true);

function signedOf(v: number, len: number) {
  return len === 1 ? s8(v) : len === 2 ? s16(v) : s32(v);
}

// ------------------------------------------------------------------ arithmetic / logic
const opMove: OpFn = (e, a0, a1) => {
  needReg(a0, 'move');
  if (!a0.isArrayType()) {
    const len = argsLen(a0);
    const v = a1.getValue(len);
    a0.setRaw(v);
    e.flags.carry = false;
    e.flags.overflow = false;
    e.flags.update(v, len);
  } else if (!a1.isArrayType()) {
    const len = argsLen(a0);
    const v = a1.getValue(len);
    a0.setRaw(v);
    e.flags.carry = false;
    e.flags.overflow = false;
    e.flags.update(v, 1);
  } else {
    const src = a1.getRaw();
    if (a0.mode === AddrMode.RegS && src instanceof Uint8Array) {
      let dest = a0.getArray();
      if (dest.length < src.length) {
        const n = new Uint8Array(src.length);
        n.set(dest);
        dest = n;
      } else dest = dest.slice();
      dest.set(src, 0);
      a0.setRaw(dest);
    } else {
      a0.setRaw(a1.getRaw());
    }
    e.flags.carry = false;
    e.flags.zero = false;
    e.flags.sign = false;
    e.flags.overflow = false;
  }
};

const opClear: OpFn = (e, a0) => {
  const r = a0.reg;
  if (r.isArray()) r.clear(e);
  else if (r.isFloat()) r.setFloat(e, 0);
  else r.setValue(e, 0);
  e.flags.carry = false;
  e.flags.zero = true;
  e.flags.sign = false;
  e.flags.overflow = false;
};

function addOp(e: Ediabas, a0: Operand, a1: Operand, withCarry: boolean) {
  needReg(a0, 'add');
  const len = argsLen(a0);
  const v0 = a0.getValue(len);
  let v1 = a1.getValue(len);
  if (withCarry && e.flags.carry) v1 = (v1 + 1) >>> 0;
  const sum = v0 + v1;
  const r = sum >>> 0;
  a0.setRaw(r);
  e.flags.update(r, len);
  e.flags.setOverflow(v0, v1, r, len);
  e.flags.setCarry(sum, len);
}

function subOp(e: Ediabas, a0: Operand, a1: Operand, withCarry: boolean, store: boolean) {
  const len = argsLen(a0);
  const v0 = a0.getValue(len);
  let v1 = a1.getValue(len);
  if (withCarry && e.flags.carry) v1 = (v1 + 1) >>> 0;
  const diff = v0 - v1; // may be negative (two's complement semantics via floor-mod in setCarry)
  const r = diff >>> 0;
  if (store) a0.setRaw(r);
  e.flags.update(r, len);
  e.flags.setOverflow(v0, (-v1) >>> 0, r, len);
  e.flags.setCarry(diff, len);
}

function bitOp(e: Ediabas, a0: Operand, a1: Operand, f: (x: number, y: number) => number, store = true) {
  if (store) needReg(a0, 'bitop');
  const len = argsLen(a0);
  const v = f(a0.getValue(len), a1.getValue(len)) >>> 0;
  if (store) a0.setRaw(v);
  e.flags.overflow = false;
  e.flags.update(v, len);
}

const opMult: OpFn = (e, a0, a1) => {
  needReg(a0, 'mult');
  const len = argsLen(a0);
  const v1 = signedOf(a0.getValue(len), len);
  const v2 = signedOf(a1.getValue(len), len);
  let result: number;
  if (len === 4) result = Number(BigInt.asUintN(32, BigInt(v1) * BigInt(v2)));
  else result = (v1 * v2) >>> 0;
  a0.setRaw(result);
  e.flags.overflow = false;
  e.flags.update(result, len);
  if (a1.isRegister) {
    // high part: ((UInt64)result >> (len*8)) of the 32-bit result
    const high = len === 4 ? 0 : (result >>> (len << 3)) >>> 0;
    a1.setRaw(high, len);
  }
};

const opDivs: OpFn = (e, a0, a1) => {
  needReg(a0, 'divs');
  const len = argsLen(a0);
  const v1 = a0.getValue(len);
  const v2 = a1.getValue(len);
  let result = 0;
  let remainder = 0;
  let error = false;
  const d1 = s32(v1);
  const d2 = s32(v2);
  if (d2 === 0 || (d1 === -2147483648 && d2 === -1)) {
    error = true;
    e.raiseError(ErrorCodes.BIP_0007);
  } else {
    result = Math.trunc(d1 / d2) >>> 0;
    remainder = (d1 % d2) >>> 0;
  }
  e.flags.overflow = false;
  e.flags.update(result, len);
  if (error) result = a0.getValue(len);
  a0.setRaw(result);
  if (a1.isRegister) a1.setRaw(remainder, len);
};

function shiftOp(e: Ediabas, a0: Operand, a1: Operand, kind: 'asl' | 'lsl' | 'lsr' | 'asr') {
  needReg(a0, kind);
  const len = argsLen(a0);
  let value = a0.getValue(len);
  const shift = s32(a1.getValue(len));
  const bits = len * 8;
  if (shift < 0) {
    // don't touch carry
  } else if (shift === 0) {
    e.flags.carry = false;
  } else if (kind === 'asl' || kind === 'lsl') {
    if (shift > bits) e.flags.carry = false;
    else {
      const carryShift = bits - shift;
      const mask = carryShift >= 32 ? 0 : (1 << carryShift) >>> 0;
      e.flags.carry = ((value & mask) >>> 0) !== 0;
    }
    value = shift >= bits ? 0 : (value << shift) >>> 0;
  } else if (kind === 'lsr') {
    if (shift > bits) e.flags.carry = false;
    else {
      const mask = (1 << (shift - 1)) >>> 0;
      e.flags.carry = ((value & mask) >>> 0) !== 0;
    }
    value = shift >= bits ? 0 : value >>> shift;
  } else {
    const signMask = (1 << (bits - 1)) >>> 0;
    if (shift > bits) e.flags.carry = ((value & signMask) >>> 0) !== 0;
    else {
      const mask = (1 << (shift - 1)) >>> 0;
      e.flags.carry = ((value & mask) >>> 0) !== 0;
    }
    if (shift >= bits) value = ((value & signMask) >>> 0) !== 0 ? 0xffffffff : 0;
    else value = (signedOf(value, len) >> shift) >>> 0;
  }
  a0.setRaw(value >>> 0);
  e.flags.overflow = false;
  e.flags.update(value >>> 0, len);
}

const opNot: OpFn = (e, a0) => {
  needReg(a0, 'not');
  a0.setRaw(~a0.getValue() >>> 0);
  e.flags.overflow = false;
  e.flags.update(a0.getValue(), a0.dataLen());
};

// ------------------------------------------------------------------ jumps
const jumpIf = (cond: (e: Ediabas) => boolean): OpFn => (e, a0) => {
  if (cond(e)) e.pc = a0.getValue();
};

function trapDetected(e: Ediabas, a1: Operand, jt: boolean): boolean {
  if (a1.mode !== AddrMode.None) {
    const bit = a1.getValue(1);
    if (bit > 0) return e.errorTrapBitNr === bit || (e.errorTrapBitNr === 0 && bit === 32);
    return e.errorTrapBitNr >= 0x40000000;
  }
  return jt ? e.errorTrapBitNr >= 0 : e.errorTrapBitNr >= 0x40000000;
}

// ------------------------------------------------------------------ stack
const opPush: OpFn = (e, a0) => {
  let v = a0.getValue();
  const len = a0.dataLen();
  for (let i = 0; i < len; i++) {
    e.stack.push(v & 0xff);
    v >>>= 8;
  }
};
const opPop: OpFn = (e, a0) => {
  needReg(a0, 'pop');
  if (a0.isArrayType()) throw new Error('pop: invalid data type');
  const len = a0.dataLen();
  let v = 0;
  if (e.stack.length < len) e.setError(ErrorCodes.BIP_0005);
  else for (let i = 0; i < len; i++) v = ((v << 8) | e.stack.pop()!) >>> 0;
  a0.setRaw(v >>> 0);
  e.flags.overflow = false;
  e.flags.update(v, len);
};
const opPushf: OpFn = (e) => {
  let v = e.flags.toValue();
  for (let i = 0; i < 4; i++) {
    e.stack.push(v & 0xff);
    v >>>= 8;
  }
};
const opPopf: OpFn = (e) => {
  let v = 0;
  if (e.stack.length < 4) e.setError(ErrorCodes.BIP_0005);
  else for (let i = 0; i < 4; i++) v = ((v << 8) | e.stack.pop()!) >>> 0;
  e.flags.fromValue(v);
};
const opAtsp: OpFn = (e, a0, a1) => {
  needReg(a0, 'atsp');
  if (a0.isArrayType()) throw new Error('atsp: invalid data type');
  let v = 0;
  const len = a0.dataLen();
  const pos = a1.getValue();
  if (e.stack.length < len) e.setError(ErrorCodes.BIP_0005);
  else {
    const arr = e.stack.slice().reverse(); // C# Stack.ToArray(): top first
    let index = pos - len;
    if (index < 0) throw new Error('atsp: invalid stack index');
    for (let i = 0; i < len; i++) v = ((v << 8) | arr[index++]) >>> 0;
  }
  a0.setRaw(v >>> 0);
  e.flags.update(v, len);
};

// ------------------------------------------------------------------ strings / arrays
const opScmp: OpFn = (e, a0, a1) => {
  const d1 = a0.getArray();
  const d2 = a1.getArray();
  e.flags.zero = d1.length === d2.length && d1.every((b, i) => b === d2[i]);
};
const opScat: OpFn = (e, a0, a1) => {
  needReg(a0, 'scat');
  const d1 = a0.getArray();
  const d2 = a1.getArray();
  const r = new Uint8Array(d1.length + d2.length);
  r.set(d1);
  r.set(d2, d1.length);
  if (r.length > e.arrayMaxSize) {
    e.setError(ErrorCodes.BIP_0001);
    return;
  }
  a0.setRaw(r);
};
const opScut: OpFn = (e, a0, a1) => {
  needReg(a0, 'scut');
  const d = a0.getArray();
  const len = a1.getValue();
  if (len > d.length) a0.setArray(EMPTY);
  else a0.setArray(d.slice(0, d.length - len));
};
const opSlen: OpFn = (e, a0, a1) => {
  needReg(a0, 'slen');
  a0.setRaw(a1.dataLen() >>> 0);
  e.flags.overflow = false;
  e.flags.update(a0.getValue(), a0.dataLen());
};
function idxStart(e: Ediabas, a0: Operand, op: string): number {
  switch (a0.mode) {
    case AddrMode.IdxImm:
      return a0.d2 as number;
    case AddrMode.IdxReg:
      return (a0.d2 as Register).getValue(e);
    default:
      throw new Error(`${op}: invalid mode`);
  }
}
const opSpaste: OpFn = (e, a0, a1) => {
  needReg(a0, 'spaste');
  const start = idxStart(e, a0, 'spaste');
  const reg = a0.reg;
  const dest = reg.getArray(e);
  const src = a1.getArray();
  if (start >= e.arrayMaxSize) {
    e.setError(ErrorCodes.BIP_0001);
    return;
  }
  if (start < dest.length) {
    const r = new Uint8Array(dest.length + src.length);
    r.set(dest.subarray(0, start));
    r.set(src, start);
    r.set(dest.subarray(start), start + src.length);
    if (r.length > e.arrayMaxSize) {
      e.setError(ErrorCodes.BIP_0001);
      return;
    }
    reg.setArray(e, r);
  }
};
const opSerase: OpFn = (e, a0, a1) => {
  needReg(a0, 'serase');
  const start = idxStart(e, a0, 'serase');
  const reg = a0.reg;
  const d = reg.getArray(e);
  const len = a1.getValue();
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) if (i < start || i >= start + len) out.push(d[i]);
  reg.setArray(e, Uint8Array.from(out));
};
const opSrevrs: OpFn = (e, a0) => {
  needReg(a0, 'srevrs');
  a0.setArray(a0.getArray().slice().reverse());
};
const opSwap: OpFn = (e, a0) => {
  needReg(a0, 'swap');
  const reg = a0.reg;
  const d = reg.getArray(e, true).slice();
  const start = a0.d2 as number;
  const len = a0.d3 as number;
  if (start + len > e.arrayMaxSize) {
    e.setError(ErrorCodes.BIP_0001);
    return;
  }
  const part = d.slice(start, start + len).reverse();
  d.set(part, start);
  reg.setArray(e, d, true);
};
const opStrcat: OpFn = (e, a0, a1) => {
  needReg(a0, 'strcat');
  const len1 = a0.dataLen();
  const s1 = a0.getString();
  let s2 = a1.getString();
  if (len1 + s2.length > e.arrayMaxSize) s2 = s2.substring(0, Math.max(0, e.arrayMaxSize - len1));
  a0.setString(s1 + s2);
};
const opStrcmp: OpFn = (e, a0, a1) => {
  e.flags.zero = a0.getString() !== a1.getString();
};
const opStrlen: OpFn = (e, a0, a1) => {
  needReg(a0, 'strlen');
  const r = a1.getString().length;
  a0.setRaw(r);
  e.flags.overflow = false;
  e.flags.update(r, a0.dataLen());
};
const opSsize: OpFn = (e, a0) => {
  needReg(a0, 'ssize');
  a0.setRaw(e.arrayMaxBufSize >>> 0);
};
const opSetspc: OpFn = (e, a0, a1) => {
  e.tokenSeparator = a0.getString();
  e.tokenIndex = a1.getValue();
};
const opStoken: OpFn = (e, a0, a1) => {
  needReg(a0, 'stoken');
  if (e.tokenSeparator.length === 0) {
    e.flags.zero = true;
    return;
  }
  const seps = e.tokenSeparator.split('');
  const s = a1.getString();
  const words: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (seps.includes(ch)) {
      words.push(cur);
      cur = '';
    } else cur += ch;
  }
  words.push(cur);
  if (e.tokenIndex < 1 || e.tokenIndex > words.length) e.flags.zero = true;
  else {
    a0.setString(words[e.tokenIndex - 1]);
    e.flags.zero = false;
  }
};

// ------------------------------------------------------------------ conversions
const opA2Fix: OpFn = (e, a0, a1) => {
  needReg(a0, 'a2fix');
  let v = stringToValue(a1.getString()).value;
  if (v < -2147483648) v = -2147483648;
  if (v > 2147483647) v = 0xffffffff;
  a0.setRaw(v >>> 0);
  e.flags.zero = false;
  e.flags.sign = false;
  e.flags.overflow = false;
};
const opA2Flt: OpFn = (e, a0, a1) => {
  needReg(a0, 'a2flt');
  const { value, valid } = stringToFloat(a1.getString());
  if (!valid) {
    const compat = stringToValue(e.getConfig('CompatMode') ?? '0').value;
    if (compat === 0) e.raiseError(ErrorCodes.BIP_0011);
  }
  a0.setRaw(new F64(value));
};
const opA2Y: OpFn = (e, a0, a1) => {
  needReg(a0, 'a2y');
  const out: number[] = [];
  let s = a1.getString();
  if (s.length > 0) {
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      const c = lower[i];
      if (!(/[0-9a-f]/.test(c) || c === ' ' || c === ';' || c === ',')) {
        s = s.substring(0, i);
        break;
      }
    }
    let exit = false;
    for (const part of s.split(/[,;]/)) {
      if (part.trim().length === 0) {
        for (let i = 0; i < part.length + 1; i++) out.push(0);
      } else {
        for (const sub of part.trim().split(' ')) {
          if (sub.length > 0) {
            if (!/^[0-9a-fA-F]{1,2}$/.test(sub)) {
              exit = true;
              break;
            }
            out.push(parseInt(sub, 16));
          }
        }
      }
      if (exit) break;
    }
  }
  a0.setArray(Uint8Array.from(out));
};
const opHex2Y: OpFn = (e, a0, a1) => {
  needReg(a0, 'hex2y');
  const r = hexToByteArray(a1.getString());
  e.flags.carry = false;
  a0.setArray(r);
};
const intFmt = (signed: boolean): OpFn => (e, a0, a1) => {
  needReg(a0, 'fix2dez');
  const len = a1.isArrayType() ? 1 : a1.dataLen();
  const v = a1.getValue(len);
  let r: number;
  if (signed) r = signedOf(v, len);
  else r = len === 1 ? v & 0xff : len === 2 ? v & 0xffff : v >>> 0;
  a0.setString(String(r));
};
const opFix2Hex: OpFn = (e, a0, a1) => {
  needReg(a0, 'fix2hex');
  const len = a1.isArrayType() ? 1 : a1.dataLen();
  const v = a1.getValue(len);
  a0.setString('0x' + v.toString(16).toUpperCase().padStart(len * 2, '0'));
};
const opFix2Flt: OpFn = (e, a0, a1) => {
  needReg(a0, 'fix2flt');
  const v = a1.getValue();
  const len = a1.dataLen();
  if (len !== 1 && len !== 2 && len !== 4) throw new Error('fix2flt: invalid length');
  a0.setRaw(new F64(signedOf(v, len)));
};
function roundSignificant(value: number, digits: number): number {
  if (value === 0) return 0;
  const scale = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) + 1);
  // Math.Round(x, digits) — banker's rounding (MidpointRounding.ToEven)
  const x = value / scale;
  const f = Math.pow(10, digits);
  let y = x * f;
  const fl = Math.floor(y);
  const diff = y - fl;
  if (Math.abs(diff - 0.5) < 1e-12) y = fl % 2 === 0 ? fl : fl + 1;
  else y = Math.round(y);
  return scale * (y / f);
}
const opFlt2A: OpFn = (e, a0, a1) => {
  needReg(a0, 'flt2a');
  const v = a1.getFloat();
  const conv = roundSignificant(v, e.floatPrecision);
  let r = dotnetDoubleToString(conv);
  let digits = 0;
  for (let pos = 0; pos < r.length; pos++) {
    if (/[0-9]/.test(r[pos])) {
      digits++;
      if (digits >= e.floatPrecision) {
        r = r.substring(0, pos + 1);
        break;
      }
    }
  }
  a0.setString(r);
};
const opFlt2Fix: OpFn = (e, a0, a1) => {
  needReg(a0, 'flt2fix');
  const r = doubleToU32(a1.getFloat());
  a0.setRaw(r);
  e.flags.overflow = false;
  e.flags.update(r, 4);
};
const opFlt2Y = (bytes: 4 | 8): OpFn => (e, a0, a1) => {
  needReg(a0, 'flt2y');
  const reg = a0.reg;
  let dest = reg.getArray(e);
  const start = a0.d2 as number;
  if (start + bytes > e.arrayMaxSize) {
    e.setError(ErrorCodes.BIP_0001);
    return;
  }
  if (dest.length < start + bytes) {
    const n = new Uint8Array(start + bytes);
    n.set(dest);
    dest = n;
  } else dest = dest.slice();
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  if (bytes === 4) dv.setFloat32(0, a1.getFloat(), true);
  else dv.setFloat64(0, a1.getFloat(), true);
  dest.set(new Uint8Array(buf, 0, bytes), start);
  reg.setArray(e, dest);
};
const opY2Flt = (bytes: 4 | 8): OpFn => (e, a0, a1) => {
  needReg(a0, 'y2flt');
  const d = a1.getArray();
  const buf = new Uint8Array(8);
  buf.set(d.subarray(0, Math.min(bytes, d.length)));
  if (d.length < bytes) throw new Error('y2flt: data too short');
  const dv = new DataView(buf.buffer);
  a0.setRaw(new F64(bytes === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true)));
};
const opY2Bcd: OpFn = (e, a0, a1) => {
  needReg(a0, 'y2bcd');
  let r = '';
  for (const b of a1.getArray()) {
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    r += (hi > 9 ? '*' : hi.toString(16).toUpperCase()) + (lo > 9 ? '*' : lo.toString(16).toUpperCase());
  }
  a0.setString(r);
};
const opY2Hex: OpFn = (e, a0, a1) => {
  needReg(a0, 'y2hex');
  a0.setString(Array.from(a1.getArray(), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
};

// ------------------------------------------------------------------ float arithmetic
const fArith = (f: (a: number, b: number) => number): OpFn => (e, a0, a1) => {
  needReg(a0, 'farith');
  const r = f(a0.getFloat(), a1.getFloat());
  if (!Number.isFinite(r)) e.setError(ErrorCodes.BIP_0011);
  a0.setRaw(new F64(Number.isFinite(r) ? r : 0));
};
const opFcomp: OpFn = (e, a0, a1) => {
  const v0 = a0.getFloat();
  const v1 = a1.getFloat();
  if (!Number.isFinite(v0 - v1)) e.flags.carry = true;
  e.flags.zero = v0 === v1;
  e.flags.sign = v0 < v1;
  e.flags.overflow = false;
};

// ------------------------------------------------------------------ results
const erg = (type: ResultType, conv: (a1: Operand) => number | string | Uint8Array): OpFn => (e, a0, a1) => {
  e.setResult({ type, name: a0.getString(), value: conv(a1) });
};

// ------------------------------------------------------------------ parameters
const opParl: OpFn = (e, a0, a1) => {
  needReg(a0, 'parl');
  let r = 0;
  e.flags.zero = true;
  e.flags.carry = false;
  e.flags.sign = false;
  e.flags.overflow = false;
  const pos = (a1.getValue() - 1) >>> 0;
  const args = e.activeArgStrings();
  if (pos < args.length) {
    const s = args[pos];
    if (s) {
      r = stringToValue(s).value >>> 0;
      e.flags.zero = false;
    }
  }
  a0.setRaw(r >>> 0);
};
const opParr: OpFn = (e, a0, a1) => {
  needReg(a0, 'parr');
  let r = 0;
  e.flags.zero = true;
  e.flags.carry = false;
  e.flags.sign = false;
  e.flags.overflow = false;
  const pos = (a1.getValue() - 1) >>> 0;
  const args = e.activeArgStrings();
  if (pos < args.length && args[pos]) {
    r = stringToFloat(args[pos]).value;
    e.flags.zero = false;
  }
  a0.setRaw(new F64(r));
};
const opPars: OpFn = (e, a0, a1) => {
  needReg(a0, 'pars');
  let r = '';
  e.flags.zero = true;
  const pos = (a1.getValue() - 1) >>> 0;
  const args = e.activeArgStrings();
  if (pos < args.length && args[pos]) {
    r = args[pos];
    e.flags.zero = false;
  }
  a0.setString(r);
};
const opPary: OpFn = (e, a0) => {
  needReg(a0, 'pary');
  e.flags.zero = true;
  const bin = e.activeArgBinary();
  if (bin.length > 0) e.flags.zero = false;
  a0.setArray(bin.length > 0 ? bin : EMPTY);
};
const opParn: OpFn = (e, a0) => {
  needReg(a0, 'parn');
  a0.setRaw(e.activeArgStrings().length >>> 0);
  e.flags.overflow = false;
  e.flags.update(a0.getValue(), a0.dataLen());
};

// ------------------------------------------------------------------ tables
const opTabset: OpFn = (e, a0) => {
  const lastIdx = e.tableIndex;
  const lastRow = e.tableRowIndex;
  e.closeTable();
  if (e.sgbdBase) e.setTableFile(e.sgbdBase);
  let { idx, found } = e.tableGetIndex(e.getTableFile(), a0.getString());
  if (!found && e.sgbdBase) {
    e.closeTable();
    ({ idx, found } = e.tableGetIndex(e.getTableFile(), a0.getString()));
  }
  if (!found) e.setError(ErrorCodes.BIP_0010);
  e.tableIndex = idx;
  e.tableRowIndex = -1;
  if (e.tableIndex === lastIdx) e.tableRowIndex = lastRow;
};
const opTabsetex: OpFn = async (e, a0, a1) => {
  const lastIdx = e.tableIndex;
  const lastRow = e.tableRowIndex;
  const base = a1.getString();
  if (base.length > 0) {
    const f = await e.findTableFileExt(base);
    if (!f) {
      e.setError(ErrorCodes.SYS_0002);
      return;
    }
    e.closeTable();
    e.setTableFile(f);
  }
  const { idx, found } = e.tableGetIndex(e.getTableFile(), a0.getString());
  if (!found) e.setError(ErrorCodes.BIP_0010);
  e.tableIndex = idx;
  e.tableRowIndex = -1;
  if (e.tableIndex === lastIdx) e.tableRowIndex = lastRow;
};
const opTabseek: OpFn = (e, a0, a1) => {
  if (e.tableIndex < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  const { row, found } = e.tableSeekString(e.getTableFile(), e.tableIndex, a0.getString(), a1.getString());
  if (row < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  e.tableRowIndex = row;
  e.flags.zero = !found;
};
const opTabseeku: OpFn = (e, a0, a1) => {
  if (e.tableIndex < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  const { row, found } = e.tableSeekValue(e.getTableFile(), e.tableIndex, a0.getString(), a1.getValue());
  if (row < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  e.tableRowIndex = row;
  e.flags.zero = !found;
};
const opTabline: OpFn = (e, a0) => {
  if (e.tableIndex < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  const { row, found } = e.tableLine(e.getTableFile(), e.tableIndex, a0.getValue());
  if (row < 0) e.setError(ErrorCodes.BIP_0010);
  e.tableRowIndex = row;
  e.flags.zero = !found;
};
const opTabget: OpFn = (e, a0, a1) => {
  if (e.tableIndex < 0) {
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  const { entry, columnInvalid } = e.tableEntry(e.getTableFile(), e.tableIndex, e.tableRowIndex, a1.getString());
  if (entry === null) {
    if (e.tableRowIndex < 0 && !columnInvalid) {
      a0.setString('');
      return;
    }
    e.setError(ErrorCodes.BIP_0010);
    return;
  }
  a0.setString(entry);
};
const opTabcols: OpFn = (e, a0) => {
  a0.setRaw(e.tableIndex < 0 ? 0 : e.tableColumns(e.getTableFile(), e.tableIndex) >>> 0);
};
const opTabrows: OpFn = (e, a0) => {
  a0.setRaw(e.tableIndex < 0 ? 0 : (e.tableRows(e.getTableFile(), e.tableIndex) + 1) >>> 0);
};

// ------------------------------------------------------------------ interface (IFH) operations
function ifc(e: Ediabas, needConnected = true) {
  const i = e.iface;
  if (!i || (needConnected && !i.connected)) {
    e.setError(ErrorCodes.IFH_0056);
    return null;
  }
  return i;
}

const opXconnect: OpFn = async (e) => {
  if (!e.iface) throw new Error('xconnect: no communication class present');
  if (!(await e.iface.connect())) e.setError(ErrorCodes.IFH_0018);
};
const opXhangup: OpFn = async (e) => {
  if (!e.iface) throw new Error('xhangup: no communication class present');
  await e.iface.disconnect();
};
const opXsetpar: OpFn = async (e, a0) => {
  const i = ifc(e);
  if (!i) return;
  const d = a0.getArray();
  let typeLen = 0;
  if (d.length >= 2) typeLen = d[1] === 0x00 ? 2 : d[1] === 0x01 ? 4 : d[1] === 0xff ? 1 : 0;
  const pars: number[] = [];
  if (typeLen > 0 && d.length % typeLen === 0) {
    for (let o = 0; o < d.length; o += typeLen) {
      let v = d[o];
      if (typeLen >= 2) v |= d[o + 1] << 8;
      if (typeLen >= 4) v |= (d[o + 2] << 16) | (d[o + 3] << 24);
      pars.push(v >>> 0);
    }
  }
  if (e.logLevel >= 1) e.log(`xsetpar: ${pars.map((p) => p.toString(16)).join(' ')}`);
  await i.setCommParameter(pars);
};
const opXawlen: OpFn = (e, a0) => {
  const i = ifc(e);
  if (!i) return;
  const d = a0.getArray();
  if (d.length & 1) throw new Error('xawlen: invalid data length');
  const ans: number[] = [];
  for (let o = 0; o < d.length; o += 2) ans.push(s16(d[o] | (d[o + 1] << 8)));
  i.setCommAnswerLen(ans);
};
const opXsend: OpFn = async (e, a0, a1) => {
  needReg(a0, 'xsend');
  const i = ifc(e);
  if (!i) return;
  const resp = await i.transmitData(a1.getArray());
  if (resp) a0.setRaw(resp);
};
const opXsendf: OpFn = async (e, a0) => {
  const i = ifc(e);
  if (!i) return;
  await i.transmitFrequent(a0.getArray());
};
const opXrequf: OpFn = async (e, a0) => {
  needReg(a0, 'xrequf');
  const i = ifc(e);
  if (!i) return;
  const r = await i.receiveFrequent();
  if (r) a0.setRaw(r);
};
const opXstopf: OpFn = async (e) => {
  const i = ifc(e);
  if (i) await i.stopFrequent();
};
const opXkeyb: OpFn = async (e, a0) => {
  needReg(a0, 'xkeyb');
  const i = ifc(e, false);
  if (!i) return;
  const k = await i.getKeyBytes();
  if (k) a0.setRaw(k);
};
const opXstate: OpFn = async (e, a0) => {
  needReg(a0, 'xstate');
  const i = ifc(e, false);
  if (!i) return;
  const s = await i.getState();
  if (s) a0.setRaw(s);
};
const opXboot: OpFn = async (e) => {
  const i = ifc(e, false);
  if (i) await i.boot();
};
const opXreset: OpFn = async (e) => {
  const i = ifc(e, false);
  if (i) await i.reset();
};
const opXtype: OpFn = (e, a0) => {
  needReg(a0, 'xtype');
  const i = ifc(e);
  if (i) a0.setString(i.interfaceType);
};
const opXvers: OpFn = (e, a0) => {
  needReg(a0, 'xvers');
  const i = ifc(e);
  if (i) a0.setRaw(i.interfaceVersion >>> 0);
};
const opXbatt: OpFn = async (e, a0) => {
  needReg(a0, 'xbatt');
  const i = ifc(e, false);
  if (!i) return;
  const v = await i.getBatteryVoltage();
  if (v !== null) a0.setRaw(v >>> 0);
};
const opXignit: OpFn = async (e, a0) => {
  needReg(a0, 'xignit');
  const i = ifc(e, false);
  if (!i) return;
  const v = await i.getIgnitionVoltage();
  if (v !== null) a0.setRaw(v >>> 0);
};
const opXgetport: OpFn = (e, a0, a1) => {
  needReg(a0, 'xgetport');
  const i = ifc(e, false);
  if (i) a0.setRaw(i.getPort(a1.getValue() & 0xff) >>> 0);
};
const opXsetport: OpFn = (e, a0, a1) => {
  const i = ifc(e, false);
  if (!i) return;
  const d = a0.getArray();
  i.setPort(d.length >= 1 ? d[0] : 0, a1.getValue());
};
const opXloopt: OpFn = (e, a0) => {
  needReg(a0, 'xloopt');
  const i = ifc(e, false);
  if (i) a0.setRaw(i.loopTest >>> 0);
};
const opXprog: OpFn = (e, a0) => {
  const i = ifc(e, false);
  if (i) i.setProgramVoltage(a0.getValue());
};
const opXraw: OpFn = async (e, a0, a1) => {
  needReg(a0, 'xraw');
  const i = ifc(e);
  if (!i) return;
  const r = await i.rawData(a1.getArray());
  if (r) a0.setRaw(r);
};
const opXreps: OpFn = (e, a0) => {
  const i = ifc(e);
  if (i) i.commRepeats = a0.getValue();
};
const opXsireset: OpFn = (e, a0) => {
  const i = ifc(e, false);
  if (i) i.switchSiRelais(a0.getValue());
};

// ------------------------------------------------------------------ misc
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const opEoj: OpFn = (e, a0) => {
  if (a0.mode !== AddrMode.None) e.resultJobStatus = a0.getString();
  e.jobEnd = true;
};
const opEtag: OpFn = (e, a0, a1) => {
  if (e.resultsRequest.size > 0 && !e.resultsRequest.has(a1.getString().toUpperCase())) e.pc = a0.getValue();
};
const opEnewset: OpFn = (e) => {
  if (e.resultDict.size > 0) {
    e.resultSetsTemp.push(new Map(e.resultDict));
    e.resultDict.clear();
  }
};
const opEerr: OpFn = (e) => {
  if (e.errorTrapBitNr >= 0) {
    for (const [code, bit] of TRAP_BITS) if (bit === e.errorTrapBitNr) e.raiseError(code);
    e.raiseError(ErrorCodes.BIP_0000);
  }
};
const opErgsysi: OpFn = (e, a0, a1) => {
  const data = a0.getString();
  const v = a1.getValue(2);
  if (data === '!INITIALISIERUNG') {
    if (v !== 0) e.requestInit = true;
  } else e.setSysResult({ type: ResultType.I, name: data, value: v });
};
const opGenerr: OpFn = (e, a0) => {
  const code = a0.getValue();
  if (code < ErrorCodes.RUN_0000 || code > ErrorCodes.ERROR_LAST) e.raiseError(ErrorCodes.BIP_0001);
  e.raiseError(code);
};
const opDate: OpFn = (e, a0) => {
  needReg(a0, 'date');
  const now = new Date();
  const d = new Uint8Array(5);
  d[0] = now.getDate();
  d[1] = now.getMonth() + 1;
  d[2] = now.getFullYear() % 100;
  d[3] = isoWeek(now);
  d[4] = now.getDay() === 0 ? 7 : now.getDay();
  a0.setArray(d);
};
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
const opTime: OpFn = (e, a0) => {
  needReg(a0, 'time');
  const n = new Date();
  a0.setArray(Uint8Array.from([n.getHours(), n.getMinutes(), n.getSeconds()]));
};
const opTicks: OpFn = (e, a0) => {
  needReg(a0, 'ticks');
  a0.setRaw((Math.floor(performance.now()) >>> 0));
};
const opWait: OpFn = async (e, a0) => sleep(a0.getValue() * 1000);
const opWaitex: OpFn = async (e, a0) => sleep(a0.getValue());
const opSett: OpFn = (e, a0) => {
  let err = a0.getValue();
  if (err === 0) err = 0x40000000;
  e.errorTrapBitNr = err;
};
const opGettmr: OpFn = (e, a0) => {
  needReg(a0, 'gettmr');
  a0.setRaw(e.errorTrapMask >>> 0);
  e.flags.update(a0.getValue(), a0.dataLen());
};
const opCfgig: OpFn = (e, a0, a1) => {
  needReg(a0, 'cfgig');
  const v = e.getConfig(a1.getString());
  if (v !== null) a0.setRaw(stringToValue(v).value >>> 0);
};
const opCfgsg: OpFn = (e, a0, a1) => {
  needReg(a0, 'cfgsg');
  const v = e.getConfig(a1.getString());
  if (v !== null) a0.setArray(encode(v));
};
const opCfgis: OpFn = (e, a0, a1) => {
  e.setConfig(a0.getString(), String(a1.getValue()));
};
const opShmset: OpFn = (e, a0, a1) => e.sharedSet(a0.getString(), a1.getArray());
const opShmget: OpFn = (e, a0, a1) => {
  needReg(a0, 'shmget');
  const d = e.sharedGet(a1.getString());
  e.flags.carry = !d;
  a0.setArray(d ?? EMPTY);
};
const opIupdate: OpFn = (e, a0) => {
  e.infoProgressText = a0.getString();
  e.progressInform();
};
const opIrange: OpFn = (e, a0) => {
  e.infoProgressPos = -1;
  e.infoProgressRange = a0.getValue();
  e.progressInform();
};
const opIincpos: OpFn = (e, a0) => {
  const inc = a0.getValue();
  let n = e.infoProgressPos < 0 ? inc : e.infoProgressPos + inc;
  if (n > e.infoProgressRange) n = e.infoProgressRange;
  e.infoProgressPos = n;
  e.progressInform();
};
// file operations (fopen/fread/...) are not available in the browser runtime
const opFopen: OpFn = (e, a0) => {
  needReg(a0, 'fopen');
  e.setError(ErrorCodes.BIP_0006);
  a0.setRaw(0xffffffff);
  e.flags.update(0xffffffff, 1);
};
const opFileGeneric: OpFn = (e) => e.setError(ErrorCodes.BIP_0006);
const opNop: OpFn = () => {};
const opPluginIgnore: OpFn = () => {};
const opPpop: OpFn = (e, a0) => {
  a0.setRaw(0);
  e.flags.overflow = false;
  e.flags.update(0, a0.dataLen());
};
const opPpopflt: OpFn = (e, a0) => {
  a0.setRaw(new F64(0));
  e.flags.overflow = false;
};
const opPpopy: OpFn = (e, a0) => a0.setArray(EMPTY);

const T: [number, string, OpFn | null, boolean?][] = [
  [0x00, 'move', opMove],
  [0x01, 'clear', opClear],
  [0x02, 'comp', (e, a0, a1) => subOp(e, a0, a1, false, false)],
  [0x03, 'subb', (e, a0, a1) => (needReg(a0, 'subb'), subOp(e, a0, a1, false, true))],
  [0x04, 'adds', (e, a0, a1) => addOp(e, a0, a1, false)],
  [0x05, 'mult', opMult],
  [0x06, 'divs', opDivs],
  [0x07, 'and', (e, a0, a1) => bitOp(e, a0, a1, (x, y) => x & y)],
  [0x08, 'or', (e, a0, a1) => bitOp(e, a0, a1, (x, y) => x | y)],
  [0x09, 'xor', (e, a0, a1) => bitOp(e, a0, a1, (x, y) => x ^ y)],
  [0x0a, 'not', opNot],
  [0x0b, 'jump', (e, a0) => void (e.pc = a0.getValue()), true],
  [0x0c, 'jtsr', null, true],
  [0x0d, 'ret', null],
  [0x0e, 'jc', jumpIf((e) => e.flags.carry), true],
  [0x0f, 'jae', jumpIf((e) => !e.flags.carry), true],
  [0x10, 'jz', jumpIf((e) => e.flags.zero), true],
  [0x11, 'jnz', jumpIf((e) => !e.flags.zero), true],
  [0x12, 'jv', jumpIf((e) => e.flags.overflow), true],
  [0x13, 'jnv', jumpIf((e) => !e.flags.overflow), true],
  [0x14, 'jmi', jumpIf((e) => e.flags.sign), true],
  [0x15, 'jpl', jumpIf((e) => !e.flags.sign), true],
  [0x16, 'clrc', (e) => void (e.flags.carry = false)],
  [0x17, 'setc', (e) => void (e.flags.carry = true)],
  [0x18, 'asr', (e, a0, a1) => shiftOp(e, a0, a1, 'asr')],
  [0x19, 'lsl', (e, a0, a1) => shiftOp(e, a0, a1, 'lsl')],
  [0x1a, 'lsr', (e, a0, a1) => shiftOp(e, a0, a1, 'lsr')],
  [0x1b, 'asl', (e, a0, a1) => shiftOp(e, a0, a1, 'asl')],
  [0x1c, 'nop', opNop],
  [0x1d, 'eoj', opEoj],
  [0x1e, 'push', opPush],
  [0x1f, 'pop', opPop],
  [0x20, 'scmp', opScmp],
  [0x21, 'scat', opScat],
  [0x22, 'scut', opScut],
  [0x23, 'slen', opSlen],
  [0x24, 'spaste', opSpaste],
  [0x25, 'serase', opSerase],
  [0x26, 'xconnect', opXconnect],
  [0x27, 'xhangup', opXhangup],
  [0x28, 'xsetpar', opXsetpar],
  [0x29, 'xawlen', opXawlen],
  [0x2a, 'xsend', opXsend],
  [0x2b, 'xsendf', opXsendf],
  [0x2c, 'xrequf', opXrequf],
  [0x2d, 'xstopf', opXstopf],
  [0x2e, 'xkeyb', opXkeyb],
  [0x2f, 'xstate', opXstate],
  [0x30, 'xboot', opXboot],
  [0x31, 'xreset', opXreset],
  [0x32, 'xtype', opXtype],
  [0x33, 'xvers', opXvers],
  [0x34, 'ergb', erg(ResultType.B, (a) => a.getValue(1) & 0xff)],
  [0x35, 'ergw', erg(ResultType.W, (a) => a.getValue(2) & 0xffff)],
  [0x36, 'ergd', erg(ResultType.D, (a) => a.getValue(4) >>> 0)],
  [0x37, 'ergi', erg(ResultType.I, (a) => s16(a.getValue(2)))],
  [0x38, 'ergr', erg(ResultType.R, (a) => a.getFloat())],
  [0x39, 'ergs', erg(ResultType.S, (a) => a.getString())],
  [0x3a, 'a2flt', opA2Flt],
  [0x3b, 'fadd', fArith((a, b) => a + b)],
  [0x3c, 'fsub', fArith((a, b) => a - b)],
  [0x3d, 'fmul', fArith((a, b) => a * b)],
  [0x3e, 'fdiv', fArith((a, b) => a / b)],
  [0x3f, 'ergy', erg(ResultType.Y, (a) => a.getArray().slice())],
  [0x40, 'enewset', opEnewset],
  [0x41, 'etag', opEtag, true],
  [0x42, 'xreps', opXreps],
  [0x43, 'gettmr', opGettmr],
  [0x44, 'settmr', (e, a0) => void (e.errorTrapMask = a0.getValue())],
  [0x45, 'sett', opSett],
  [0x46, 'clrt', (e) => void (e.errorTrapBitNr = -1)],
  [0x47, 'jt', (e, a0, a1) => void (trapDetected(e, a1, true) && (e.pc = a0.getValue())), true],
  [0x48, 'jnt', (e, a0, a1) => void (!trapDetected(e, a1, false) && (e.pc = a0.getValue())), true],
  [0x49, 'addc', (e, a0, a1) => addOp(e, a0, a1, true)],
  [0x4a, 'subc', (e, a0, a1) => (needReg(a0, 'subc'), subOp(e, a0, a1, true, true))],
  [0x4b, 'break', (e) => e.setError(ErrorCodes.BIP_0008)],
  [0x4c, 'clrv', (e) => void (e.flags.overflow = false)],
  [0x4d, 'eerr', opEerr],
  [0x4e, 'popf', opPopf],
  [0x4f, 'pushf', opPushf],
  [0x50, 'atsp', opAtsp],
  [0x51, 'swap', opSwap],
  [0x52, 'setspc', opSetspc],
  [0x53, 'srevrs', opSrevrs],
  [0x54, 'stoken', opStoken],
  [0x55, 'parb', opParl],
  [0x56, 'parw', opParl],
  [0x57, 'parl', opParl],
  [0x58, 'pars', opPars],
  [0x59, 'fclose', opFileGeneric],
  [0x5a, 'jg', jumpIf((e) => e.flags.sign === e.flags.overflow && !e.flags.zero), true],
  [0x5b, 'jge', jumpIf((e) => e.flags.zero || e.flags.sign === e.flags.overflow), true],
  [0x5c, 'jl', jumpIf((e) => !e.flags.zero && e.flags.sign !== e.flags.overflow), true],
  [0x5d, 'jle', jumpIf((e) => e.flags.sign !== e.flags.overflow || e.flags.zero), true],
  [0x5e, 'ja', jumpIf((e) => !e.flags.carry && !e.flags.zero), true],
  [0x5f, 'jbe', jumpIf((e) => e.flags.carry || e.flags.zero), true],
  [0x60, 'fopen', opFopen],
  [0x61, 'fread', opFileGeneric],
  [0x62, 'freadln', opFileGeneric],
  [0x63, 'fseek', opFileGeneric],
  [0x64, 'fseekln', opFileGeneric],
  [0x65, 'ftell', opFileGeneric],
  [0x66, 'ftellln', opFileGeneric],
  [0x67, 'a2fix', opA2Fix],
  [0x68, 'fix2flt', opFix2Flt],
  [0x69, 'parr', opParr],
  [0x6a, 'test', (e, a0, a1) => bitOp(e, a0, a1, (x, y) => x & y, false)],
  [0x6b, 'wait', opWait],
  [0x6c, 'date', opDate],
  [0x6d, 'time', opTime],
  [0x6e, 'xbatt', opXbatt],
  [0x6f, 'tosp', null],
  [0x70, 'xdownl', null],
  [0x71, 'xgetport', opXgetport],
  [0x72, 'xignit', opXignit],
  [0x73, 'xloopt', opXloopt],
  [0x74, 'xprog', opXprog],
  [0x75, 'xraw', opXraw],
  [0x76, 'xsetport', opXsetport],
  [0x77, 'xsireset', opXsireset],
  [0x78, 'xstoptr', null],
  [0x79, 'fix2hex', opFix2Hex],
  [0x7a, 'fix2dez', intFmt(true)],
  [0x7b, 'tabset', opTabset],
  [0x7c, 'tabseek', opTabseek],
  [0x7d, 'tabget', opTabget],
  [0x7e, 'strcat', opStrcat],
  [0x7f, 'pary', opPary],
  [0x80, 'parn', opParn],
  [0x81, 'ergc', erg(ResultType.C, (a) => s8(a.getValue(1)))],
  [0x82, 'ergl', erg(ResultType.L, (a) => s32(a.getValue(4)))],
  [0x83, 'tabline', opTabline],
  [0x84, 'xsendr', null],
  [0x85, 'xrecv', null],
  [0x86, 'xinfo', null],
  [0x87, 'flt2a', opFlt2A],
  [0x88, 'setflt', (e, a0) => void (e.floatPrecision = a0.getValue())],
  [0x89, 'cfgig', opCfgig],
  [0x8a, 'cfgsg', opCfgsg],
  [0x8b, 'cfgis', opCfgis],
  [0x8c, 'a2y', opA2Y],
  [0x8d, 'xparraw', null],
  [0x8e, 'hex2y', opHex2Y],
  [0x8f, 'strcmp', opStrcmp],
  [0x90, 'strlen', opStrlen],
  [0x91, 'y2bcd', opY2Bcd],
  [0x92, 'y2hex', opY2Hex],
  [0x93, 'shmset', opShmset],
  [0x94, 'shmget', opShmget],
  [0x95, 'ergsysi', opErgsysi],
  [0x96, 'flt2fix', opFlt2Fix],
  [0x97, 'iupdate', opIupdate],
  [0x98, 'irange', opIrange],
  [0x99, 'iincpos', opIincpos],
  [0x9a, 'tabseeku', opTabseeku],
  [0x9b, 'flt2y4', opFlt2Y(4)],
  [0x9c, 'flt2y8', opFlt2Y(8)],
  [0x9d, 'y42flt', opY2Flt(4)],
  [0x9e, 'y82flt', opY2Flt(8)],
  [0x9f, 'plink', opPluginIgnore],
  [0xa0, 'pcall', null],
  [0xa1, 'fcomp', opFcomp],
  [0xa2, 'plinkv', opPluginIgnore],
  [0xa3, 'ppush', opPluginIgnore],
  [0xa4, 'ppop', opPpop],
  [0xa5, 'ppushflt', opPluginIgnore],
  [0xa6, 'ppopflt', opPpopflt],
  [0xa7, 'ppushy', opPluginIgnore],
  [0xa8, 'ppopy', opPpopy],
  [0xa9, 'pjtsr', opPluginIgnore],
  [0xaa, 'tabsetex', opTabsetex],
  [0xab, 'ufix2dez', intFmt(false)],
  [0xac, 'generr', opGenerr],
  [0xad, 'ticks', opTicks],
  [0xae, 'waitex', opWaitex],
  [0xaf, 'xopen', null],
  [0xb0, 'xclose', null],
  [0xb1, 'xcloseex', null],
  [0xb2, 'xswitch', null],
  [0xb3, 'xsendex', null],
  [0xb4, 'xrecvex', null],
  [0xb5, 'ssize', opSsize],
  [0xb6, 'tabcols', opTabcols],
  [0xb7, 'tabrows', opTabrows],
];

export const OPCODES: OpDef[] = (() => {
  const arr: OpDef[] = [];
  for (const [code, name, fn, near] of T) arr[code] = { name, fn, nearAddr: !!near };
  return arr;
})();

// silence unused-import lint for helpers kept for parity
void decode;
void doubleToS;
void valueMask;
void EdiabasError;
