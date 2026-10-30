// E46 diagnostic addresses (DS2) and the EDIABAS group file that identifies the variant behind each one.

export interface ModuleDef {
  group: string; // EDIABAS group file (variant is resolved by its IDENTIFIKATION job)
  address: number;
  short: string;
  name: string;
  /** SGBD variants the group can resolve to on an E46 (for the documentation) */
  variants?: string[];
  /** fitted only on some cars: scanned when "include optional modules" is on */
  optional?: boolean;
}

/** The modules every E46 scan looks for. */
export const E46_MODULES: ModuleDef[] = [
  { group: 'd_0012', address: 0x12, short: 'DME', name: 'Engine (DME)', variants: ['ms420ds0 (MS42, M52TU)', 'ms430ds0 (MS43, M54)', 'ms450ds0 (MS45, M54 2003+)', 'mss54ds0 (MSS54, S54)', 'me9k_ng4 / me9k42 / mev9n46 / me9n45 (ME9, N42/N46)', 'bms43ds0 / bms46ds0 (BMS43/46, M43)', 'dde40kw0 / dde41kr0 / dde50k47 / d50m47… (DDE, M47/M57 diesel)'] },
  { group: 'd_0032', address: 0x32, short: 'EGS', name: 'Automatic transmission', variants: ['gs8604 / gs8600–gs8603 (GS8.60, ZF 5HP19)', 'gs20 (GS20, GM 5L40)', 'gs19 / gs19a / gs19b (GS19)', 'smg / smg2 (SMG)'] },
  { group: 'd_0056', address: 0x56, short: 'ABS', name: 'ABS / ASC / DSC', variants: ['ascmk20 / absmk20 (MK20)', 'dsc_e46 / dsc3 (DSC III)', 'dsc_mk60 (MK60)', 'asc5 / dsc5 / asc57 / dsc57 (ASC/DSC 5.7)'] },
  { group: 'd_0044', address: 0x44, short: 'EWS', name: 'Immobilizer (EWS)', variants: ['ews3 / ews3d', 'ews'] },
  { group: 'd_0080', address: 0x80, short: 'IKE', name: 'Instrument cluster', variants: ['kombi46 / kombi46r', 'ike'] },
  { group: 'd_00d0', address: 0xd0, short: 'LCM', name: 'Light control module', variants: ['lsz / lsz_2', 'lcm / lcm_a / lcm_ii / lcm_iii / lcm_iv'] },
  { group: 'd_0000', address: 0x00, short: 'ZKE', name: 'Body module (GM5/ZKE)', variants: ['zke5 / zke5_s12'] },
  { group: 'd_005b', address: 0x5b, short: 'IHKA', name: 'Climate control (IHKA)', variants: ['ihka46 / ihka46_2 / ihka46_3', 'ihkr46'] },
  { group: 'd_00a4', address: 0xa4, short: 'MRS', name: 'Airbag (MRS)', variants: ['mrs3 / mrs3kw', 'mrs4 / mrs4rd', 'mrs5 / mrs5k', 'mrs2'] },
  { group: 'd_0008', address: 0x08, short: 'SHD', name: 'Sunroof (SHD)', variants: ['shd46 / shd46_2', 'sd_ds2'] },
  { group: 'd_0060', address: 0x60, short: 'PDC', name: 'Park distance control', variants: ['pdce38', 'pdcact'] },
  { group: 'd_0068', address: 0x68, short: 'RAD', name: 'Radio', variants: ['rad_83'] },
  { group: 'd_0070', address: 0x70, short: 'RDC', name: 'Tyre pressure (RDC / DWS)', variants: ['rdc / rdc_53 / rdc_kbus', 'dws'] },
];

