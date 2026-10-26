// Registers, operands and flags of the BEST/2 virtual machine.

import { EdiabasError, ErrorCodes } from './errors';
import { decode, encode } from '../util/cp1252';

/** Boxed float so raw values can be distinguished from unsigned integers. */
export class F64 {
  constructor(public v: number) {}
}
export type Raw = number | F64 | Uint8Array;

export enum RegType {
  Ab = 0, // 8 bit
  I = 1, // 16 bit
  L = 2, // 32 bit
  F = 3, // float
  S = 4, // string / byte array
}

export enum AddrMode {
  None = 0,
  RegS = 1,
  RegAb = 2,
  RegI = 3,
  RegL = 4,
  Imm8 = 5,
  Imm16 = 6,
  Imm32 = 7,
  ImmStr = 8,
  IdxImm = 9,
  IdxReg = 10,
  IdxRegImm = 11,
  IdxImmLenImm = 12,
  IdxImmLenReg = 13,
  IdxRegLenImm = 14,
  IdxRegLenReg = 15,
}

export interface VmCore {
  byteRegs: Uint8Array; // 32
  floatRegs: Float64Array; // 16
  stringRegs: StringData[]; // 16
  arrayMaxSize: number; // arrayMaxBufSize - 1
  setError(code: number): void;
}

export class StringData {
  data: Uint8Array;
  length = 0;
  constructor(private vm: { setError(code: number): void }, capacity: number) {
    this.data = new Uint8Array(capacity);
  }
  newArrayLength(len: number) {
    if (len > this.data.length) this.data = new Uint8Array(len);
  }
  getData(complete = false): Uint8Array {
    if (complete) return this.data;
    return this.data.slice(0, this.length);
  }
  setData(value: Uint8Array, keepLength: boolean) {
    if (value.length > this.data.length) {
      this.vm.setError(ErrorCodes.BIP_0001);
      return;
    }
    this.data.set(value, 0);
    if (!keepLength) this.length = value.length;
  }
  clear() {
    this.data.fill(0);
    this.length = 0;
  }
}

export class Register {
  constructor(readonly opcode: number, readonly type: RegType, readonly index: number) {}

  name(): string {
    const h = (n: number) => n.toString(16).toUpperCase();
    switch (this.type) {
      case RegType.Ab:
        return this.index > 15 ? 'A' + h(this.index - 16) : 'B' + h(this.index);
      case RegType.I:
        return 'I' + h(this.index);
      case RegType.L:
        return 'L' + h(this.index);
      case RegType.F:
        return 'F' + h(this.index);
      case RegType.S:
        return 'S' + h(this.index);
    }
  }

  isArray() {
    return this.type === RegType.S;
  }
  isFloat() {
    return this.type === RegType.F;
  }

  dataLen(vm: VmCore): number {
    switch (this.type) {
      case RegType.Ab:
        return 1;
      case RegType.I:
        return 2;
      case RegType.L:
        return 4;
      case RegType.F:
        return 8;
      case RegType.S:
        return vm.stringRegs[this.index].length;
    }
  }

  getValue(vm: VmCore): number {
    const b = vm.byteRegs;
    switch (this.type) {
      case RegType.Ab:
        return b[this.index];
      case RegType.I: {
        const o = this.index << 1;
        return b[o] | (b[o + 1] << 8);
      }
      case RegType.L: {
        const o = this.index << 2;
        return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
      }
      default:
        throw new Error('Register.getValue: invalid type');
    }
  }

  setValue(vm: VmCore, value: number) {
    const b = vm.byteRegs;
    switch (this.type) {
      case RegType.Ab:
        b[this.index] = value & 0xff;
        return;
      case RegType.I: {
        const o = this.index << 1;
        b[o] = value & 0xff;
        b[o + 1] = (value >>> 8) & 0xff;
        return;
      }
      case RegType.L: {
        const o = this.index << 2;
        b[o] = value & 0xff;
        b[o + 1] = (value >>> 8) & 0xff;
        b[o + 2] = (value >>> 16) & 0xff;
        b[o + 3] = (value >>> 24) & 0xff;
        return;
      }
      default:
        throw new Error('Register.setValue: invalid type');
    }
  }

  getRaw(vm: VmCore): Raw {
    switch (this.type) {
      case RegType.F:
        return new F64(vm.floatRegs[this.index]);
      case RegType.S:
        return vm.stringRegs[this.index].getData(false);
      default:
        return this.getValue(vm);
    }
  }

