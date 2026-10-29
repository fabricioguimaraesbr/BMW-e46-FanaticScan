// Prints the xsetpar parameters and the first request of a job: npx tsx scripts/re/params.ts <sgbd> <job>
import { Ediabas } from '../../src/core/ediabas/Ediabas';
import { files, ScriptIf } from './probe';
import { toHex } from '../../src/core/util/numbers';
const [sgbd, job] = process.argv.slice(2);
const i = new ScriptIf(() => null, false);
i.setCommParameter = async (p) => { console.log('xsetpar', p?.map((x) => '0x' + x.toString(16)).join(' ')); };
i.setCommAnswerLen = (l) => console.log('xawlen', l);
const orig = i.transmitData.bind(i);
i.transmitData = async (r) => { console.log('tx', toHex(r)); return orig(r); };
const e = new Ediabas({ files, iface: i });
const r = await e.executeJob({ sgbd, job });
console.log('->', r.error?.text ?? 'ok');
