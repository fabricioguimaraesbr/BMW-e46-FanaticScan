// "Report a problem": everything needed to understand what went wrong on someone else's car, in one JSON file,
// with the VIN masked. Nothing is sent anywhere: the file is saved or copied and the user decides where it goes.

export interface ReportInput {
  app: string;
  build: string;
  userAgent: string;
  platform: string;
  description: string;
  page: string;
  cable: string;
  mode: string;
  settings: Record<string, unknown>;
  /** the communication log, oldest first (time + text) */
  log: { cls: string; text: string }[];
  modules: { short: string; variant: string | null; ident: Record<string, unknown>; faults?: number; error?: string }[];
}

export interface ProblemReport {
  v: 1;
  app: string;
  build: string;
  created: string;
  description: string;
  browser: { userAgent: string; platform: string };
  page: string;
  cable: string;
  mode: string;
  settings: Record<string, unknown>;
  modules: ReportInput['modules'];
  /** jobs, errors and info lines */
  journal: string[];
  /** the last telegrams on the wire (hex) */
  wire: string[];
}

const VIN17 = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const VIN7 = /\b([A-Z]{2})(\d{5})\b/g;

/** Masks VINs in text: the full 17 characters and BMW's short 7 (two letters, five digits). */
export function maskVinText(s: string): string {
  return s.replace(VIN17, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? `${m.slice(0, 3)}${'*'.repeat(14)}` : m)).replace(VIN7, '$1*****');
}

/** Masks VINs inside a hex telegram: ASCII runs that read as a VIN are replaced by '*' bytes (2A). */
export function maskVinHex(hex: string): string {
  const bytes = hex.trim().split(/\s+/).filter(Boolean);
  if (!bytes.length || bytes.some((b) => !/^[0-9A-Fa-f]{2}$/.test(b))) return hex;
  const chars = bytes.map((b) => String.fromCharCode(parseInt(b, 16)));
  const text = chars.join('');
  const mask = (start: number, len: number) => {
    for (let i = start; i < start + len; i++) bytes[i] = '2A';
  };
  for (const m of text.matchAll(/[A-HJ-NPR-Z0-9]{17}/g)) if (/\d/.test(m[0]) && /[A-Z]/.test(m[0])) mask(m.index! + 3, 14);
  for (const m of text.matchAll(/[A-Z]{2}\d{5}/g)) mask(m.index! + 2, 5);
  return bytes.join(' ');
}

const IDENT_KEEP = /^ID_(BMW_NR|HW_NR|SW_NR|COD_INDEX|DIAG_INDEX|VAR_INDEX|DATUM|LIEF|SG_ADR|MOTOR)/;

export function buildReport(i: ReportInput): ProblemReport {
  const journal: string[] = [];
  const wire: string[] = [];
  for (const l of i.log) {
    if (l.cls === 'tx' || l.cls === 'rx') {
      // "12:00:01  → 12 04 00 16": time, arrow, hex
      const m = /^(\S+)\s+(\S)\s+(.*)$/.exec(l.text);
      wire.push(m ? `${m[1]} ${m[2]} ${maskVinHex(m[3])}` : maskVinText(l.text));
    } else journal.push(maskVinText(l.text));
  }
  return {
    v: 1,
    app: i.app,
    build: i.build,
    created: new Date().toISOString(),
    description: maskVinText(i.description),
    browser: { userAgent: i.userAgent, platform: i.platform },
    page: i.page,
    cable: i.cable,
    mode: i.mode,
    settings: i.settings,
    modules: i.modules.map((m) => ({
      ...m,
      ident: Object.fromEntries(Object.entries(m.ident).filter(([k]) => IDENT_KEEP.test(k))),
      error: m.error ? maskVinText(m.error) : undefined,
    })),
    journal: journal.slice(-400),
    wire: wire.slice(-300),
  };
}