  getArray(vm: VmCore, complete = false): Uint8Array {
    if (this.type !== RegType.S) throw new Error('Register.getArray: invalid type');
    return vm.stringRegs[this.index].getData(complete);
  }

  setArray(vm: VmCore, value: Uint8Array, keepLength = false) {
    if (this.type !== RegType.S) throw new Error('Register.setArray: invalid type');
    vm.stringRegs[this.index].setData(value, keepLength);
  }

  getFloat(vm: VmCore): number {
    if (this.type !== RegType.F) throw new Error('Register.getFloat: invalid type');
    return vm.floatRegs[this.index];
  }

  setFloat(vm: VmCore, v: number) {
    if (this.type !== RegType.F) throw new Error('Register.setFloat: invalid type');
    vm.floatRegs[this.index] = v;
  }

  setRaw(vm: VmCore, value: Raw) {
    if (this.type === RegType.S) {
      if (!(value instanceof Uint8Array)) throw new Error('Register.setRaw: invalid type (S)');
      this.setArray(vm, value);
    } else if (this.type === RegType.F) {
      if (!(value instanceof F64)) throw new Error('Register.setRaw: invalid type (F)');
      this.setFloat(vm, value.v);
    } else {
      if (typeof value !== 'number') throw new Error('Register.setRaw: invalid type (value)');
      this.setValue(vm, value);
    }
  }

  clear(vm: VmCore) {
    if (this.type !== RegType.S) throw new Error('Register.clear: invalid type');
    vm.stringRegs[this.index].clear();
  }
}

export const REGISTERS: Register[] = (() => {
  const list: Register[] = [];
  for (let i = 0; i < 16; i++) list.push(new Register(i, RegType.Ab, i));
  for (let i = 0; i < 8; i++) list.push(new Register(0x10 + i, RegType.I, i));
  for (let i = 0; i < 4; i++) list.push(new Register(0x18 + i, RegType.L, i));
  for (let i = 0; i < 8; i++) list.push(new Register(0x1c + i, RegType.S, i));
  for (let i = 0; i < 8; i++) list.push(new Register(0x24 + i, RegType.F, i));
  for (let i = 0; i < 8; i++) list.push(new Register(0x2c + i, RegType.S, 8 + i));
  for (let i = 0; i < 16; i++) list.push(new Register(0x80 + i, RegType.Ab, 16 + i));
  for (let i = 0; i < 8; i++) list.push(new Register(0x90 + i, RegType.I, 8 + i));
  for (let i = 0; i < 4; i++) list.push(new Register(0x98 + i, RegType.L, 4 + i));
  return list;
})();

export function getRegister(opcode: number): Register {
  let r: Register | undefined;
  if (opcode <= 0x33) r = REGISTERS[opcode];
  else if (opcode >= 0x80) r = REGISTERS[opcode - 0x80 + 0x34];
  if (!r || r.opcode !== opcode) throw new Error(`getRegister: invalid opcode ${opcode.toString(16)}`);
  return r;
}

const EMPTY = new Uint8Array(0);

export function valueMask(len: number): number {
  switch (len) {
    case 1:
      return 0xff;
    case 2:
      return 0xffff;
    case 4:
      return 0xffffffff;
    default:
      throw new Error('getValueMask: invalid length ' + len);
  }
}

export class Operand {
  mode: AddrMode = AddrMode.None;
  d1: Register | number | Uint8Array | null = null;
  d2: Register | number | null = null;
  d3: Register | number | null = null;

  constructor(private vm: VmCore) {}

  init(mode: AddrMode, d1: Operand['d1'] = null, d2: Operand['d2'] = null, d3: Operand['d3'] = null) {
    this.mode = mode;
    this.d1 = d1;
    this.d2 = d2;
    this.d3 = d3;
  }

  get reg(): Register {
    if (!(this.d1 instanceof Register)) throw new Error('Operand: register expected');
    return this.d1;
  }
  get isRegister(): boolean {
    return this.d1 instanceof Register;
  }

  /** true if the operand's "type" is a byte array (C# GetDataType()==byte[]) */
  isArrayType(): boolean {
    switch (this.mode) {
      case AddrMode.RegS:
      case AddrMode.ImmStr:
      case AddrMode.IdxImm:
      case AddrMode.IdxReg:
      case AddrMode.IdxRegImm:
      case AddrMode.IdxImmLenImm:
      case AddrMode.IdxImmLenReg:
      case AddrMode.IdxRegLenImm:
      case AddrMode.IdxRegLenReg:
        return true;
    }
    return false;
  }

