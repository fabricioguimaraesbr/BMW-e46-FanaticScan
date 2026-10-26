import { ScriptIf, ds2, run } from './probe';
const [sgbd, job, n] = [process.argv[2], process.argv[3], +(process.argv[4]||40)];
let req = '';
async function go(data: number[]) {
  const r = await run(new ScriptIf((q)=>{ if (q[2]===0x00 && q.length===3) return ds2(q[0],[0xA0,...[...'7545150190015600301000000000081' + '00X12345678'].map(c=>c.charCodeAt(0))]); req = Array.from(q).map(b=>b.toString(16).padStart(2,'0')).join(' '); return ds2(q[0],[0xA0,...data]); }, false), sgbd, job);
  if (r.error) return { err: r.error.text } as Record<string, unknown>;
  return Object.fromEntries([...r.resultSets[1]].map(([k,v])=>[k,v.value])) as Record<string, unknown>;
}
const base = await go(new Array(n).fill(0));
console.log('request:', req, '\nbase:', base);
for (let i=0;i<n;i++){ const d=new Array(n).fill(0); d[i]=0x40; const r=await go(d); const diff=Object.keys(r).filter(k=>JSON.stringify(r[k])!==JSON.stringify(base[k]) && !/TEXT|EINH/.test(k)); if(diff.length) console.log('byte',i+3, diff.map(k=>`${k}=${r[k]}`).join(' ')); }
