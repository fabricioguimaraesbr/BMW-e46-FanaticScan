// Collects every unique text of the *TEXTE tables in the given SGBD folder (for building i18n-dict.json)
import { readFileSync, readdirSync, writeFileSync } from 'fs'; import { PrgFile } from '../src/core/prg/PrgFile';
const D = (process.env.ECU_DIR ?? 'C:/EDIABAS/Ecu') + '/';
const texts = new Map<string, Set<string>>(); const tcount = new Map<string, number>();
for (const f of readdirSync(D)) { if (!/\.prg$/i.test(f)) continue; const p = new PrgFile(f, readFileSync(D + f));
  for (const t of p.tables) { if (!/^(FORTTEXTE|FARTTEXTE|FUMWELT|IORTTEXTE|IARTTEXTE|HORTTEXTE|FARTERW|FARTSTATUS|IUMWELT|FEHLERTEXTE|FORTTEXTE43|NULLEINSTEXTE)/.test(t.name)) continue; tcount.set(t.name, (tcount.get(t.name) ?? 0) + 1);
    const rows = p.tableRows(t.name) ?? []; const hdr = rows[0] ?? [];
    for (const r of rows.slice(1)) r.forEach((c, i) => { if (!/TEXT|NAME/i.test(hdr[i] ?? '')) return; const s = c.trim(); if (!s || !/[a-zA-Z]{3}/.test(s)) return;
      if (!texts.has(s)) texts.set(s, new Set()); texts.get(s)!.add(f.toLowerCase().replace(/\.prg$/, '')); }); } }
console.error([...tcount].sort((a, b) => b[1] - a[1]).map(x => x.join(':')).join(' '));
writeFileSync(process.argv[2] ?? 'texts.json', JSON.stringify([...texts].map(([s, f]) => [s, [...f].slice(0, 3).join(',')]), null, 0));
console.error('unique', texts.size);
