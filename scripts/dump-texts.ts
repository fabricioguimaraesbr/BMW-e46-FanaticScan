// Dumps the unique German texts of the fault tables (for building src/core/api/i18n-en.ts)
import { readFileSync } from 'fs'; import { PrgFile } from '../src/core/prg/PrgFile';
const D = (process.env.ECU_DIR ?? 'C:/EDIABAS/Ecu') + '/';
const all = new Set<string>();
for (const f of process.argv.slice(2)) { const p = new PrgFile(f, readFileSync(D + f));
  for (const t of ['FORTTEXTE', 'FARTTEXTE', 'FUMWELTTEXTE']) for (const r of p.tableRows(t)?.slice(1) ?? []) all.add(r[1]); }
console.log([...all].join('\n'));
