// What the connected car actually has. Read from the DME (ECU_CONFIG, ABGAS_VARIANTE_LESEN, IDENT) and used to
// hide value groups, values and functions for equipment that is not fitted.

export type EquipmentKey = 'secondaryAir' | 'exhaustFlap' | 'ac' | 'electricFan' | 'steeringButtons' | 'asc' | 'egs' | 'postCatSensors' | 'leakDiagnosis' | 'bank2';

export const EQUIPMENT_LABEL: Record<EquipmentKey, string> = {
  secondaryAir: 'Secondary air system',
  exhaustFlap: 'Exhaust flap',
  ac: 'Air conditioning',
  electricFan: 'Electric fan',
  steeringButtons: 'Steering wheel buttons',
  asc: 'ASC traction control',
  egs: 'Automatic transmission',
  postCatSensors: 'Post-catalyst O2 sensors',
  leakDiagnosis: 'Fuel tank leak diagnosis (US)',
  bank2: 'Second exhaust bank',
};

/** true = fitted, false = not fitted, missing = unknown (shown). */
export type Equipment = Partial<Record<EquipmentKey, boolean>>;

/** Names of values / jobs that belong to each piece of equipment. Applied only when it is known to be absent. */
const RULES: Record<EquipmentKey, RegExp> = {
  secondaryAir: /SEK_?LUFT|SEKUNDAER|SEK_PUMPE|SEK_VENTIL|(^|_)(SLP|SLV|SAF|SLS)(_|$)|DIAGNOSEWERTE_SEK/,
  exhaustFlap: /A_?KLAPPE|ABGASKLAPPE|(^|_)AKL(_|$)/,
  ac: /(^|_)(KO|AC)(_|$)|VON_AC|KLIMA|KOMPRESSOR/,
  electricFan: /E_LUEFTER/,
  steeringButtons: /MFL/,
  asc: /ASC/,
  egs: /EGS/,
  postCatSensors: /NKAT|NACHKAT|L_SONDE(_2)?_H(_|$)|SONDENHEIZUNG_NK|(^|_)RDY_LS|UMLS/,
  leakDiagnosis: /DMTL|TANK_?LECK|LECKMESSUNG|TEV_FUNC|FREIGABEZAEHLER/,
  bank2: /BANK_?2|_B2(_|$)|(^|_)INT_2(_|$)|LAMBDA_INTEGRATOR_2|L_SONDE_2|ADD_2|MUL_2|VKAT_SIGNAL_2|TV_2/,
};

export function isHiddenByEquipment(name: string, eq: Equipment | undefined): EquipmentKey | null {
  if (!eq) return null;
  const n = name.toUpperCase();
  for (const k of Object.keys(RULES) as EquipmentKey[]) if (eq[k] === false && RULES[k].test(n)) return k;
  return null;
}

/** Builds the equipment map from the DME results (any of them may be missing). */
export function equipmentFromDme(config: Record<string, unknown>, exhaust: Record<string, unknown>, ident: Record<string, unknown>): Equipment {
  const flag = (v: unknown) => (typeof v === 'number' && (v === 0 || v === 1) ? v === 1 : undefined);
  const eq: Equipment = {
    secondaryAir: flag(config.SLP_VORHANDEN),
    exhaustFlap: flag(config.AKLAPPE_VORHANDEN),
    ac: flag(config.AC_VORHANDEN),
    electricFan: flag(config.ELUEFTER_VORHANDEN),
    steeringButtons: flag(config.MFL_VORHANDEN),
    asc: flag(config.ASC_VORHANDEN),
    egs: flag(config.EGS_VORHANDEN),
    postCatSensors: flag(exhaust.ABGAS_VARIANTE_MONITOR_WERT),
    leakDiagnosis: flag(ident.ID_OBD2), // tank leak diagnosis only exists on OBD2 (US) cars
    bank2: ident.ID_LAMBDA_STEREO === 1 || flag(config.ZWEI_FLUTIG) === true ? true : flag(ident.ID_LAMBDA_STEREO),
  };
  for (const k of Object.keys(eq) as EquipmentKey[]) if (eq[k] === undefined) delete eq[k];
  return eq;
}