/** Modules only some E46s have (navigation, telephone, seats, sensors…). */
export const E46_OPTIONAL_MODULES: ModuleDef[] = [
  { group: 'd_0057', address: 0x57, short: 'LWS', name: 'Steering angle sensor', variants: ['lws5 / lws5_2 / lws5_1b'], optional: true },
  { group: 'd_009a', address: 0x9a, short: 'LWR', name: 'Headlight leveling (xenon)', variants: ['lwr2a'], optional: true },
  { group: 'd_00e8', address: 0xe8, short: 'RLS', name: 'Rain / light sensor', variants: ['rls_ds2'], optional: true },
  { group: 'd_0050', address: 0x50, short: 'MFL', name: 'Steering wheel buttons', variants: ['mfl / mfl2 / mflr / mflr50'], optional: true },
  { group: 'd_0040', address: 0x40, short: 'FBZV', name: 'Remote key receiver', variants: ['fbzv'], optional: true },
  { group: 'd_0072', address: 0x72, short: 'SM', name: 'Seat memory (driver)', variants: ['sm46 / sm46_3 / sm46_4 / sm46c_4 / sm46c_5'], optional: true },
  { group: 'd_00da', address: 0xda, short: 'SMB', name: 'Seat memory (passenger)', variants: ['b_sm46_3 / b_sm46_4 / bsm46c_4 / bsm46c_5'], optional: true },
  { group: 'd_007f', address: 0x7f, short: 'NAV', name: 'Navigation', variants: ['navmk2 / navmk3 / navmk4 / navmk4_2 / navigat'], optional: true },
  { group: 'd_00f0', address: 0xf0, short: 'BMBT', name: 'Board monitor', variants: ['bm46wide / bmbt46rn / bmbt46tn / bordmoni'], optional: true },
  { group: 'd_003b', address: 0x3b, short: 'GT', name: 'Navigation video (GT)', variants: ['video_gt'], optional: true },
  { group: 'd_00ed', address: 0xed, short: 'VM', name: 'Video module / TV', variants: ['videomod / video_tv / video_3 / vm5ibus'], optional: true },
  { group: 'd_00c8', address: 0xc8, short: 'TEL', name: 'Telephone', variants: ['telibus / telibus2 / telibus3 / ulf / bit'], optional: true },
  { group: 'd_006a', address: 0x6a, short: 'DSP', name: 'Sound amplifier (DSP)', variants: ['dsp / dsp2 / topdsp / topdsp2'], optional: true },
  { group: 'd_0076', address: 0x76, short: 'CDC', name: 'CD changer', variants: ['cdc / cdc_46'], optional: true },
  { group: 'd_00b0', address: 0xb0, short: 'SES', name: 'Voice control', variants: ['ses'], optional: true },
];

export const ALL_E46_MODULES: ModuleDef[] = [...E46_MODULES, ...E46_OPTIONAL_MODULES];

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
  // MS45 (Siemens names)
  STAT_TE_WERT: 'Injection time',
  STAT_FR_WERT: 'Mixture control bank 1',
  STAT_FR2_WERT: 'Mixture control bank 2',
  STAT_VFZG_WERT: 'Vehicle speed',
  STAT_NMOT_WERT: 'Engine speed',
  STAT_NSOL_WERT: 'Idle speed target',
  STAT_WNWKWE_WERT: 'VANOS intake',
  STAT_WNWKWA_WERT: 'VANOS exhaust',
  STAT_TANS_WERT: 'Intake air temp',
  STAT_TMOT_WERT: 'Coolant temp',
  STAT_ZWOUT_WERT: 'Ignition timing',
  STAT_WDKBA_WERT: 'Throttle angle',
  STAT_MSHFM_WERT: 'Air mass (MAF)',
  STAT_MIIST_WERT: 'Engine torque (actual)',
  STAT_UB_WERT: 'Battery voltage',
  STAT_UPWG_WERT: 'Accelerator pedal voltage',
  STAT_TKA_WERT: 'Radiator outlet temp',
  STAT_RKRN1_WERT: 'Knock retard cyl. 1',
  STAT_RKRN2_WERT: 'Knock retard cyl. 2',
  STAT_RKRN3_WERT: 'Knock retard cyl. 3',
  STAT_RKRN4_WERT: 'Knock retard cyl. 4',
  STAT_RKRN5_WERT: 'Knock retard cyl. 5',
  STAT_RKRN6_WERT: 'Knock retard cyl. 6',
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
