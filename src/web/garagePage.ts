// Garage screen: saved cars, the history of their scans and the comparison of two scans.
// Stored in this browser (localStorage) with export/import to a file, so nothing depends on a server.

import type { Dtc } from '../core/api/DiagSession';
import { addScan, diffScans, emptyGarage, findCarByVin, GarageCar, GarageData, GarageModule, GarageScan, mergeGarage, newId, normalizeVin, parseGarage } from '../core/api/garage';
import type { PageCtx } from './ctx';
import { confirmDialog, download, h, promptDialog, stamp, store } from './dom';

const KEY = 'e46diag.garage';
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const dtcCode = (d: Dtc) => d.label ?? (d.code > 0xff ? d.code.toString(16).toUpperCase().padStart(4, '0') : hex2(d.code));

export function loadGarage(): GarageData {
  const g = store.get<GarageData>(KEY, emptyGarage());
  return g && g.v === 1 && Array.isArray(g.cars) ? g : emptyGarage();
}
function saveGarage(g: GarageData) {
  if (!store.set(KEY, g)) alertMsg = 'Could not save in this browser (storage blocked or full). Export the garage to a file to keep it.';
}

let alertMsg = '';
let okMsg = '';
const view = { car: '' as string, compare: [] as string[], open: '' as string };

// ------------------------------------------------------------------ saving a scan

/** The VIN, read from the first module that reports it (cluster, immobiliser, light module, body module, DME). */
export async function readVin(ctx: PageCtx): Promise<string | undefined> {
  const s = ctx.session();
  if (!s || s.kind !== 'ediabas') return undefined;
  const order = ['IKE', 'EWS', 'LCM', 'ZKE', 'DME'];
  const jobs = ['AIF_FG_NR_LESEN', 'STATUS_AIF_FG_NR_LESEN', 'FGNR_LESEN', 'FG_NR_LESEN', 'C_FG_LESEN'];
  for (const short of order) {
    const m = ctx.found().find((x) => x.def.short === short && x.scan?.variant && !x.scan.variant.startsWith('native:'));
    if (!m) continue;
    const list = await ctx.jobs(m.def.group).catch(() => []);
    for (const j of jobs) {
      if (!list.some((x) => x.name === j)) continue;
      const r = await s.readValues(m.scan!.variant!, j);
      if (r.error) continue;
      for (const v of r.values) {
        const vin = normalizeVin(v.value);
        if (vin) return vin;
      }
    }
  }
  return undefined;
}

export function snapshot(ctx: PageCtx): GarageScan {
  return {
    id: newId(),
    at: new Date().toISOString(),
    source: ctx.mode() === 'sim' ? 'sim' : 'cable',
    modules: ctx.found().map((m): GarageModule => ({
      short: m.def.short,
      name: m.def.name,
      variant: m.scan!.variant!,
      part: m.scan!.ident.ID_BMW_NR !== undefined ? String(m.scan!.ident.ID_BMW_NR) : undefined,
      hw: m.scan!.ident.ID_HW_NR !== undefined ? String(m.scan!.ident.ID_HW_NR) : undefined,
      sw: m.scan!.ident.ID_SW_NR !== undefined ? String(m.scan!.ident.ID_SW_NR) : undefined,
      state: m.dtcNA ? 'id' : m.dtcs ? 'read' : 'error',
      dtcs: (m.dtcs ?? []).map((d) => ({ code: d.pcode ? `${dtcCode(d)} ${d.pcode}` : dtcCode(d), text: d.text, present: d.present })),
    })),
  };
}

