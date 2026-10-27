import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { translate } from '../src/core/api/i18n-en';
import { PrgFile } from '../src/core/prg/PrgFile';

describe('fault text translation', () => {
  it('translates the faults seen on the real 325i (27/10/2026)', () => {
    expect(translate('WC-Toleranz erhoeht bei Schluessel Nummer 7')).toBe('Rolling-code tolerance increased for key number 7');
    expect(translate('keine CAN ID DME1')).toBe('No CAN ID DME1');
    expect(translate('Ansteuerung Motor fuer LWR 1')).toBe('Headlight leveling motor 1 drive');
    expect(translate('Aussentemperatur')).toBe('Outside temperature');
    expect(translate('Diebstahlwarnanlage: Sirene, Funkinnenraumschutz, Neigungsgeber oder Leitung STDWA Kurzschluss gegen Masse oder Leitungsunterbrechung'))
      .toBe('Alarm system: siren, interior motion sensor, tilt sensor or STDWA line short to ground or open circuit');
  });
  it('glossary fallback does not mangle already-English words', () => {
    expect(translate('Temperatur Getriebe xyz')).not.toMatch(/temperaturee/i);
  });
  const dir = process.env.ECU_DIR;
  it.skipIf(!dir || !existsSync(dir))('every fault table text of the module files has a dictionary translation', () => {
    const german = /(ae|oe|ue|ß|ä|ö|ü)|\b(der|die|das|und|oder|nicht|kein|keine|Fehler|Leitung|Masse|Unterbrechung|Spannung|Ansteuerung|Botschaft|links|rechts|defekt)\b/i;
    const stillGerman = /ß|ä|ö|ü|\b(der|die|das|und|oder|nicht|kein|keine|Fehler|Leitung|Masse|Unterbrechung|Spannung|Ansteuerung|Botschaft|links|rechts|defekt|fuer|ueber|bei|zu|Schalter|Ventil|Relais|Geber|Fuehler|Steuergeraet)\b/i;
    const left: string[] = [];
    for (const f of readdirSync(dir!)) {
      if (!/\.prg$/i.test(f)) continue;
      const p = new PrgFile(f, readFileSync(`${dir}/${f}`));
      for (const t of ['FORTTEXTE', 'FARTTEXTE', 'FUMWELTTEXTE'])
        for (const r of p.tableRows(t)?.slice(1) ?? []) {
          const s = r[1]?.trim(); if (!s || !german.test(s)) continue;
          if (stillGerman.test(translate(s))) left.push(`${f}: ${s} -> ${translate(s)}`);
        }
    }
    expect(left.slice(0, 20)).toEqual([]);
  });
});
