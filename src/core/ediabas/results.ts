export enum ResultType {
  B = 'B', // 8 bit
  W = 'W', // 16 bit
  D = 'D', // 32 bit
  C = 'C', // 8 bit char (signed)
  I = 'I', // 16 bit signed
  L = 'L', // 32 bit signed
  R = 'R', // real
  S = 'S', // string
  Y = 'Y', // binary
}

export interface ResultData {
  type: ResultType;
  name: string;
  value: number | string | Uint8Array;
}
export type ResultSet = Map<string, ResultData>;
