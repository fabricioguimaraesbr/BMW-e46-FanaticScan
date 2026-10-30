// Safety classification of SGBD jobs. Enforced in DiagSession.run, so nothing can bypass it from the UI.
//
//   read   — only reads from the module (identification, fault memory, live values, adaptation values)
//   clear  — clears the fault memory (standard service step; faults still present come back)
//   test   — actuator tests: temporarily drives a component (fuel pump, injector cut, fan, ABS valves…)
//   reset  — resets learned values (adaptations, trims); the car re-learns them
//   write  — permanent writes: coding, EEPROM/flash, EWS immobilizer sync, programming of trims. Always blocked.
//
// The one controlled exception does not go through SGBD jobs at all: the coolant gauge curve of the instrument
// cluster (src/core/coding/clusterEeprom.ts), with its own backup / compare / verify rules. Remote sessions
// (src/core/remote/remote.ts) apply these classes again on the computer at the car, more strictly.

export type JobSafety = 'read' | 'clear' | 'test' | 'reset' | 'write';
export type SafetyMode = 'read' | 'service';

const WRITE = /SCHREIBEN|PROGRAMMIER|AUFTRAG|SEED_KEY|MEHRFACHSTARTWERT|^STEUERN_SYNC|SYNC_DME|STEUERN_EWS|FLASH|EEPROM|^FS_INIT|NVRAM|^KD_INIT|^TRIG_|LOGIN|SECURITY|AUTHENTISIERUNG|GWSZ|LOCK_BYTE|^C_.*(LOESCHEN|RESET)|DEL_INIT|SW_UPDATE|ENERGIESPAR|SLEEP|POWER_DOWN|RESET|ABGLEICHEN$|^ABGLEICH_|LAENDERCODIERUNG|_VORHANDEN$|SPERRE|^DOWNLOAD_|DIAGNOSE_(MODE|TESTBIT|FORTSETZEN|WEITER)|DIAGNOSEPROTOKOLL|^FS_SPERREN|_ZAEHLER$|NORMALER_DATENVERKEHR|^ZEITINSPEKTION/;
const CLEAR = /^(FS|IS)_(SELEKTIV_|SHADOW_)?LOESCHEN$/;
const RESET = /ADAPT.*LOESCHEN|^RESET_ADAPTION$|LOESCHEN$|RUECKSETZEN|_VERSTELLEN$|VERWERFEN/;
const TEST = /^(STEUERN|START|STOP|TEST)_|DRUCK(ABBAU|AUFBAU|HALTEN)|PUMPENFOERDER|ENTLUEFTUNG|REGELSIMULATION|_SIM_|ABS_SIMULATION|^SELBSTTEST/;
const SESSION = /^(INFO|INITIALISIERUNG|DIAGNOSE_(ENDE|AUFRECHT|STOP|ERHALTEN)|IDENTIFIKATION)$/;
const READ = /_LESEN$|^STATUS_|^LESEN_|_LESEN_|^FS_.*LESEN|^IS_.*LESEN|_PRUEFEN$|^ECU_CONFIG$|^IDENT|HERSTELLDATEN$|^C_CHECKSUM$/;

/**
 * Jobs whose name sounds harmless but that write to the module or to the key. Keyed by SGBD (lower case, without
 * extension); '*' applies to every SGBD. Found by reading the job descriptions of the E46 files.
 */
const WRITE_OVERRIDES: Record<string, string[]> = {
  // "Schreibzugriff auf den Transponder via EWS-SG": writes a byte into the key's transponder
  ews: ['STEUERN_SELBSTTEST'],
  ews3: ['STEUERN_SELBSTTEST'],
  ews3d: ['STEUERN_SELBSTTEST'],
};
/**
 * Jobs whose name matches a write pattern but that only read (checked in the SGBD: their telegrams are the cluster's
 * read services 02 01 / 06 03). Keyed like WRITE_OVERRIDES.
 */
const READ_OVERRIDES: Record<string, string[]> = {
  kombi46: ['AIF_GWSZ_LESEN', 'GWSZ_MINUS_OFFSET_LESEN', 'GWSZ_OFFSET_LESEN'],
  kombi46r: ['STATUS_AIF_GWSZ_LESEN', 'GWSZ_MINUS_OFFSET_LESEN', 'GWSZ_OFFSET_LESEN'],
};
/** Job description words that mean a permanent write, whatever the job is called. */
const WRITE_DOC = /(?<!zu )schreib|programmier|transponder|eeprom|flash|codier/i;

/**
 * @param name job name
 * @param sgbd SGBD the job belongs to (variant file), for the per-file overrides
 * @param comment the job's description from the SGBD: a test or reset described as writing is treated as a write
 */
export function classifyJob(name: string, sgbd?: string, comment?: string): JobSafety {
  const n = name.toUpperCase();
  const file = (sgbd ?? '').toLowerCase().replace(/\.(prg|grp)$/, '');
  if (READ_OVERRIDES[file]?.includes(n)) return 'read';
  const base = classifyByName(name);
  if (base !== 'write' && (WRITE_OVERRIDES[file]?.includes(n) || WRITE_OVERRIDES['*']?.includes(n))) return 'write';
  if ((base === 'test' || base === 'reset') && comment && WRITE_DOC.test(comment)) return 'write';
  return base;
}

function classifyByName(name: string): JobSafety {
  const n = name.toUpperCase();
  if (SESSION.test(n)) return 'read';
  if (n === 'RESET_ADAPTION') return 'reset';
  if (WRITE.test(n)) return 'write';
  if (CLEAR.test(n)) return 'clear';
  if (READ.test(n)) return 'read';
  if (TEST.test(n)) return 'test';
  if (RESET.test(n)) return 'reset';
  return 'write'; // unknown jobs are treated as unsafe
}

/** read mode: reads + clearing faults. service mode adds actuator tests and resets. Writes are never allowed. */
export function isAllowed(safety: JobSafety, mode: SafetyMode): boolean {
  if (safety === 'read' || safety === 'clear') return true;
  if (safety === 'write') return false;
  return mode === 'service';
}

export const SAFETY_LABEL: Record<JobSafety, string> = {
  read: 'Read only',
  clear: 'Clears fault memory',
  test: 'Actuator test',
  reset: 'Resets learned values',
  write: 'Writes to the module',
};
