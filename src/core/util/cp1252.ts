// Windows-1252 encoding helpers. EDIABAS files and results are always cp1252.

const HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const REVERSE = new Map<number, number>();
for (const [b, cp] of Object.entries(HIGH)) REVERSE.set(cp, Number(b));

export function decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    s += String.fromCharCode(b >= 0x80 && b < 0xa0 ? (HIGH[b] ?? b) : b);
  }
  return s;
}

export function encode(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else out[i] = REVERSE.get(c) ?? 0x3f; // '?'
  }
  return out;
}

/** Decode up to the first NUL byte. */
export function decodeZ(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let e = start;
  while (e < end && bytes[e] !== 0) e++;
  return decode(bytes, start, e);
}
