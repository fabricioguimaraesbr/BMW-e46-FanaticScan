// Generic OBD-II powertrain code descriptions (SAE J2012 code meanings, worded for this project).
// Codes not listed fall back to the system their number range belongs to.

const CODES: Record<string, string> = {
  // camshaft actuator / timing (VANOS on BMW)
  P0010: 'Intake camshaft actuator circuit (bank 1)', P0011: 'Intake camshaft timing over-advanced or system performance (bank 1)',
  P0012: 'Intake camshaft timing over-retarded (bank 1)', P0013: 'Exhaust camshaft actuator circuit (bank 1)',
  P0014: 'Exhaust camshaft timing over-advanced or system performance (bank 1)', P0015: 'Exhaust camshaft timing over-retarded (bank 1)',
  P0016: 'Crankshaft / intake camshaft position correlation (bank 1)', P0017: 'Crankshaft / exhaust camshaft position correlation (bank 1)',
  P0018: 'Crankshaft / intake camshaft position correlation (bank 2)', P0019: 'Crankshaft / exhaust camshaft position correlation (bank 2)',
  P0020: 'Intake camshaft actuator circuit (bank 2)', P0021: 'Intake camshaft timing over-advanced or system performance (bank 2)',
  P0022: 'Intake camshaft timing over-retarded (bank 2)',
  // O2 sensor heaters
  P0030: 'O2 sensor heater control circuit (bank 1 sensor 1)', P0031: 'O2 sensor heater circuit low (bank 1 sensor 1)', P0032: 'O2 sensor heater circuit high (bank 1 sensor 1)',
  P0036: 'O2 sensor heater control circuit (bank 1 sensor 2)', P0037: 'O2 sensor heater circuit low (bank 1 sensor 2)', P0038: 'O2 sensor heater circuit high (bank 1 sensor 2)',
  P0050: 'O2 sensor heater control circuit (bank 2 sensor 1)', P0051: 'O2 sensor heater circuit low (bank 2 sensor 1)', P0052: 'O2 sensor heater circuit high (bank 2 sensor 1)',
  P0056: 'O2 sensor heater control circuit (bank 2 sensor 2)', P0057: 'O2 sensor heater circuit low (bank 2 sensor 2)', P0058: 'O2 sensor heater circuit high (bank 2 sensor 2)',
  // fuel and air metering
  P0100: 'Mass air flow sensor circuit', P0101: 'Mass air flow sensor range/performance', P0102: 'Mass air flow sensor circuit low',
  P0103: 'Mass air flow sensor circuit high', P0104: 'Mass air flow sensor circuit intermittent',
  P0105: 'Manifold pressure / barometric sensor circuit', P0106: 'Manifold pressure / barometric sensor range/performance',
  P0107: 'Manifold pressure / barometric sensor circuit low', P0108: 'Manifold pressure / barometric sensor circuit high',
  P0110: 'Intake air temperature sensor circuit', P0111: 'Intake air temperature sensor range/performance',
  P0112: 'Intake air temperature sensor circuit low', P0113: 'Intake air temperature sensor circuit high',
  P0115: 'Coolant temperature sensor circuit', P0116: 'Coolant temperature sensor range/performance',
  P0117: 'Coolant temperature sensor circuit low', P0118: 'Coolant temperature sensor circuit high', P0119: 'Coolant temperature sensor circuit intermittent',
  P0120: 'Throttle/pedal position sensor A circuit', P0121: 'Throttle/pedal position sensor A range/performance',
  P0122: 'Throttle/pedal position sensor A circuit low', P0123: 'Throttle/pedal position sensor A circuit high',
  P0125: 'Coolant temperature too low for closed-loop fuel control', P0128: 'Coolant below thermostat regulating temperature (thermostat)',
  P0130: 'O2 sensor circuit (bank 1 sensor 1)', P0131: 'O2 sensor circuit low voltage (bank 1 sensor 1)', P0132: 'O2 sensor circuit high voltage (bank 1 sensor 1)',
  P0133: 'O2 sensor slow response (bank 1 sensor 1)', P0134: 'O2 sensor no activity (bank 1 sensor 1)', P0135: 'O2 sensor heater circuit (bank 1 sensor 1)',
  P0136: 'O2 sensor circuit (bank 1 sensor 2)', P0137: 'O2 sensor circuit low voltage (bank 1 sensor 2)', P0138: 'O2 sensor circuit high voltage (bank 1 sensor 2)',
  P0139: 'O2 sensor slow response (bank 1 sensor 2)', P0140: 'O2 sensor no activity (bank 1 sensor 2)', P0141: 'O2 sensor heater circuit (bank 1 sensor 2)',
  P0150: 'O2 sensor circuit (bank 2 sensor 1)', P0151: 'O2 sensor circuit low voltage (bank 2 sensor 1)', P0152: 'O2 sensor circuit high voltage (bank 2 sensor 1)',
  P0153: 'O2 sensor slow response (bank 2 sensor 1)', P0154: 'O2 sensor no activity (bank 2 sensor 1)', P0155: 'O2 sensor heater circuit (bank 2 sensor 1)',
  P0156: 'O2 sensor circuit (bank 2 sensor 2)', P0157: 'O2 sensor circuit low voltage (bank 2 sensor 2)', P0158: 'O2 sensor circuit high voltage (bank 2 sensor 2)',
  P0159: 'O2 sensor slow response (bank 2 sensor 2)', P0160: 'O2 sensor no activity (bank 2 sensor 2)', P0161: 'O2 sensor heater circuit (bank 2 sensor 2)',
  P0170: 'Fuel trim malfunction (bank 1)', P0171: 'System too lean (bank 1)', P0172: 'System too rich (bank 1)',
  P0173: 'Fuel trim malfunction (bank 2)', P0174: 'System too lean (bank 2)', P0175: 'System too rich (bank 2)',
  P0180: 'Fuel temperature sensor circuit', P0190: 'Fuel rail pressure sensor circuit',
  // injectors
  P0200: 'Injector circuit', P0201: 'Injector circuit, cylinder 1', P0202: 'Injector circuit, cylinder 2', P0203: 'Injector circuit, cylinder 3',
  P0204: 'Injector circuit, cylinder 4', P0205: 'Injector circuit, cylinder 5', P0206: 'Injector circuit, cylinder 6',
  P0220: 'Throttle/pedal position sensor B circuit', P0221: 'Throttle/pedal position sensor B range/performance',
  P0222: 'Throttle/pedal position sensor B circuit low', P0223: 'Throttle/pedal position sensor B circuit high',
  P0230: 'Fuel pump primary circuit',
  P0261: 'Injector circuit low, cylinder 1', P0262: 'Injector circuit high, cylinder 1', P0264: 'Injector circuit low, cylinder 2', P0265: 'Injector circuit high, cylinder 2',
  P0267: 'Injector circuit low, cylinder 3', P0268: 'Injector circuit high, cylinder 3', P0270: 'Injector circuit low, cylinder 4', P0271: 'Injector circuit high, cylinder 4',
  P0273: 'Injector circuit low, cylinder 5', P0274: 'Injector circuit high, cylinder 5', P0276: 'Injector circuit low, cylinder 6', P0277: 'Injector circuit high, cylinder 6',
  // misfire, knock, crank/cam sensors
  P0300: 'Random / multiple cylinder misfire detected', P0301: 'Cylinder 1 misfire detected', P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected', P0304: 'Cylinder 4 misfire detected', P0305: 'Cylinder 5 misfire detected', P0306: 'Cylinder 6 misfire detected',
  P0313: 'Misfire detected with low fuel level',
  P0325: 'Knock sensor 1 circuit (bank 1)', P0326: 'Knock sensor 1 range/performance (bank 1)', P0327: 'Knock sensor 1 circuit low (bank 1)', P0328: 'Knock sensor 1 circuit high (bank 1)',
  P0330: 'Knock sensor 2 circuit (bank 2)', P0332: 'Knock sensor 2 circuit low (bank 2)', P0333: 'Knock sensor 2 circuit high (bank 2)',
  P0335: 'Crankshaft position sensor circuit', P0336: 'Crankshaft position sensor range/performance', P0337: 'Crankshaft position sensor circuit low',
  P0338: 'Crankshaft position sensor circuit high', P0339: 'Crankshaft position sensor circuit intermittent',
  P0340: 'Camshaft position sensor circuit (bank 1)', P0341: 'Camshaft position sensor range/performance (bank 1)', P0342: 'Camshaft position sensor circuit low (bank 1)',
  P0343: 'Camshaft position sensor circuit high (bank 1)', P0344: 'Camshaft position sensor circuit intermittent (bank 1)',
  P0345: 'Camshaft position sensor circuit (bank 2)', P0365: 'Exhaust camshaft position sensor circuit (bank 1)', P0366: 'Exhaust camshaft position sensor range/performance (bank 1)',
  P0351: 'Ignition coil 1 primary/secondary circuit', P0352: 'Ignition coil 2 primary/secondary circuit', P0353: 'Ignition coil 3 primary/secondary circuit',
  P0354: 'Ignition coil 4 primary/secondary circuit', P0355: 'Ignition coil 5 primary/secondary circuit', P0356: 'Ignition coil 6 primary/secondary circuit',
  // auxiliary emission controls
  P0400: 'Exhaust gas recirculation flow', P0410: 'Secondary air injection system', P0411: 'Secondary air injection incorrect flow detected',
  P0412: 'Secondary air injection switching valve circuit', P0413: 'Secondary air injection switching valve circuit open', P0414: 'Secondary air injection switching valve circuit shorted',
  P0418: 'Secondary air injection pump relay circuit', P0420: 'Catalyst efficiency below threshold (bank 1)', P0421: 'Warm-up catalyst efficiency below threshold (bank 1)',
  P0430: 'Catalyst efficiency below threshold (bank 2)', P0431: 'Warm-up catalyst efficiency below threshold (bank 2)',
  P0440: 'Evaporative emission system', P0441: 'Evaporative emission system incorrect purge flow', P0442: 'Evaporative emission system small leak detected',
  P0443: 'Evaporative emission purge valve circuit', P0444: 'Evaporative emission purge valve circuit open', P0445: 'Evaporative emission purge valve circuit shorted',
  P0455: 'Evaporative emission system large leak detected', P0456: 'Evaporative emission system very small leak detected',
  P0460: 'Fuel level sensor circuit', P0461: 'Fuel level sensor range/performance', P0462: 'Fuel level sensor circuit low', P0463: 'Fuel level sensor circuit high',
  P0480: 'Cooling fan 1 control circuit', P0481: 'Cooling fan 2 control circuit',
  // speed, idle control, auxiliary inputs
  P0500: 'Vehicle speed sensor', P0501: 'Vehicle speed sensor range/performance', P0503: 'Vehicle speed sensor intermittent/erratic',
  P0505: 'Idle air control system', P0506: 'Idle speed lower than expected', P0507: 'Idle speed higher than expected',
  P0511: 'Idle air control circuit', P0560: 'System voltage', P0562: 'System voltage low', P0563: 'System voltage high',
  P0571: 'Brake switch A circuit',
  // control module and outputs
  P0600: 'Serial communication link', P0601: 'Control module memory checksum error', P0602: 'Control module programming error',
  P0603: 'Control module keep-alive memory error', P0604: 'Control module RAM error', P0605: 'Control module ROM error', P0606: 'Control module processor',
  P0640: 'Intake air heater control circuit', P0650: 'Check engine light (MIL) control circuit',
  // transmission
  P0700: 'Transmission control system (see transmission module)', P0705: 'Transmission range sensor circuit', P0710: 'Transmission fluid temperature sensor circuit',
  P0715: 'Turbine speed sensor circuit', P0720: 'Output speed sensor circuit', P0730: 'Incorrect gear ratio', P0740: 'Torque converter clutch circuit',
  P0750: 'Shift solenoid A', P0755: 'Shift solenoid B', P0760: 'Shift solenoid C',
  // newer generic codes seen on 2003+ E46
  P2096: 'Post-catalyst fuel trim too lean (bank 1)', P2097: 'Post-catalyst fuel trim too rich (bank 1)',
  P2098: 'Post-catalyst fuel trim too lean (bank 2)', P2099: 'Post-catalyst fuel trim too rich (bank 2)',
  P2187: 'System too lean at idle (bank 1)', P2188: 'System too rich at idle (bank 1)', P2189: 'System too lean at idle (bank 2)', P2190: 'System too rich at idle (bank 2)',
  P2195: 'O2 sensor signal stuck lean (bank 1 sensor 1)', P2196: 'O2 sensor signal stuck rich (bank 1 sensor 1)',
  P2197: 'O2 sensor signal stuck lean (bank 2 sensor 1)', P2198: 'O2 sensor signal stuck rich (bank 2 sensor 1)',
};

