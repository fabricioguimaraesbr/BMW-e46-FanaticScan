// "modulos" folder without the engine file (e.g. a 318i/328i owner with an M54-only folder):
// engine falls back to OBD-II, the other modules still use their BMW files, on the same K-line.
import { existsSync, mkdtempSync, readdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DiagSession } from '../src/core/api/DiagSession';
import { HybridSession } from '../src/core/api/HybridSession';
import { E46_MODULES } from '../src/core/api/modules';
import { ENGINE_VARIANT, NativeSession } from '../src/core/native/NativeSession';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';

describe.skipIf(!existsSync(ECU_DIR))('module files + plug & play mixed', () => {
  it('uses OBD-II for the engine when its file is missing, files for the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecu-'));
    for (const f of readdirSync(ECU_DIR)) if (!/^ms430ds0\./i.test(f)) copyFileSync(join(ECU_DIR, f), join(dir, f));
    const channel = new SimChannel(createE46({ obdStored: ['P0171'] }));
    const iface = new ObdInterface(channel);
    await iface.connect();
    const s = new HybridSession(
      new DiagSession({ files: new NodeFileProvider(dir), iface, jobTimeoutMs: 8000 }),
      new NativeSession({ channel, iface }),
      () => iface.resetLine(),
    );
    const scan = await s.scan(E46_MODULES.slice(0, 3));
    expect(scan.map((e) => e.variant)).toEqual([ENGINE_VARIANT, 'gs8604', 'ascmk20']);

    const engine = await s.readDtcs(ENGINE_VARIANT);
    expect(engine.dtcs.map((d) => d.label)).toContain('P0171');
    // back to DS2 with the module file after OBD-II was open
    const egs = await s.readDtcs('gs8604');
    expect(egs.error).toBeUndefined();
    expect(egs.dtcs.map((d) => d.text)).toEqual(['Battery supply terminal 30']);
    const live = await s.readValues(ENGINE_VARIANT, 'OBD_LIVE');
    expect(live.values.find((v) => v.key === 'OBD_0C')?.value).toBeGreaterThan(400);
    s.native.iso.stopKeepAlive();
  }, 60000);
});