/** Saves the current scan: to the car with the same VIN, or to a car the user picks or creates. */
export async function saveCurrentScan(ctx: PageCtx) {
  okMsg = alertMsg = '';
  if (!ctx.found().length) return;
  ctx.setBusy('garage');
  ctx.rerender();
  const vin = await readVin(ctx).catch(() => undefined);
  ctx.setBusy('');
  const g = loadGarage();
  let car = findCarByVin(g, vin);
  if (!car) {
    const pick = await pickCar(g, ctx.carTitle(), vin);
    if (!pick) return ctx.rerender();
    car = pick;
  }
  const dme = ctx.found().find((m) => m.def.short === 'DME');
  if (!car.engine && dme?.scan?.ident.ID_MOTOR) car.engine = String(dme.scan.ident.ID_MOTOR).split('_')[0];
  if (!car.vin && vin) car.vin = vin;
  addScan(g, car.id, snapshot(ctx));
  saveGarage(g);
  okMsg = `Scan saved to “${car.name}”.`;
  view.car = car.id;
  view.compare = [];
  ctx.log('info', `Scan saved to the garage (${car.name}${vin ? `, VIN …${vin.slice(-7)}` : ''})`);
  ctx.rerender();
}

function pickCar(g: GarageData, title: string, vin?: string): Promise<GarageCar | null> {
  return new Promise((resolve) => {
    const create = async () => {
      d.close();
      const name = await promptDialog('New car', vin ? `VIN ${vin}` : 'Give the car a name, for example its plate or a nickname.', title, 'Save scan');
      if (!name) return resolve(null);
      const car: GarageCar = { id: newId(), name, vin, createdAt: new Date().toISOString(), scans: [] };
      g.cars.push(car);
      resolve(car);
    };
    const d = h('dialog', { class: 'pick' },
      h('h2', {}, 'Save scan to the garage'),
      h('p', {}, vin ? `This car (VIN …${vin.slice(-7)}) is not in the garage yet.` : 'The VIN could not be read. Pick the car or add it.'),
      g.cars.length ? h('div', { class: 'pick-list' }, g.cars.map((c) => h('button', { class: 'btn', onclick: () => { d.close(); resolve(c); } }, h('b', {}, c.name), h('small', {}, ` ${c.scans.length} scans`)))) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { d.close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: create }, 'New car')),
    );
    d.addEventListener('cancel', () => resolve(null));
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => d.remove());
  });
}

// ------------------------------------------------------------------ screen

const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const faultCount = (s: GarageScan) => s.modules.reduce((n, m) => n + m.dtcs.length, 0);

function importFile(ctx: PageCtx) {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const g = loadGarage();
      const r = mergeGarage(g, parseGarage(await f.text()));
      saveGarage(g);
      okMsg = `Imported ${r.cars} ${r.cars === 1 ? 'car' : 'cars'} and ${r.scans} ${r.scans === 1 ? 'scan' : 'scans'}.`;
      alertMsg = '';
    } catch (e) {
      alertMsg = (e as Error).message || 'Could not read the file.';
    }
    ctx.rerender();
  });
  input.click();
}