  dataLen(write = false): number {
    switch (this.mode) {
      case AddrMode.RegS:
      case AddrMode.ImmStr:
        return this.getArray().length;
      case AddrMode.RegAb:
      case AddrMode.Imm8:
        return 1;
      case AddrMode.RegI:
      case AddrMode.Imm16:
        return 2;
      case AddrMode.RegL:
      case AddrMode.Imm32:
        return 4;
      case AddrMode.IdxImm:
      case AddrMode.IdxReg:
      case AddrMode.IdxRegImm:
        if (write) return 1;
        return this.getArray().length;
      case AddrMode.IdxImmLenImm:
      case AddrMode.IdxImmLenReg:
      case AddrMode.IdxRegLenImm:
      case AddrMode.IdxRegLenReg:
        return this.getArray().length;
    }
    return 0;
  }

  private idxValue(d: Register | number | null): number {
    if (d instanceof Register) return d.getValue(this.vm);
    if (typeof d === 'number') return d;
    throw new Error('Operand: invalid index data');
  }

  getRaw(): Raw {
    const vm = this.vm;
    switch (this.mode) {
      case AddrMode.RegS:
      case AddrMode.RegAb:
      case AddrMode.RegI:
      case AddrMode.RegL:
        return this.reg.getRaw(vm);
      case AddrMode.Imm8:
      case AddrMode.Imm16:
      case AddrMode.Imm32:
        return this.d1 as number;
      case AddrMode.ImmStr:
        return this.d1 as Uint8Array;
      case AddrMode.IdxImm:
      case AddrMode.IdxReg:
      case AddrMode.IdxRegImm: {
        const data = this.reg.getArray(vm, true);
        let index = this.idxValue(this.d2);
        if (this.mode === AddrMode.IdxRegImm) index += this.d3 as number;
        const required = index + 1;
        if (required > vm.arrayMaxSize) {
          vm.setError(ErrorCodes.BIP_0001);
          return EMPTY;
        }
        if (data.length < required) return EMPTY;
        return data.slice(index);
      }
      case AddrMode.IdxImmLenImm:
      case AddrMode.IdxImmLenReg:
      case AddrMode.IdxRegLenImm:
      case AddrMode.IdxRegLenReg: {
        const data = this.reg.getArray(vm, true);
        const index = this.idxValue(this.d2);
        let len = this.idxValue(this.d3);
        const required = index + len;
        if (required > vm.arrayMaxSize) {
          vm.setError(ErrorCodes.BIP_0001);
          return EMPTY;
        }
        if (data.length < required) {
          if (data.length <= index) return EMPTY;
          len = data.length - index;
        }
        return data.slice(index, index + len);
      }
    }
    throw new Error('Operand.getRaw: invalid address mode ' + this.mode);
  }

  getValue(dataLen = 0): number {
    const raw = this.getRaw();
    if (typeof raw === 'number') return (raw & valueMask(this.dataLen())) >>> 0;
    if (!(raw instanceof Uint8Array)) throw new Error('Operand.getValue: invalid data type');
    if (dataLen === 0) throw new Error('Operand.getValue: invalid data length');
    let v = 0;
    for (let i = dataLen - 1; i >= 0; i--) v = ((v << 8) | (i < raw.length ? raw[i] : 0)) >>> 0;
    return v >>> 0;
  }

  getFloat(): number {
    const raw = this.getRaw();
    if (!(raw instanceof F64)) throw new Error('Operand.getFloat: invalid data type');
    return raw.v;
  }

  getArray(): Uint8Array {
    const raw = this.getRaw();
    if (!(raw instanceof Uint8Array)) throw new Error('Operand.getArray: invalid data type');
    return raw;
  }

  getString(): string {
    const d = this.getArray();
    let l = 0;
    while (l < d.length && d[l] !== 0) l++;
    return decode(d, 0, l);
  }

