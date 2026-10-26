import { Ediabas } from '../../src/core/ediabas/Ediabas';
import { NodeFileProvider } from '../../src/node/NodeFileProvider';
import type { EdInterface, IfhHost } from '../../src/core/ediabas/EdInterface';
import { toHex } from '../../src/core/util/numbers';
export type Responder = (req: Uint8Array) => Uint8Array | null;
export class ScriptIf implements EdInterface {
  interfaceType='OBD'; interfaceVersion=209; connected=false; host: IfhHost|null=null; commRepeats=0;
  constructor(public responder: Responder, public verbose=true){}
  async connect(){ this.connected=true; return true; } async disconnect(){ this.connected=false; return true; }
  async setCommParameter(p: number[]|null){} setCommAnswerLen(l: number[]){}
  async transmitData(r: Uint8Array){ const a=this.responder(r); if(this.verbose) console.log('  >', toHex(r), ' <', a?toHex(a):'--'); if(!a){ this.host!.setError(19); return null;} return a; }
  async transmitFrequent(){ return true; } async receiveFrequent(){ return new Uint8Array(0);} async stopFrequent(){return true;}
  async rawData(){ return new Uint8Array(0);} transmitCancel(){}
  async reset(){return true;} async boot(){return true;}
  async getKeyBytes(){ return new Uint8Array(0);} async getState(){ return new Uint8Array([0,0]); }
  async getBatteryVoltage(){ return 12000;} async getIgnitionVoltage(){ return 12000; }
  loopTest=1; getPort(){return 0;} setPort(){} setProgramVoltage(){} switchSiRelais(){}
}
export function ds2(addr: number, payload: number[]) { const b=[addr, payload.length+3, ...payload]; b.push(b.reduce((x,y)=>x^y,0)); return new Uint8Array(b); }
export const files = new NodeFileProvider(process.env.ECU_DIR ?? 'C:/EDIABAS/Ecu');
export async function run(iface: EdInterface, sgbd: string, job: string, args?: string) {
  const e = new Ediabas({ files, iface });
  const r = await e.executeJob({ sgbd, job, args });
  return r;
}
export function show(r: Awaited<ReturnType<typeof run>>) {
  console.log('->', r.sgbd, r.job, r.error ?? 'OK');
  r.resultSets.slice(1).forEach((s,i)=>console.log(' set',i+1, Object.fromEntries([...s].map(([k,v])=>[k, typeof v.value==='object' && v.value ? toHex(v.value as Uint8Array) : v.value]))));
}
if (process.argv[1]?.endsWith('probe.ts')) {
  const [sgbd, job, hex, args] = process.argv.slice(2);
  const payload = hex.startsWith('ascii:') ? [0xA0, ...[...hex.slice(6)].map(c=>c.charCodeAt(0))] : hex.split(/\s+/).map(h=>parseInt(h,16));
  const r = await run(new ScriptIf((req)=>ds2(req[0], payload)), sgbd, job, args);
  show(r);
}
