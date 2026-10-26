// Number parsing/formatting that mirrors EDIABAS (and the .NET semantics EdiabasLib relies on).

export function stringToValue(numberIn: string): { value: number; valid: boolean } {
  // returns a signed 64-bit-ish value as JS number (safe for 32-bit ranges used by BEST2)
  const number = numberIn.replace(/\s+$/, '');
  if (number.length === 0) return { value: 0, valid: false };
  const lower = number.toLowerCase();
  try {
    if (lower.startsWith('0x')) {
      if (lower.length > 2) {
        const first = lower[2];
        if (/[0-9a-f]/.test(first)) {
          const digits = number.substring(2);
          if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length > 16) return { value: 0, valid: false };
          let v = BigInt('0x' + digits);
          if (digits.length === 16 && v >= 0x8000000000000000n) v -= 0x10000000000000000n;
          return { value: Number(v), valid: true };
        }
      }
      return { value: 0, valid: false };
    }
    if (lower.startsWith('0y')) {
      const digits = number.substring(2);
      if (!/^[01]+$/.test(digits)) return { value: 0, valid: false };
      return { value: Number(BigInt('0b' + digits)), valid: true };
    }
    if (lower !== '-' && lower !== '--') {
      if (!/\p{L}/u.test(lower[0])) {
        let conv = number.replace(/^\s+/, '');
        const idx = conv.search(/[.,]/);
        if (idx >= 0) conv = conv.substring(0, idx);
        if (!/^[+-]?\d+$/.test(conv)) return { value: 0, valid: false };
        return { value: Number(BigInt(conv)), valid: true };
      }
    }
  } catch {
    /* ignored */
  }
  return { value: 0, valid: false };
}

export function stringToFloat(numberIn: string): { value: number; valid: boolean } {
  // .NET: only ASCII accepted; ',' replaced by '.'; Double.Parse(Float|AllowThousands)
  if (/[^\x00-\x7f]/.test(numberIn)) return { value: 0, valid: false };
  const number = numberIn.replace(/,/g, '.');
  const m = /^\s*([+-]?)(\d*\.?\d*)([eE][+-]?\d+)?\s*$/.exec(number);
  if (!m || m[2] === '' || m[2] === '.') {
    if (/^\s*[+-]?(Infinity|∞)\s*$/i.test(number)) return { value: number.includes('-') ? -Infinity : Infinity, valid: true };
    if (/^\s*NaN\s*$/i.test(number)) return { value: NaN, valid: true };
    return { value: 0, valid: false };
  }
  const v = Number(m[1] + m[2] + (m[3] ?? ''));
  if (Number.isNaN(v)) return { value: 0, valid: false };
  return { value: v, valid: true };
}

// ---- integer casts (C# unchecked semantics) ----
export const u8 = (v: number) => v & 0xff;
export const s8 = (v: number) => (v << 24) >> 24;
export const u16 = (v: number) => v & 0xffff;
export const s16 = (v: number) => (v << 16) >> 16;
export const u32 = (v: number) => v >>> 0;
export const s32 = (v: number) => v | 0;

/** C# (UInt32)double conversion (truncation, wrap like x86 for out-of-range kept simple). */
export function doubleToU32(d: number): number {
  if (!Number.isFinite(d)) return 0;
  const t = Math.trunc(d);
  return Number(BigInt.asUintN(32, BigInt(t)));
}
export function doubleToS(d: number, bits: number, signed: boolean): number {
  if (!Number.isFinite(d)) return 0;
  const t = BigInt(Math.trunc(d));
  return Number(signed ? BigInt.asIntN(bits, t) : BigInt.asUintN(bits, t));
}

/** Format a double like .NET "R"/"G" default ToString(InvariantCulture). */
export function dotnetDoubleToString(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  // .NET Core 3.0+ uses shortest round-trippable; switches to E notation when exponent >= 15 or < -5
  const abs = Math.abs(v);
  const exp = Math.floor(Math.log10(abs));
  if (exp >= 15 || exp < -5) {
    let s = v.toExponential(); // e.g. 1.5e+20
    s = s.replace(/e([+-])(\d+)$/, (_m, sign, d) => 'E' + sign + d.padStart(2, '0'));
    return s;
  }
  let s = String(v);
  if (/e/i.test(s)) {
    // JS chooses exponent for small numbers < 1e-6; convert to fixed
    s = v.toFixed(Math.min(20, Math.max(0, -exp + 15)));
    s = s.replace(/\.?0+$/, '');
  }
  return s;
}

/** .NET custom numeric format "0.000" / "0" / "0.000000E+000" for doubles. */
export function formatDoubleCustom(v: number, decimals: number, exponent: string | null, minIntDigits = 1): string {
  if (exponent) {
    if (v === 0 || !Number.isFinite(v)) {
      const mant = (0).toFixed(decimals);
      return mant + exponent + '+000';
    }
    let e = Math.floor(Math.log10(Math.abs(v)));
    let mant = v / Math.pow(10, e);
    let ms = roundAwayFromZero(mant, decimals);
    if (Math.abs(Number(ms)) >= 10) {
      e += 1;
      mant = v / Math.pow(10, e);
      ms = roundAwayFromZero(mant, decimals);
    }
    const sign = e < 0 ? '-' : '+';
    return ms + exponent + sign + String(Math.abs(e)).padStart(3, '0');
  }
  let s = roundAwayFromZero(v, decimals);
  if (minIntDigits > 1) {
    const neg = s.startsWith('-');
    let body = neg ? s.substring(1) : s;
    const [ip, fp] = body.split('.');
    body = ip.padStart(minIntDigits, '0') + (fp !== undefined ? '.' + fp : '');
    s = (neg ? '-' : '') + body;
  }
  return s;
}

function roundAwayFromZero(v: number, decimals: number): string {
  // .NET custom format strings round half away from zero
  const factor = Math.pow(10, decimals);
  let scaled = Math.abs(v) * factor;
  // compensate binary representation noise
  scaled = Math.round(scaled * 1e6) / 1e6;
  const r = Math.floor(scaled + 0.5) / factor;
  let s = r.toFixed(decimals);
  if (v < 0 && Number(s) !== 0) s = '-' + s;
  return s;
}

export function hexToByteArray(str: string): Uint8Array {
  const len = str.length - (str.length % 2);
  const out = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    const pair = str.substring(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return new Uint8Array(0);
    out[i / 2] = parseInt(pair, 16);
  }
  return out;
}

export function toHex(data: ArrayLike<number>, sep = ' '): string {
  const parts: string[] = [];
  for (let i = 0; i < data.length; i++) parts.push(data[i].toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(sep);
}
