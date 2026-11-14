// Module files from a single .zip (phones and car head units whose picker takes one file at a time).
import { describe, expect, it } from 'vitest';
import { isZip, unzip } from '../src/core/util/unzip';

async function deflateRaw(data: Uint8Array) {
  const s = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Tiny zip writer for the test (CRC left at 0: the reader does not check it). */
async function makeZip(files: { path: string; data: Uint8Array; deflate: boolean }[]) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const body = f.deflate ? await deflateRaw(f.data) : f.data;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(8, f.deflate ? 8 : 0, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, f.deflate ? 8 : 0, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), name, body);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

describe('unzip', () => {
  it('reads stored and deflated entries, skips folders and Mac junk, filters by name', async () => {
    const big = new Uint8Array(5000).map((_, i) => i % 7);
    const zip = await makeZip([
      { path: 'modulos_e46/', data: new Uint8Array(), deflate: false },
      { path: 'modulos_e46/MS430DS0.PRG', data: big, deflate: true },
      { path: 'modulos_e46/d_motor.grp', data: new Uint8Array([1, 2, 3]), deflate: false },
      { path: '__MACOSX/modulos_e46/._d_motor.grp', data: new Uint8Array([9]), deflate: false },
      { path: 'LEIA-ME.txt', data: new Uint8Array([65]), deflate: false },
    ]);
    expect(isZip(zip)).toBe(true);
    const e = await unzip(zip, (n) => /\.(prg|grp)$/i.test(n));
    expect(e.map((x) => x.name)).toEqual(['MS430DS0.PRG', 'd_motor.grp']);
    expect(Array.from(e[0].data)).toEqual(Array.from(big));
    expect(Array.from(e[1].data)).toEqual([1, 2, 3]);
  });

  it('rejects something that is not a zip', async () => {
    expect(isZip(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    await expect(unzip(new Uint8Array(100))).rejects.toThrow();
  });
});