  setRaw(data: Raw, dataLen = 1) {
    const vm = this.vm;
    switch (this.mode) {
      case AddrMode.RegS:
      case AddrMode.RegAb:
      case AddrMode.RegI:
      case AddrMode.RegL:
        this.reg.setRaw(vm, data);
        return;
      case AddrMode.IdxImm:
      case AddrMode.IdxReg:
      case AddrMode.IdxRegImm: {
        if (data instanceof F64) throw new Error('Operand.setRaw Idx: invalid input type');
        const reg = this.reg;
        let dest = reg.getArray(vm);
        let index = this.idxValue(this.d2);
        if (this.mode === AddrMode.IdxRegImm) index += this.d3 as number;
        let src: Uint8Array;
        if (typeof data === 'number') {
          src = new Uint8Array(dataLen);
          for (let i = 0; i < dataLen; i++) src[i] = (data >>> (i << 3)) & 0xff;
        } else src = data;
        const required = index + src.length;
        if (required > vm.arrayMaxSize) {
          vm.setError(ErrorCodes.BIP_0001);
          return;
        }
        if (dest.length < required) {
          const n = new Uint8Array(required);
          n.set(dest);
          dest = n;
        }
        dest.set(src, index);
        reg.setRaw(vm, dest);
        return;
      }
    }
    throw new Error('Operand.setRaw: invalid address mode ' + this.mode);
  }

  setArray(data: Uint8Array) {
    if (this.mode !== AddrMode.RegS) throw new Error('Operand.setArray: invalid address mode');
    this.reg.setRaw(this.vm, data);
  }

  setString(s: string) {
    let d = encode(s);
    if (d.length > 0 && d[d.length - 1] !== 0) {
      const n = new Uint8Array(d.length + 1);
      n.set(d);
      d = n;
    }
    // C#: an empty string encodes to zero bytes (no terminator added)
    this.setArray(d);
  }

  text(): string {
    const h = (n: number) => '$' + n.toString(16).toUpperCase();
    try {
      switch (this.mode) {
        case AddrMode.None:
          return '';
        case AddrMode.Imm8:
          return `#${h(this.d1 as number)}.B`;
        case AddrMode.Imm16:
          return `#${h(this.d1 as number)}.I`;
        case AddrMode.Imm32:
          return `#${h(this.d1 as number)}.L`;
        case AddrMode.ImmStr:
          return '#' + bytesText(this.d1 as Uint8Array);
        default: {
          const r = this.d1 instanceof Register ? this.d1.name() : '?';
          const raw = this.getRaw();
          if (raw instanceof Uint8Array) return `${r}: ${bytesText(raw)}`;
          if (raw instanceof F64) return `${r}: ${raw.v}`;
          return `${r}: ${h(raw)}`;
        }
      }
    } catch {
      return '?';
    }
  }
}

export function bytesText(d: Uint8Array): string {
  if (d.length < 1) return '{ }';
  let printable = true;
  for (let i = 0; i < d.length - 1; i++) {
    const b = d[i];
    if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) {
      printable = false;
      break;
    }
  }
  if (printable && d[d.length - 1] === 0) return '"' + decode(d, 0, d.length - 1) + '"';
  return '{' + Array.from(d, (b) => '$' + b.toString(16).toUpperCase() + '.B').join(',') + '}';
}

export class Flags {
  carry = false;
  zero = false;
  sign = false;
  overflow = false;

  init() {
    this.carry = this.zero = this.sign = this.overflow = false;
  }

  update(value: number, length: number) {
    const mask = valueMask(length);
    const signMask = length === 1 ? 0x80 : length === 2 ? 0x8000 : 0x80000000;
    this.zero = ((value & mask) >>> 0) === 0;
    this.sign = ((value & signMask) >>> 0) !== 0;
  }

  setOverflow(v1: number, v2: number, result: number, length: number) {
    const signMask = length === 1 ? 0x80 : length === 2 ? 0x8000 : length === 4 ? 0x80000000 : -1;
    if (signMask === -1) throw new Error('Flags.setOverflow: invalid length');
    const s1 = (v1 & signMask) >>> 0;
    const s2 = (v2 & signMask) >>> 0;
    const sr = (result & signMask) >>> 0;
    if (s1 !== s2) this.overflow = false;
    else if (s1 === sr) this.overflow = false;
    else this.overflow = true;
  }

  /** value is the full (up to 33 bit) result as JS number */
  setCarry(value: number, length: number) {
    const carryBit = length === 1 ? 0x100 : length === 2 ? 0x10000 : length === 4 ? 0x100000000 : -1;
    if (carryBit === -1) throw new Error('Flags.setCarry: invalid length');
    this.carry = Math.floor(value / carryBit) % 2 !== 0;
  }

  toValue(): number {
    return (this.carry ? 1 : 0) | (this.zero ? 2 : 0) | (this.sign ? 4 : 0) | (this.overflow ? 8 : 0);
  }
  fromValue(v: number) {
    this.carry = (v & 1) !== 0;
    this.zero = (v & 2) !== 0;
    this.sign = (v & 4) !== 0;
    this.overflow = (v & 8) !== 0;
  }
}

export { EdiabasError };