export function renderGarage(ctx: PageCtx, standalone = false, back?: () => void): (Node | null)[] {
  const g = loadGarage();
  const car = g.cars.find((c) => c.id === view.car);
  const canSave = !standalone && ctx.found().length > 0 && !ctx.scanning();
  const head = h('div', { class: 'mh' },
    h('div', {}, h('p', { class: 'kicker' }, 'Saved cars and scan history'), h('h1', {}, car ? car.name : 'Garage')),
    h('div', { class: 'readouts' },
      h('div', {}, h('b', {}, String(g.cars.length)), h('span', {}, g.cars.length === 1 ? 'car' : 'cars')),
      h('div', {}, h('b', {}, String(g.cars.reduce((n, c) => n + c.scans.length, 0))), h('span', {}, 'scans saved'))));
  const toolbar = h('div', { class: 'toolbar' },
    back ? h('button', { class: 'btn', onclick: back }, '← Back') : null,
    car ? h('button', { class: 'btn', onclick: () => { view.car = ''; view.compare = []; ctx.rerender(); } }, '← All cars') : null,
    !standalone ? h('button', { class: 'btn primary', disabled: !canSave || ctx.busy(), onclick: () => saveCurrentScan(ctx) }, ctx.busy() ? 'Reading VIN…' : 'Save current scan') : null,
    h('button', { class: 'btn', disabled: !g.cars.length, onclick: () => download(`e46-garage-${stamp()}.json`, JSON.stringify(g, null, 1), 'application/json') }, 'Export garage'),
    h('button', { class: 'btn', onclick: () => importFile(ctx) }, 'Import'),
    h('span', { class: 'note' }, 'Kept in this browser. Export it to keep a copy or move it to another computer.'));
  const msgs = [okMsg ? h('div', { class: 'msg ok' }, okMsg) : null, alertMsg ? h('div', { class: 'msg err' }, alertMsg) : null];
  if (!car) {
    return [head, toolbar, ...msgs,
      g.cars.length
        ? h('div', { class: 'modgrid' }, g.cars.map((c) => {
            const last = c.scans[0];
            const n = last ? faultCount(last) : 0;
            return h('button', { class: `modcard ${last ? (n ? 'fault' : 'ok') : ''}`, onclick: () => { view.car = c.id; view.compare = []; okMsg = ''; ctx.rerender(); } },
              h('div', { class: 'mc-head' }, h('span', { class: `led ${last ? (n ? 'fault' : 'ok') : 'off'}` }), h('b', {}, c.name), h('span', { class: 'mc-file' }, c.engine ?? 'E46')),
              h('div', { class: 'mc-name' }, c.vin ? `VIN ${c.vin}` : 'VIN not read'),
              h('div', { class: 'mc-id' }, `${c.scans.length} ${c.scans.length === 1 ? 'scan' : 'scans'}${last ? ` · last ${fmtDate(last.at)}` : ''}`),
              last ? h('div', { class: `mc-faults ${n ? '' : 'clean'}` }, n ? `${n} ${n === 1 ? 'fault' : 'faults'} in the last scan` : 'No faults in the last scan') : null);
          }))
        : h('div', { class: 'empty' }, h('strong', {}, 'No cars yet'), standalone ? 'Connect to a car, scan it and press “Save current scan” in the Garage.' : 'Scan the car, then press “Save current scan”.'),
    ];
  }
  // ---- one car
  const scans = car.scans;
  const sel = view.compare.length === 2 ? view.compare : scans.slice(0, 2).map((s) => s.id);
  const [newer, older] = sel.map((id) => scans.find((s) => s.id === id)).filter((s): s is GarageScan => !!s).sort((a, b) => b.at.localeCompare(a.at));
  const toggle = (id: string) => {
    const cur = view.compare.length === 2 ? view.compare : sel;
    view.compare = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2);
    ctx.rerender();
  };
  const carTools = h('div', { class: 'toolbar' },
    h('button', { class: 'btn', onclick: async () => { const n = await promptDialog('Rename car', '', car.name, 'Rename'); if (n) { car.name = n; saveGarage(g); ctx.rerender(); } } }, 'Rename'),
    h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Delete this car?', `${car.name} and its ${scans.length} saved scans will be removed from this browser.`, 'Delete')) { g.cars = g.cars.filter((c) => c.id !== car.id); saveGarage(g); view.car = ''; ctx.rerender(); } } }, 'Delete car'),
    h('span', { class: 'note' }, `${car.vin ? `VIN ${car.vin} · ` : ''}${car.engine ? `${car.engine} · ` : ''}added ${fmtDate(car.createdAt)}`));
  const compare = newer && older ? renderDiff(older, newer) : h('p', { class: 'availnote' }, scans.length < 2 ? 'Save a second scan of this car to see what changed.' : 'Tick two scans to compare them.');
  return [head, toolbar, ...msgs, carTools,
    h('section', { class: 'lv-group' }, h('div', { class: 'lv-group-head' }, h('h2', {}, 'What changed'), newer && older ? h('span', {}, `${fmtDate(older.at)} → ${fmtDate(newer.at)}`) : null), compare),
    h('section', { class: 'lv-group' },
      h('div', { class: 'lv-group-head' }, h('h2', {}, 'Scans'), h('span', {}, 'tick two to compare')),
      scans.length ? h('div', { class: 'scanlist' }, scans.map((s) => {
        const n = faultCount(s);
        const open = view.open === s.id;
        return h('div', { class: `scanrow ${open ? 'open' : ''}` },
          h('label', { class: 'scan-pick' }, h('input', { type: 'checkbox', checked: sel.includes(s.id), onchange: () => toggle(s.id) })),
          h('button', { class: 'scan-main', 'aria-expanded': open ? 'true' : 'false', onclick: () => { view.open = open ? '' : s.id; ctx.rerender(); } },
            h('b', {}, fmtDate(s.at)), h('span', {}, `${s.modules.length} modules · ${n ? `${n} ${n === 1 ? 'fault' : 'faults'}` : 'no faults'}${s.source === 'sim' ? ' · simulator' : ''}`)),
          h('button', { class: 'btn ghost', title: 'Delete this scan', onclick: async () => { if (await confirmDialog('Delete this scan?', fmtDate(s.at), 'Delete')) { car.scans = car.scans.filter((x) => x.id !== s.id); saveGarage(g); ctx.rerender(); } } }, 'Delete'),
          open ? h('div', { class: 'scan-detail' }, s.modules.map((m) => h('div', { class: 'scan-mod' },
            h('b', {}, m.short), h('span', { class: 'muted' }, ` ${m.variant.startsWith('native:') ? 'plug & play' : m.variant.toUpperCase()}${m.part ? ` · part ${m.part}` : ''}`),
            m.state === 'id' ? h('div', { class: 'muted' }, 'identified only') : m.state === 'error' ? h('div', { class: 'muted' }, 'fault memory not read') : !m.dtcs.length ? h('div', { class: 'clean' }, 'no faults') :
              h('ul', { class: 'mc-faults' }, m.dtcs.map((d) => h('li', {}, h('span', { class: 'code' }, d.code), d.text)))))) : null);
      })) : h('div', { class: 'empty slim' }, 'No scans saved for this car.')),
  ];
}

