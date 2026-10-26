// Dumps job comments, argument comments and result names (for translation)
import { readFileSync } from 'fs'; import { PrgFile, parseJobDoc } from '../src/core/prg/PrgFile';
const D = (process.env.ECU_DIR ?? 'C:/EDIABAS/Ecu') + '/';
const comments = new Set<string>(), args = new Set<string>(), results = new Set<string>(), rcomm = new Set<string>();
for (const f of process.argv.slice(2)) { const p = new PrgFile(f, readFileSync(D + f));
  for (const j of p.ownJobs) { const d = parseJobDoc(p, j.name); if (!d) continue;
    const c = d.comments.join(' ').trim(); if (c) comments.add(c);
    for (const a of d.args) { const t = a.comments.join(' ').trim(); if (t) args.add(t); }
    if (/^(STATUS|LESEN)_/i.test(j.name)) for (const r of d.results) { results.add(r.name); const t = r.comments.join(' ').trim(); if (t) rcomm.add(r.name + ' :: ' + t); } } }
console.log('#COMMENTS', comments.size); console.log([...comments].join('\n'));
console.log('#ARGS', args.size); console.log([...args].join('\n'));
console.log('#RESULTS', results.size); console.log([...rcomm].join('\n'));
