// Disassembler for BEST/2 jobs: npx tsx scripts/disasm.ts <file.prg> <JOB>
import { readFileSync } from 'fs';
import { PrgFile } from '../src/core/prg/PrgFile';
import { OPCODES } from '../src/core/ediabas/ops';
import { getRegister, bytesText } from '../src/core/ediabas/vmtypes';

export function disasm(f: PrgFile, jobName: string, maxOps = 5000, maxEoj = 1): string[] {
  const job = f.ownJobs.find((j) => j.name.toUpperCase() === jobName.toUpperCase());
  if (!job) throw new Error('job not found');
  const c = f.dec;
  let p = job.offset;
  const out: string[] = [];
  let eojs = 0;
  const u16 = (o: number) => c[o] | (c[o + 1] << 8);
  const rn = (o: number) => getRegister(c[o]).name();
  for (let n = 0; n < maxOps; n++) {
    const start = p;
    const opc = c[p++];
    const modes = c[p++];
    const op = OPCODES[opc];
    const args: string[] = [];
    for (const m of [(modes >> 4) & 15, modes & 15]) {
      switch (m) {
        case 0: break;
        case 1: case 2: case 3: case 4: args.push(rn(p)); p += 1; break;
        case 5: args.push('#$' + c[p].toString(16)); p += 1; break;
        case 6: args.push('#$' + u16(p).toString(16)); p += 2; break;
        case 7: {
          const v = (c[p] | (c[p + 1] << 8) | (c[p + 2] << 16) | (c[p + 3] << 24)) >>> 0;
          p += 4;
          if (op?.nearAddr && args.length === 0) args.push('L_' + ((p + v) >>> 0).toString(16)); // near relative
          else args.push('#$' + v.toString(16) + '.L');
          break;
        }
        case 8: { const l = u16(p); args.push('#' + bytesText(c.slice(p + 2, p + 2 + l))); p += 2 + l; break; }
        case 9: args.push(`${rn(p)}[#$${u16(p + 1).toString(16)}]`); p += 3; break;
        case 10: args.push(`${rn(p)}[${rn(p + 1)}]`); p += 2; break;
        case 11: args.push(`${rn(p)}[${rn(p + 1)}+#$${u16(p + 2).toString(16)}]`); p += 4; break;
        case 12: args.push(`${rn(p)}[#$${u16(p + 1).toString(16)}]#$${u16(p + 3).toString(16)}`); p += 5; break;
        case 13: args.push(`${rn(p)}[#$${u16(p + 1).toString(16)}]${rn(p + 3)}`); p += 4; break;
        case 14: args.push(`${rn(p)}[${rn(p + 1)}]#$${u16(p + 2).toString(16)}`); p += 4; break;
        case 15: args.push(`${rn(p)}[${rn(p + 1)}]${rn(p + 2)}`); p += 3; break;
      }
    }
    out.push(`${start.toString(16).padStart(6, '0')}: ${op?.name ?? '??' + opc} ${args.join(', ')}`);
    if (opc === 0x1d) { if (++eojs >= maxEoj) break; }
  }
  return out;
}

if (process.argv[1]?.endsWith('disasm.ts')) {
  const [file, job] = process.argv.slice(2);
  const f = new PrgFile(file.split('/').pop()!, readFileSync(file));
  console.log(disasm(f, job).join('\n'));
}
