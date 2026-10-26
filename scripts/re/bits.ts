// Maps single bits of a status response to results: npx tsx scripts/re/bits.ts <sgbd> <job> <nbytes>
import { ScriptIf, ds2, run } from './probe';
const [sgbd, job, n] = [process.argv[2], process.argv[3], +(process.argv[4] || 8)];
async function go(data: number[]) {
  const r = await run(new ScriptIf((q) => (q[2] === 0 && q.length === 3 ? ds2(q[0], [0xa0, ...[...'7545150190015600301000000000081' + '00X12345678'].map((c) => c.charCodeAt(0))]) : ds2(q[0], [0xa0, ...data])), false), sgbd, job);
  return r.error ? { err: r.error.text } : Object.fromEntries([...r.resultSets[1]].map(([k, v]) => [k, v.value]));
}
const base = await go(new Array(n).fill(0));
console.log('base', JSON.stringify(base));
for (let i = 0; i < n; i++) for (let b = 0; b < 8; b++) {
  const d = new Array(n).fill(0); d[i] = 1 << b;
  const r = await go(d) as Record<string, unknown>;
  const diff = Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify((base as Record<string, unknown>)[k]));
  if (diff.length) console.log(`data[${i}] bit 0x${(1 << b).toString(16)}:`, diff.map((k) => `${k}=${r[k]}`).join(' '));
}
