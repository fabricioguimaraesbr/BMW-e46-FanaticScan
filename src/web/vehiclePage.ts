// Vehicle screen: the factory order from the instrument cluster (build date, type key, paint, upholstery,
// options) and whether VIN and mileage agree between the modules. Read-only.

import type { Value } from '../core/api/DiagSession';
import { FactoryOrder, IdentityEntry, cleanVin, compareIdentity, fmtKm, paintName, parseFa, saText, shortVin } from '../core/api/vehicle';
import type { PageCtx } from './ctx';
import { h } from './dom';

const V = {
  owner: null as unknown,
  loading: false,
  step: '',
  fa: null as FactoryOrder | null,
  faError: '',
  ids: [] as IdentityEntry[],
  readAt: 0,
};

export function resetVehicle() {
  Object.assign(V, { owner: null, loading: false, step: '', fa: null, faError: '', ids: [], readAt: 0 });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The first of these jobs the module file has as a reading. */
async function jobOf(ctx: PageCtx, group: string, names: string[]) {
  const jobs = await ctx.jobs(group).catch(() => []);
  return names.find((n) => jobs.some((j) => j.name === n && j.safety === 'read'));
}
const val = (vs: Value[], re: RegExp) => vs.find((v) => re.test(v.key))?.value;

async function readAll(ctx: PageCtx) {
  const s = ctx.session();
  if (!s || V.loading) return;
  ctx.stopLive();
  V.owner = s;
  V.loading = true;
  V.fa = null;
  V.faError = '';
  V.ids = [];
  ctx.setBusy('vehicle');
  ctx.rerender();
  const step = (t: string) => { V.step = t; const el = document.querySelector('#vh-step'); if (el) el.textContent = t; };
  const found = ctx.found();
  const mod = (short: string) => found.find((m) => m.def.short === short && m.scan?.variant && !m.dtcNA);
  const read = async (group: string, variant: string, names: string[]) => {
    const job = await jobOf(ctx, group, names);
    if (!job) return null;
    const r = await s.readValues(variant, job);
    return r.error ? { error: r.error, values: [] as Value[] } : { values: r.values };
  };
  try {
    const ike = mod('IKE');
    if (ike) {
      step('Reading the factory order from the instrument cluster…');
      const fa = await read(ike.def.group, ike.scan!.variant!, ['C_FA_LESEN']);
      if (!fa) V.faError = 'This cluster’s module file has no factory-order reading.';
      else if (fa.error) V.faError = fa.error;
      else {
        V.fa = parseFa(String(val(fa.values, /FAHRZEUGAUFTRAG/) ?? ''));
        if (!V.fa) V.faError = 'The cluster has no factory order stored (it is written when the car is coded).';
      }
      step('Reading VIN and odometer from the cluster…');
      const e: IdentityEntry = { module: 'IKE', label: ike.def.name };
      const vin = await read(ike.def.group, ike.scan!.variant!, ['AIF_FG_NR_LESEN', 'STATUS_AIF_FG_NR_LESEN']);
      e.vin = vin && !vin.error ? cleanVin(val(vin.values, /FG_NR/)) : undefined;
      const km = await read(ike.def.group, ike.scan!.variant!, ['AIF_GWSZ_LESEN', 'STATUS_AIF_GWSZ_LESEN']);
      const kmv = km && !km.error ? val(km.values, /GWSZ_WERT$/) : undefined;
      if (typeof kmv === 'number') e.odometer = kmv;
      if (vin?.error) e.error = vin.error;
      V.ids.push(e);
    } else V.faError = 'The instrument cluster did not answer the scan.';
    for (const [short, names] of [['EWS', ['FGNR_LESEN']], ['LCM', ['FG_NR_LESEN', 'C_FG_LESEN']], ['DME', ['AIF_LESEN']], ['EGS', ['AIF_LESEN']]] as const) {
      const m = mod(short);
      if (!m) continue;
      step(`Reading the VIN stored in the ${short}…`);
      const r = await read(m.def.group, m.scan!.variant!, [...names]);
      if (!r) continue;
      const e: IdentityEntry = { module: short, label: m.def.name };
      if (r.error) e.error = r.error;
      else {
        e.vin = cleanVin(val(r.values, /^(AIF_)?FG_?NR$|FAHRGESTELL/));
        const km = val(r.values, /AIF_KM_STAND/);
        if (typeof km === 'number' && km > 0) e.programmedKm = km;
        const d = val(r.values, /AIF_DATUM/);
        if (d && !/^0+[.]0+[.]0+$/.test(String(d))) e.programmedDate = String(d);
        const n = val(r.values, /AIF_ANZAHL_PROG/);
        if (typeof n === 'number' && e.vin) e.programmings = n;
      }
      V.ids.push(e);
    }
    ctx.log('info', `Vehicle data read: ${V.fa ? `factory order with ${V.fa.options.length} options` : 'no factory order'}, ${V.ids.filter((e) => e.vin).length} VINs`);
  } finally {
    V.loading = false;
    V.readAt = Date.now();
    ctx.setBusy('');
    ctx.rerender();
  }
}

function tile(label: string, value: string, sub = '') {
  return h('div', { class: 'vh-tile' }, h('span', {}, label), h('b', {}, value || '—'), sub ? h('small', {}, sub) : null);
}

export function renderVehicle(ctx: PageCtx): (Node | null)[] {
  const s = ctx.session();
  if (V.owner && V.owner !== s) resetVehicle();
  const head = h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Factory data and identity'), h('h1', {}, 'Vehicle')),
    h('div', { class: 'toolbar mh-tools' }, h('button', { class: 'btn', disabled: V.loading || ctx.busy() || ctx.scanning() || !s, onclick: () => readAll(ctx) }, V.readAt ? 'Read again' : 'Read')));
  if (!V.readAt && !V.loading && s && !ctx.scanning() && !ctx.busy() && ctx.found().length) setTimeout(() => { if (!V.readAt && !V.loading && document.querySelector('.vh')) void readAll(ctx); }, 0);
  if (V.loading || !V.readAt)
    return [head, h('div', { class: 'vh empty' }, h('strong', {}, ctx.scanning() ? 'Waiting for the scan to finish…' : 'Reading the car'), h('span', { id: 'vh-step' }, V.step || 'Factory order, VIN and odometer, from every module that keeps them.'))];

  const fa = V.fa;
  const ike = V.ids.find((e) => e.module === 'IKE');
  const vin = ike?.vin || V.ids.find((e) => e.vin)?.vin || '';
  const known = fa ? fa.options.filter((o) => saText(o)) : [];
  const unknown = fa ? fa.options.filter((o) => !saText(o)) : [];
  const findings = compareIdentity(V.ids);
  const worst = findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
  return [
    head,
    h('section', { class: 'vh vh-tiles' },
      tile('Built', fa?.built ? `${MONTHS[fa.built.month - 1]} ${fa.built.year}` : '', fa?.built ? 'from the factory order' : ''),
      tile('Type key', fa?.typeKey ?? '', fa?.series ? `${fa.series} series` : ''),
      tile('Paint', fa?.paint ? paintName(fa.paint) || `Code ${fa.paint.replace(/^0+/, '')}` : '', fa?.paint && paintName(fa.paint) ? `code ${fa.paint.replace(/^0+/, '')}` : ''),
      tile('Upholstery', fa?.upholstery ?? '', fa?.upholstery ? 'code' : ''),
      tile('Odometer', ike?.odometer !== undefined ? fmtKm(ike.odometer) : '', 'from the cluster'),
      tile('VIN', vin ? `…${shortVin(vin)}` : '', vin.length === 17 ? vin : vin ? 'last 7 characters' : ''),
    ),
    V.faError ? h('div', { class: 'msg info' }, V.faError) : null,
    fa
      ? h('section', { class: 'panel-sec' },
          h('div', { class: 'sec-head' }, h('h2', {}, 'Factory options'), h('span', {}, `${fa.options.length} codes`)),
          h('div', { class: 'vh-options' },
            known.map((o) => h('div', { class: 'vh-opt' }, h('b', {}, o.replace(/^0+/, '')), h('span', {}, saText(o)))),
            unknown.map((o) => h('div', { class: 'vh-opt muted' }, h('b', {}, o.replace(/^0+/, '')), h('span', {}, 'option code')))),
          fa.eWords.length || fa.hoWords.length ? h('p', { class: 'note' }, `Retrofit codes: ${[...fa.eWords.map((x) => `+${x}`), ...fa.hoWords.map((x) => `-${x}`)].join(' ')}`) : null,
          h('details', { class: 'vh-raw' }, h('summary', {}, 'Factory order as stored'), h('code', {}, fa.raw)),
          h('p', { class: 'refnote' }, 'Descriptions are given for common E46 options; the other codes are shown as stored. The same codes are on the data sticker in the spare wheel well or under the boot floor.'))
      : null,
    h('section', { class: 'panel-sec' },
      h('div', { class: 'sec-head' }, h('h2', {}, 'VIN and mileage between modules'), h('span', { class: `chip-mini ${worst}` }, worst === 'ok' ? 'Consistent' : 'Check')),
      h('ul', { class: 'verdicts' }, findings.map((f) => h('li', { class: f.level }, f.text))),
      h('table', { class: 'res vh-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Module'), h('th', {}, 'VIN'), h('th', {}, 'Mileage'), h('th', {}, 'Notes'))),
        h('tbody', {}, V.ids.map((e) => h('tr', { class: e.vin && vin && shortVin(e.vin) !== shortVin(vin) ? 'bad' : '' },
          h('td', {}, h('b', {}, e.module), h('small', {}, ` ${e.label}`)),
          h('td', { class: 'mono-v' }, e.vin || h('span', { class: 'muted' }, e.error ? 'not read' : 'not stored')),
          h('td', {}, e.odometer !== undefined ? `${fmtKm(e.odometer)} (odometer)` : e.programmedKm !== undefined ? `${fmtKm(e.programmedKm)} at programming` : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'muted' }, e.error ? e.error : [e.programmedDate ? `programmed ${e.programmedDate}` : '', e.programmings ? `${e.programmings} programmings` : ''].filter(Boolean).join(' · ')))))),
      h('p', { class: 'refnote' }, 'The E46 keeps the current mileage in the instrument cluster. The engine and gearbox computers store the mileage only when they are programmed, so it can only be lower than the odometer. Every module stores at least the last 7 characters of the VIN; they are compared on those.')),
  ];
}