/** System ranges of SAE J2012, used when a code is not in the table. */
const RANGES: [number, number, string][] = [
  [0x0000, 0x00ff, 'Fuel and air metering, auxiliary emission controls'],
  [0x0100, 0x01ff, 'Fuel and air metering'],
  [0x0200, 0x02ff, 'Fuel and air metering (injector circuits)'],
  [0x0300, 0x03ff, 'Ignition system or misfire'],
  [0x0400, 0x04ff, 'Auxiliary emission controls'],
  [0x0500, 0x05ff, 'Vehicle speed, idle control and auxiliary inputs'],
  [0x0600, 0x06ff, 'Control module and output circuits'],
  [0x0700, 0x09ff, 'Transmission'],
];

export function describePcode(code: string): string {
  if (CODES[code]) return CODES[code];
  const sys = code[0];
  const group = code[1];
  if (sys !== 'P') return `${{ C: 'Chassis', B: 'Body', U: 'Network' }[sys] ?? 'Unknown'} code`;
  if (group === '1' || group === '3') return 'Manufacturer-specific code (BMW). Exact meaning needs the BMW module files.';
  const n = parseInt(code.slice(2), 16);
  const r = RANGES.find(([a, b]) => n >= a && n <= b);
  return r ? `${r[2]} (generic code)` : 'Generic powertrain code';
}
