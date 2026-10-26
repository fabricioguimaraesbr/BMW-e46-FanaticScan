import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { BLOCKED_CODE, DiagSession } from '../src/core/api/DiagSession';
import { isHiddenByEquipment } from '../src/core/api/equipment';
import { classifyJob } from '../src/core/api/safety';
import { createE46 } from '../src/core/sim/e46';
import { SimChannel } from '../src/core/sim/SimChannel';
import { ObdInterface } from '../src/core/transport/ObdInterface';
import { NodeFileProvider } from '../src/node/NodeFileProvider';

const ECU_DIR = process.env.ECU_DIR ?? '/mnt/user-data/uploads/EDIABAS/Ecu';

describe('job safety', () => {
  it('classifies the dangerous MS43 / EGS / ABS jobs', () => {
    for (const j of ['MEHRFACHSTARTWERTABGLEICH', 'STEUERN_SYNC_MODE', 'LL_ABGLEICH_PROGRAMMIEREN', 'PRUEFSTEMPEL_SCHREIBEN', 'TRIG_SCHREIBEN', 'FS_INIT', 'SEED_KEY', 'C_FG_AUFTRAG', 'FGNR_SCHREIBEN', 'GWSZ_RESET'])
      expect(classifyJob(j), j).toBe('write');
    for (const j of ['ADAPT_LOESCHEN', 'ADAPT_LAMBDA_LOESCHEN', 'RESET_ADAPTION', 'LL_ABGLEICH_VERSTELLEN']) expect(classifyJob(j), j).toBe('reset');
    for (const j of ['STEUERN_EKP', 'STEUERN_EV_1_AUS', 'START_SYSTEMCHECK_LAUFUNRUHE', 'DRUCKABBAU_VL', 'NA_ENTLUEFTUNG_LI']) expect(classifyJob(j), j).toBe('test');
    for (const j of ['FS_LOESCHEN', 'IS_LOESCHEN']) expect(classifyJob(j), j).toBe('clear');
    for (const j of ['IDENT', 'FS_LESEN', 'STATUS_MESSWERTEBLOCK', 'STATUS_IO_LESEN', 'ECU_CONFIG', 'CODIERUNG_LESEN', 'ADAPTIONSWERTE_80_LESEN', 'LESEN_SYSTEMCHECK_DMTL']) expect(classifyJob(j), j).toBe('read');
    expect(classifyJob('SOME_UNKNOWN_JOB')).toBe('write');
  });
});

describe.skipIf(!existsSync(ECU_DIR))('session safety and availability', () => {
  async function session() {
    const iface = new ObdInterface(new SimChannel(createE46()));
    await iface.connect();
    return new DiagSession({ files: new NodeFileProvider(ECU_DIR), iface });
  }

  it('blocks tests in read mode and writes always, without sending anything', async () => {
    const s = await session();
    let sent = 0;
    s.ediabas.iface!.transmitData = async () => { sent++; return null; };
    expect((await s.run('ms430ds0', 'STEUERN_EKP', '255')).error?.code).toBe(BLOCKED_CODE);
    expect((await s.run('ms430ds0', 'MEHRFACHSTARTWERTABGLEICH')).error?.code).toBe(BLOCKED_CODE);
    s.safetyMode = 'service';
    expect((await s.run('ms430ds0', 'LL_ABGLEICH_PROGRAMMIEREN')).error?.code).toBe(BLOCKED_CODE);
    expect(sent).toBe(0);
  });

  it('allows actuator tests only in service mode', async () => {
    const s = await session();
    s.safetyMode = 'service';
    expect((await s.run('d_0012', 'STEUERN_EKP', '0')).error).toBeUndefined();
  });

  it('detects equipment and only keeps supported value groups', async () => {
    const s = await session();
    const a = await s.checkAvailability('ms430ds0', { ID_LAMBDA_STEREO: 1, ID_OBD2: 0 });
    expect(a.equipment).toMatchObject({ secondaryAir: false, exhaustFlap: false, ac: true, postCatSensors: true, bank2: true });
    expect(a.jobs).toContain('STATUS_MESSWERTEBLOCK');
    expect(a.jobs.some((j) => /SEK_LUFT/.test(j))).toBe(false);
    expect(isHiddenByEquipment('STAT_SLP_EIN', a.equipment)).toBe('secondaryAir');
    expect(isHiddenByEquipment('STAT_LAMBDA_INTEGRATOR_2_MWB_WERT', a.equipment)).toBeNull();
  }, 60000);
});
