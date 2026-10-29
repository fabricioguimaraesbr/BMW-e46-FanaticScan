// KWP2000* probe: answers every 0x10D request with a positive response padded with `fill` bytes.
// npx tsx scripts/re/kwp.ts <sgbd> <job> [fillLen]
import { Ediabas } from '../../src/core/ediabas/Ediabas';
import { files, ScriptIf, show } from './probe';
import { toHex } from '../../src/core/util/numbers';
const [sgbd, job, n = '40', args] = process.argv.slice(2);
let concept = 0;
const i = new ScriptIf((req) => {
  if (concept !== 0x10d) return null;
  const data = [...req.slice(4)];
  const body = [data[0] + 0x40, ...data.slice(1), ...new Array(Number(n)).fill(0x01)];
  if (data[0] === 0x18) body.splice(1, body.length - 1, 0x00); // FS: no faults
  const tel = [0xb8, req[2], req[1], body.length, ...body];
  tel.push(tel.reduce((a, b) => a ^ b, 0));
  return new Uint8Array(tel);
}, true);
i.setCommParameter = async (p) => { concept = p?.[0] ?? 0; };
const r = await new Ediabas({ files, iface: i }).executeJob({ sgbd, job, args });
show(r);
