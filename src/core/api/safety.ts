// Safety classification of SGBD jobs. Enforced in DiagSession.run, so nothing can bypass it from the UI.
//
//   read   — only reads from the module (identification, fault memory, live values, adaptation values)
//   clear  — clears the fault memory (standard service step; faults still present come back)
//   test   — actuator tests: temporarily drives a component (fuel pump, injector cut, fan, ABS valves…)
//   reset  — resets learned values (adaptations, trims); the car re-learns them
//   write  — permanent writes: coding, EEPROM/flash, EWS immobilizer sync, programming of trims. Always blocked.

export type JobSafety = 'read' | 'clear' | 'test' | 'reset' | 'write';
export type SafetyMode = 'read' | 'service';

const WRITE = /SCHREIBEN|PROGRAMMIER|AUFTRAG|SEED_KEY|MEHRFACHSTARTWERT|^STEUERN_SYNC|SYNC_DME|STEUERN_EWS|FLASH|EEPROM|^FS_INIT|NVRAM|^KD_INIT|^TRIG_|LOGIN|SECURITY|AUTHENTISIERUNG|GWSZ|LOCK_BYTE|^C_.*(LOESCHEN|RESET)|DEL_INIT|SW_UPDATE|ENERGIESPAR|SLEEP|POWER_DOWN|RESET|ABGLEICHEN$|^ABGLEICH_|LAENDERCODIERUNG|_VORHANDEN$|SPERRE|^DOWNLOAD_|DIAGNOSE_(MODE|TESTBIT|FORTSETZEN|WEITER)|DIAGNOSEPROTOKOLL|^FS_SPERREN|_ZAEHLER$|NORMALER_DATENVERKEHR|^ZEITINSPEKTION/;
const CLEAR = /^(FS|IS)_(SELEKTIV_|SHADOW_)?LOESCHEN$/;
const RESET = /ADAPT.*LOESCHEN|^RESET_ADAPTION$|LOESCHEN$|RUECKSETZEN|_VERSTELLEN$|VERWERFEN/;
const TEST = /^(STEUERN|START|STOP|TEST)_|DRUCK(ABBAU|AUFBAU|HALTEN)|PUMPENFOERDER|ENTLUEFTUNG|REGELSIMULATION|_SIM_|ABS_SIMULATION|^SELBSTTEST/;
const SESSION = /^(INFO|INITIALISIERUNG|DIAGNOSE_(ENDE|AUFRECHT|STOP|ERHALTEN)|IDENTIFIKATION)$/;
const READ = /_LESEN$|^STATUS_|^LESEN_|_LESEN_|^FS_.*LESEN|^IS_.*LESEN|_PRUEFEN$|^ECU_CONFIG$|^IDENT|HERSTELLDATEN$|^C_CHECKSUM$/;

export function classifyJob(name: string): JobSafety {
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
