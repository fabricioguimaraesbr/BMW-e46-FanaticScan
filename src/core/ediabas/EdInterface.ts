// Contract between the BEST/2 interpreter and a diagnostic interface (cable / simulator).
// Mirrors EdInterfaceBase from EdiabasLib, but asynchronous so it can run on Web Serial.

export interface IfhHost {
  /** Report an interface error to the interpreter (may throw EdiabasError, like EDIABAS SetError). */
  setError(code: number): void;
  log(msg: string): void;
  getConfig(name: string): string | null;
}

export interface EdInterface {
  readonly interfaceType: string; // e.g. "OBD"
  readonly interfaceVersion: number;
  readonly connected: boolean;
  host: IfhHost | null;

  connect(): Promise<boolean>;
  disconnect(): Promise<boolean>;

  /** xsetpar: communication parameters (concept + timings). */
  setCommParameter(pars: number[] | null): Promise<void>;
  /** xawlen: answer length description. */
  setCommAnswerLen(len: number[]): void;
  commRepeats: number;

  transmitData(request: Uint8Array): Promise<Uint8Array | null>;
  transmitFrequent(request: Uint8Array): Promise<boolean>;
  receiveFrequent(): Promise<Uint8Array | null>;
  stopFrequent(): Promise<boolean>;
  rawData(request: Uint8Array): Promise<Uint8Array | null>;
  transmitCancel(cancel: boolean): void;

  reset(): Promise<boolean>;
  boot(): Promise<boolean>;

  getKeyBytes(): Promise<Uint8Array | null>;
  getState(): Promise<Uint8Array | null>;
  getBatteryVoltage(): Promise<number | null>; // mV, null = unknown
  getIgnitionVoltage(): Promise<number | null>;
  readonly loopTest: number;
  getPort(index: number): number;
  setPort(index: number, value: number): void;
  setProgramVoltage(mv: number): void;
  switchSiRelais(time: number): void;
}