function renderDiff(older: GarageScan, newer: GarageScan) {
  const d = diffScans(older, newer).filter((x) => x.added.length || x.cleared.length || x.kept.length || x.onlyIn);
  if (!d.length) return h('div', { class: 'empty slim clean' }, h('strong', {}, 'No faults in either scan'));
  const tot = (k: 'added' | 'cleared' | 'kept') => d.reduce((n, x) => n + x[k].length, 0);
  return h('div', {},
    h('div', { class: 'diff-sum' },
      h('span', { class: 'tag hot' }, `${tot('added')} new`), h('span', { class: 'tag ok' }, `${tot('cleared')} gone`), h('span', { class: 'tag' }, `${tot('kept')} still there`)),
    h('div', { class: 'diff' }, d.map((x) => h('div', { class: 'diff-mod' },
      h('b', {}, x.module), h('span', { class: 'muted' }, ` ${x.name}`),
      x.onlyIn ? h('div', { class: 'muted' }, x.onlyIn === 'older' ? 'did not answer in the newer scan' : 'did not answer in the older scan') : null,
      h('ul', { class: 'diff-list' },
        x.added.map((f) => h('li', { class: 'added' }, h('span', { class: 'code' }, f.code), f.text, h('em', {}, ' new'))),
        x.cleared.map((f) => h('li', { class: 'cleared' }, h('span', { class: 'code' }, f.code), f.text, h('em', {}, ' gone'))),
        x.kept.map((f) => h('li', { class: 'kept' }, h('span', { class: 'code' }, f.code), f.text, h('em', {}, ' still there'))))))));
}
