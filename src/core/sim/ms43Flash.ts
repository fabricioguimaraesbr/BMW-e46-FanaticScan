// A made-up MS43 430069 flash image for the simulator: no BMW / Siemens firmware, just the structure the app
// looks at. Calibration header and version, the checksum descriptors where the real program keeps them, the
// e-thermostat and fan items of the 430069 definition with factory-like values, filler everywhere else, and every
// checksum computed. Reading it through the simulated DME exercises the same path as a real car.

import { readItem } from '../dme/calibration';
import { type DmeAxis, type DmeRaw, defFor } from '../dme/defs';
import { checkChecksums, identifyImage } from '../dme/image';

const put = (b: Uint8Array, at: number, bytes: number[]) => b.set(bytes, at);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function writeRaw(b: Uint8Array, at: number, r: DmeRaw, v: number) {
  const n = r.bits / 8;
  let u = v < 0 ? v + 2 ** r.bits : v;
  for (let i = 0; i < n; i++) {
    b[at + (r.lsb ? i : n - 1 - i)] = u % 256;
    u = Math.floor(u / 256);
  }
}

const toRaw = (scale: number, offset: number, v: number) => Math.round((v - offset) / scale);

/** Factory-like values of an M54 (the ones the app limits must accept). */
const CONST: Record<string, number> = {
  c_tco_sp_toil_min: 105, c_toil_min_ect: 95.3, c_tam_min_ect: 7, c_tia_min_ect: 12, c_toil_max_ect: 125.5,
  c_tia_max_ect: 72, c_tco_ex_max_ect: 105, c_tco_sp_tia_max: 82.5, c_tco_sp_tco_ex_max: 84.75, c_tco_bol_ect: 69.75, c_tco_min_ect: 0,
};
const AXES: Record<string, number[]> = {
  ldpm_maf_sub_diag_1: [32.7, 92.6, 201.5, 299.6, 321.4, 397.6],
  ldpm_n_32_28: [416, 640, 896, 1312, 1504, 2016, 3008, 3712, 4000, 4992, 6016, 6496],
  ldp_tco_ex__n_ecf: [80.25, 84.75, 90, 95.25, 99.75, 105],
};

export function makeSimMs43Flash(): Uint8Array {
  const b = new Uint8Array(0x80000).fill(0xff);
  // filler (deterministic) in the program and the calibration, so the checksums cover something
  let x = 0x2468ace1;
  for (let i = 0x10000; i < 0x80000; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  // version strings and the program CRC start pointer
  put(b, 0x6ffb2, ascii('4329001043006965773551'));
  put(b, 0x6ed42, le32(0x6ffb6));
  put(b, 0x70000, ascii('C769751843006901111430006901000011143000690100001114300069010000ca430069.DAT'));
  // checksum descriptors: [sum][block count][pad][start, end]… (end included)
  put(b, 0x73fe0, [0, 0, 2, 0, ...le32(0x70000), ...le32(0x72fff), ...le32(0x74000), ...le32(0x7ee17)]);
  put(b, 0x6fde0, [0, 0, 2, 0, ...le32(0x10000), ...le32(0x1ffff), ...le32(0x20000), ...le32(0x4a8cb)]);
  // 32-bit sums: stored, seeds and [start, end) ranges
  put(b, 0x6fdb2, le32(0xa5a5a5a5));
  put(b, 0x6fdb8, le32(0xa5a5a5a5));
  put(b, 0x6fdbe, [...le32(0x50000), ...le32(0x53bf8), ...le32(0x6e876), ...le32(0x6e878)]);
  put(b, 0x6fdce, [...le32(0x712c6), ...le32(0x71316), ...le32(0x7eb94), ...le32(0x7ee16)]);

  const def = defFor('MS43', '430069')!;
  const info = identifyImage(b);
  const cal = info.calStart;
  const axisDone = new Set<number>();
  const writeAxis = (a: DmeAxis | undefined) => {
    if (!a?.raw || axisDone.has(a.raw.addr)) return;
    axisDone.add(a.raw.addr);
    const vals = AXES[a.name ?? ''] ?? Array.from({ length: a.count }, (_, i) => (i + 1) * 10);
    vals.forEach((v, i) => writeRaw(b, cal + a.raw!.addr + i * (a.raw!.bits / 8), a.raw!, toRaw(a.scale!, a.offset!, v)));
  };
  for (const it of def.items) {
    writeAxis(it.x);
    writeAxis(it.y);
    const at = cal + it.raw.addr;
    const size = it.raw.bits / 8;
    for (let r = 0; r < it.rows; r++) {
      for (let c = 0; c < it.cols; c++) {
        let v: number;
        if (it.name === 'id_tco_sp_ect__n__maf_sub') v = r < 8 && c < 4 ? 102 : 87;
        else if (it.name === 'id_tco_sp_ect_acin__n__maf_sub') v = r < 8 && c < 4 ? 102 : 80.25;
        else if (it.name === 'ip_n_ecf__tco_ex') v = [0, 1, 4.5, 8.2, 11.3, 15][r] ?? 0;
        else if (it.name in CONST) v = CONST[it.name];
        else v = it.min ?? Math.max(0, it.offset);
        writeRaw(b, at + (r * it.cols + c) * size, it.raw, toRaw(it.scale, it.offset, v));
      }
    }
  }
  // the 32-bit sums sit inside the CRC areas: sums first, then the CRCs
  for (const s of checkChecksums(b, info).filter((c) => c.name.includes('32-bit'))) put(b, s.at, le32(s.computed));
  for (const s of checkChecksums(b, info).filter((c) => c.name.includes('CRC'))) put(b, s.at, [s.computed & 0xff, s.computed >>> 8]);
  if (!checkChecksums(b, info).every((s) => s.ok)) throw new Error('simulated MS43 image: checksums do not add up');
  // sanity: the maps read back as written
  readItem(b, info, def, def.items.find((i) => i.name === 'id_tco_sp_ect__n__maf_sub')!);
  return b;
}
