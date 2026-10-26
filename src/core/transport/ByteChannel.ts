// Byte-level serial channel. Implemented by Web Serial (browser), node-serialport and the E46 simulator.

export interface SerialConfig {
  baudRate: number;
  parity: 'none' | 'even' | 'odd';
  dataBits: 7 | 8;
  stopBits: 1 | 2;
}

export interface ByteChannel {
  readonly name: string;
  readonly isOpen: boolean;
  open(cfg: SerialConfig): Promise<void>;
  /** Change line settings without closing (Web Serial needs close/reopen; handled by the implementation). */
  reconfigure(cfg: SerialConfig): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** Reads exactly `n` bytes or fewer if `timeoutMs` elapses without new data. */
  read(n: number, timeoutMs: number): Promise<Uint8Array>;
  discardInput(): void;
  setSignals(s: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void>;
}

/**
 * Helper base: incoming bytes are pushed into a queue by the subclass (onData),
 * `read` waits for them with an inter-byte timeout.
 */
export abstract class QueuedChannel implements ByteChannel {
  abstract readonly name: string;
  abstract readonly isOpen: boolean;
  abstract open(cfg: SerialConfig): Promise<void>;
  abstract close(): Promise<void>;
  abstract write(data: Uint8Array): Promise<void>;
  abstract setSignals(s: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void>;

  async reconfigure(cfg: SerialConfig): Promise<void> {
    await this.close();
    await this.open(cfg);
  }

  private buf: number[] = [];
  private waiter: (() => void) | null = null;

  protected onData(chunk: Uint8Array) {
    for (const b of chunk) this.buf.push(b);
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  discardInput() {
    this.buf.length = 0;
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const out: number[] = [];
    while (out.length < n) {
      if (this.buf.length) {
        out.push(...this.buf.splice(0, n - out.length));
        continue;
      }
      const got = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          this.waiter = null;
          resolve(false);
        }, timeoutMs);
        this.waiter = () => {
          clearTimeout(t);
          resolve(true);
        };
      });
      if (!got) break;
    }
    return new Uint8Array(out);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
