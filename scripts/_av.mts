import { DiagSession } from '../src/core/api/DiagSession'; import { createE46 } from '../src/core/sim/e46'; import { SimChannel } from '../src/core/sim/SimChannel'; import { ObdInterface } from '../src/core/transport/ObdInterface'; import { NodeFileProvider } from '../src/node/NodeFileProvider';
const i = new ObdInterface(new SimChannel(createE46())); await i.connect();
const s = new DiagSession({ files: new NodeFileProvider('/mnt/user-data/uploads/EDIABAS/Ecu'), iface: i, jobTimeoutMs: 5000, onJob: (r, ms) => { if (ms > 400) console.log(ms, r.job, r.error?.text ?? ''); } });
const t = Date.now(); const a = await s.checkAvailability('ms430ds0', { ID_LAMBDA_STEREO: 1, ID_OBD2: 0 });
console.log('total', Date.now() - t, 'ms; ok', a.jobs.length, 'bad', a.unavailable.length, a.unavailable.slice(0, 20));
