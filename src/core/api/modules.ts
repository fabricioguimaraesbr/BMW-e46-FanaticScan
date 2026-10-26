// E46 diagnostic addresses (DS2) and the EDIABAS group file that identifies the variant behind each one.

export interface ModuleDef {
  group: string; // EDIABAS group file (variant is resolved by its IDENTIFIKATION job)
  address: number;
  short: string;
  name: string;
}

export const E46_MODULES: ModuleDef[] = [
  { group: 'd_0012', address: 0x12, short: 'DME', name: 'Engine (DME)' },
  { group: 'd_0032', address: 0x32, short: 'EGS', name: 'Automatic transmission' },
  { group: 'd_0056', address: 0x56, short: 'ABS', name: 'ABS / ASC / DSC' },
  { group: 'd_0044', address: 0x44, short: 'EWS', name: 'Immobilizer (EWS)' },
  { group: 'd_0080', address: 0x80, short: 'IKE', name: 'Instrument cluster' },
  { group: 'd_00d0', address: 0xd0, short: 'LCM', name: 'Light control module' },
  { group: 'd_0000', address: 0x00, short: 'ZKE', name: 'Body module (GM5/ZKE)' },
  { group: 'd_005b', address: 0x5b, short: 'IHKA', name: 'Climate control (IHKA)' },
  { group: 'd_00a4', address: 0xa4, short: 'MRS', name: 'Airbag (MRS)' },
  { group: 'd_0008', address: 0x08, short: 'SHD', name: 'Sunroof (SHD)' },
  { group: 'd_0060', address: 0x60, short: 'PDC', name: 'Park distance control' },
  { group: 'd_0068', address: 0x68, short: 'RAD', name: 'Radio' },
  { group: 'd_0070', address: 0x70, short: '0x70', name: 'Module 0x70' },
];

/** English labels for the MS43 measured values (falls back to the SGBD name). */
export const VALUE_LABELS: Record<string, string> = {
  STAT_MOTORDREHZAHL_MWB_WERT: 'Engine speed',
  STAT_GESCHWINDIGKEIT_MWB_WERT: 'Vehicle speed',
  STAT_PWG_WINKEL_MWB_WERT: 'Accelerator pedal',
  STAT_DKP_WINKEL_MWB_WERT: 'Throttle angle',
  STAT_LMM_MASSE_MWB_WERT: 'Air mass (MAF)',
  STAT_AN_LUFTTEMP_MWB_WERT: 'Intake air temp',
  STAT_MOTORTEMP_MWB_WERT: 'Coolant temp',
  STAT_OEL_TEMP_MWB_WERT: 'Oil temp',
  STAT_KUEHLW_AUSL_TEMP_MWB_WERT: 'Radiator outlet temp',
  STAT_ZUENDWINKEL_MWB_WERT: 'Ignition timing',
  STAT_EINSPRITZZEIT_MWB_WERT: 'Injection time',
  STAT_LL_INTEGRATOR_MWB_WERT: 'Idle integrator',
  STAT_LL_STELLER_TV_MWB_WERT: 'Idle valve duty (ICV)',
  STAT_VANOS_NW_LAGE_EINLASS_MWB_WERT: 'VANOS intake',
  STAT_VANOS_NW_LAGE_AUSLASS_MWB_WERT: 'VANOS exhaust',
  STAT_KL15_MWB_WERT: 'Ignition voltage (KL15)',
  STAT_LAMBDA_INTEGRATOR_1_MWB_WERT: 'Lambda trim bank 1',
  STAT_LAMBDA_INTEGRATOR_2_MWB_WERT: 'Lambda trim bank 2',
  STAT_LS_VKAT_HEIZUNG_TV_1_MWB_WERT: 'O2 heater pre-cat 1',
  STAT_LS_VKAT_HEIZUNG_TV_2_MWB_WERT: 'O2 heater pre-cat 2',
  STAT_LS_NKAT_HEIZUNG_TV_1_MWB_WERT: 'O2 heater post-cat 1',
  STAT_LS_NKAT_HEIZUNG_TV_2_MWB_WERT: 'O2 heater post-cat 2',
  STAT_LAST_MWB_WERT: 'Engine load',
  STAT_K_MW_2_MWB_WERT: 'Signal K_MW_2',
  STAT_K_MW_5_MWB_WERT: 'Signal K_MW_5',
  STAT_DREHZAHL_E_LUEFTER_VON_AC_MWB_WERT: 'Electric fan (A/C request)',
  STAT_LUFTDRUCK_MWB_WERT: 'Barometric pressure',
  STAT_UBATT_MWB_WERT: 'Battery voltage',
};

export const UNIT_LABELS: Record<string, string> = {
  '1/min': 'rpm',
  GradC: '°C',
  'Grad C': '°C',
  'Grad KW': '°KW',
  Grad: '°',
  GradKW: '°KW',
  GradDK: '°',
  GradPWG: '°',
  'mg/HUB': 'mg/stroke',
  'mg/stk': 'mg/stroke',
  'Grad C ': '°C',
};
