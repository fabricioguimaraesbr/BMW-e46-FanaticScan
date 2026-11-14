// Minimal .zip reader (stored and deflate entries) on top of DecompressionStream('deflate-raw'),
// so a phone or car head unit can import every module file at once from a single zip.

export interface ZipEntry {
  /** file name without folders ("ms430ds0.prg") */
  name: string;
  /** full path inside the zip */
  path: string;
  data: Uint8Array;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when the bytes start like a zip file. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

/**
 * Reads the entries of a zip (folders skipped). `want` filters by file name before decompressing.
 * Throws on a damaged zip or an unsupported compression method.
 */
export async function unzip(bytes: Uint8Array, want: (name: string) => boolean = () => true): Promise<ZipEntry[]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // end of central directory: last 0x06054b50 within the final 64 KB + 22 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const name = path.split(/[\\/]/).pop() ?? '';
    if (!name || path.endsWith('/') || path.startsWith('__MACOSX/') || name.startsWith('._') || !want(name)) continue;
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error('Damaged zip file');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ name, path, data: raw.slice() });
    else if (method === 8) out.push({ name, path, data: await inflateRaw(raw) });
    else throw new Error(`Unsupported zip compression (${method}) for ${path}`);
  }
  return out;
}
