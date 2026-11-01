// Definitions of DME calibration items (Siemens MS42 / MS43), built by scripts/build-dme-defs.ts from the TunerPro
// definition files of the MS4X Dev Team (https://github.com/ms4x-net, GPL-3.0). One entry per software version:
// addresses differ between versions, so a definition is only ever used on the version it was written for.

import defsJson from './defs.json';

export type DmeFamily = 'MS42' | 'MS43';

/** How an item is stored: address counted from the start of the calibration, element size, sign and byte order. */
export interface DmeRaw {
  addr: number;
  bits: 8 | 16 | 32;
  signed: boolean;
  /** little endian (TunerPro "LSB first") */
  lsb: boolean;
}

/** value = scale · raw + offset (every equation was checked to be linear when the file was built) */
export interface DmeScaling {
  scale: number;
  offset: number;
}

export interface DmeAxis {
  units: string;
  count: number;
  /** fixed labels (an axis that is not stored in the calibration) */
  labels?: number[];
  /** an axis stored in the calibration */
  raw?: DmeRaw;
  scale?: number;
  offset?: number;
  name?: string;
  /** the definition does not say where this axis is: labels are just point numbers */
  unknown?: boolean;
}

export interface DmeItem extends DmeScaling {
  name: string;
  desc: string;
  category: string;
  kind: 'const' | 'table';
  raw: DmeRaw;
  /** rows follow the y axis, columns the x axis; a constant is 1 × 1 */
  rows: number;
  cols: number;
  units: string;
  decimals: number;
  min?: number;
  max?: number;
  x?: DmeAxis;
  y?: DmeAxis;
}

export interface DmeVersionDef {
  family: DmeFamily;
  /** software version as stored in the image: '430069', '0110C6' */
  version: string;
  xdf: string;
  xdfVersion: string;
  /** size of the calibration the addresses count from */
  calSize: number;
  items: DmeItem[];
}

export interface DmeDefs {
  source: string;
  categories: string[];
  versions: DmeVersionDef[];
}

export const DME_DEFS = defsJson as DmeDefs;

export function defFor(family: DmeFamily, version: string): DmeVersionDef | undefined {
  return DME_DEFS.versions.find((v) => v.family === family && v.version === version);
}

export function supportedVersions(): string[] {
  return DME_DEFS.versions.map((v) => `${v.family} ${v.version}`);
}
