import { ScriptIf, ds2, run, show } from './probe';
const ident = [0xA0, ...[...'7545150190015600301' + '0000000000' + '81' + '00' + 'X' + '12345678'].map(c=>c.charCodeAt(0))];
const blocks: Record<string, number[]> = JSON.parse(process.argv[3] ?? '{}');
const r = await run(new ScriptIf((q)=>{
  const k = Array.from(q.slice(2)).map(b=>b.toString(16).padStart(2,'0')).join(' ');
  if (k==='00') return ds2(q[0], ident);
  return ds2(q[0], blocks[k] ?? [0xA0]);
}), process.argv[2] ?? 'ms430ds0', process.argv[4] ?? 'FS_LESEN');
show(r);
