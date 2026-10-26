// Lists job / value labels that still look German after translation
import { readFileSync } from 'fs'; import { PrgFile, parseJobDoc } from '../src/core/prg/PrgFile';
import { describeJobs } from '../src/core/api/DiagSession'; import { valueLabel } from '../src/core/api/i18n-jobs'; import { VALUE_LABELS } from '../src/core/api/modules';
const D = (process.env.ECU_DIR ?? 'C:/EDIABAS/Ecu') + '/';
const de = /\b(lesen|auslesen|der|die|das|und|oder|fuer|mit|Fehler|Wert|Einheit|Ergebnis|Eingaenge|gewuenschte|Luft|Gang|Spannung|Temperatur|Drehzahl|Schalter|Sonde|Stellglied|ansteuern|Steuern|Komponente|Zaehler|Anzahl|Ansteuerung|Betrieb|nicht|Nein|Ja|aktiv|Ventil|Pumpe|Klappe|Leerlauf|Zeit|Strom)\b|ae|oe|ß/i;
const isGerman = (s: string) => de.test(s.replace(/value|request|true|queue/gi, ''));
let bad = 0, total = 0;
for (const f of process.argv.slice(2)) { const p = new PrgFile(f, readFileSync(D + f));
  for (const j of describeJobs(p)) { total++; if (isGerman(j.comment)) { bad++; console.log('JOB ', f, j.name, '|', j.comment); }
    for (const a of j.args) if (isGerman(a.comment)) console.log('ARG ', j.name, a.name, '|', a.comment);
    if (j.kind !== 'status') continue;
    for (const r of parseJobDoc(p, j.name)?.results ?? []) { if (/_EINH$|^JOB_STATUS$|^_/.test(r.name)) continue; const l = VALUE_LABELS[r.name] ?? valueLabel(r.name); total++; if (isGerman(l)) { bad++; console.log('VAL ', r.name, '|', l); } } } }
console.log('total', total, 'suspicious', bad);
