// Engine cooling screen (DME calibration, MS42 / MS43): opens a DME read file (.bin), finds the software version,
// applies the matching ms4x-net definition and shows the e-thermostat targets, the conditions around them and the
// fan stages. The target maps and conditions can be edited into a new file (checksums recomputed). Nothing here talks
// to the car yet: reading the DME through the cable and writing it back are later steps (see src/core/dme/).

import {
  COOLING_EDITABLE, COOLING_LABELS, COOLING_LIMITS, type Draft, type ItemValues, buildEditedImage, capMap, quantizeAtMost, checkDefinitionFits, checkDraft, coolingItems, quantize, readItem,
} from '../core/dme/calibration';
import type { DmeItem } from '../core/dme/defs';
import { type ChecksumCheck, type DmeImageInfo, SUPPORTED, checkChecksums, identifyImage } from '../core/dme/image';
import type { PageCtx } from './ctx';
import { h } from './dom';

const K = {
  name: '',
  bytes: null as Uint8Array | null,
  info: null as DmeImageInfo | null,
  sums: [] as ChecksumCheck[],
  fit: [] as string[],
  values: {} as Record<string, ItemValues>,
  draft: {} as Draft,
  msg: null as { kind: 'ok' | 'err' | 'warn' | 'info'; text: string } | null,
};

export function resetCooling() {
  Object.assign(K, { name: '', bytes: null, info: null, sums: [], fit: [], values: {}, draft: {}, msg: null });
}

const fmt = (v: number, d: number) => {
  if (Number.isInteger(v)) return String(v);
  const t = v.toFixed(Math.min(d, 2));
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
};
const hex = (n: number, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');

async function openFile(ctx: PageCtx | null, rerender: () => void, f: File) {
  resetCooling();
  K.name = f.name;
  try {
    const b = new Uint8Array(await f.arrayBuffer());
    const info = identifyImage(b);
    K.bytes = b;
    K.info = info;
    K.sums = checkChecksums(b, info);
    if (info.def) {
      const names = coolingItems(info.def).flatMap((g) => g.items.map((i) => i.name));
      K.fit = checkDefinitionFits(b, info, info.def, names);
      if (!K.fit.length) for (const i of info.def.items) if (names.includes(i.name)) K.values[i.name] = readItem(b, info, info.def, i);
    }
    ctx?.log('info', `DME read opened: ${f.name}, ${info.family} ${info.version} (${info.kind === 'full' ? '512 KB' : 'calibration'})`);
  } catch (e) {
    K.msg = { kind: 'err', text: (e as Error).message };
  }
  rerender();
}

/** Can the open read be turned into an edited file? (why not, otherwise) */
function editBlock(): string | null {
  const i = K.info;
  if (!i?.def) return 'No definition for this software version.';
  if (K.fit.length) return 'The definition does not fit this read.';
  const bad = K.sums.filter((s) => !s.ok);
  if (bad.length) return `The read does not pass its own checksum (${bad.map((s) => s.name).join(', ')}): it may be damaged. Read the DME again.`;
  if (i.family === 'MS43' && i.kind !== 'full') return 'This is a 64 KB calibration read: an MS43 calibration can only be changed from a full 512 KB read, which also holds the calibration checksum description.';
  return null;
}

function setCell(name: string, r: number, c: number, v: number, rerender: () => void) {
  const cur = K.values[name];
  if (!cur || !Number.isFinite(v)) return;
  const base = K.draft[name] ?? cur.values.map((row) => row.slice());
  const item = cur.item;
  base[r][c] = quantize(item, v).value;
  const same = base.every((row, i) => row.every((x, j) => Math.abs(x - cur.values[i][j]) < 1e-9));
  if (same) delete K.draft[name];
  else K.draft[name] = base;
  K.msg = null;
  rerender();
}

function preset(kind: 'read' | number, rerender: () => void) {
  for (const n of ['id_tco_sp_ect__n__maf_sub', 'id_tco_sp_ect_acin__n__maf_sub']) {
    const cur = K.values[n];
    if (!cur) continue;
    if (kind === 'read') delete K.draft[n];
    else {
      const next = capMap(cur.values, kind).map((row) => row.map((v) => quantizeAtMost(cur.item, v)));
      if (next.some((row, i) => row.some((x, j) => Math.abs(x - cur.values[i][j]) > 1e-9))) K.draft[n] = next;
      else delete K.draft[n];
    }
  }
  K.msg = null;
  rerender();
}

/** Background for a temperature cell: blue when cool, amber when hot (80–110 °C). */
function heat(v: number): string {
  const t = Math.max(0, Math.min(1, (v - 80) / 30));
  const a = [66, 144, 246], b = [255, 160, 51];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgba(${c.join(',')},${0.16 + 0.22 * t})`;
}

function numInput(item: DmeItem, v: number, label: string, on: (n: number) => void, changed: boolean) {
  const lim = COOLING_LIMITS[item.name];
  return h('input', {
    type: 'number', step: Math.abs(item.scale) < 1 ? String(+Math.abs(item.scale).toPrecision(3)) : '1', min: lim?.[0], max: lim?.[1],
    value: fmt(v, item.decimals), 'aria-label': label, class: `dm-num ${changed ? 'chg' : ''}`,
    onchange: (e: Event) => on(Number((e.target as HTMLInputElement).value)),
  });
}

function renderTable(v: ItemValues, editable: boolean, rerender: () => void) {
  const item = v.item;
  const now = K.draft[item.name] ?? v.values;
  const yLabel = item.y?.units || '';
  const xLabel = item.x?.units || '';
  const oneCol = item.cols === 1;
  const head = oneCol ? null : h('tr', {}, h('th', { class: 'corner' }, h('small', {}, `${yLabel} ↓ · ${xLabel} →`)), (v.x ?? []).map((x) => h('th', {}, fmt(x, 0))));
  const rows = now.map((row, r) => h('tr', {},
    h('th', {}, v.y ? fmt(v.y[r], 1) : String(r + 1), oneCol && yLabel ? h('small', {}, ` ${yLabel}`) : null),
    row.map((x, c) => {
      const changed = Math.abs(x - v.values[r][c]) > 1e-9;
      const temp = item.units === '°C';
      return h('td', { class: changed ? 'chg' : '', style: temp ? `background:${heat(x)}` : '', title: changed ? `Read: ${fmt(v.values[r][c], 2)}` : '' },
        editable ? numInput(item, x, `${COOLING_LABELS[item.name] ?? item.name}, ${v.y?.[r] ?? r + 1} ${yLabel}${oneCol ? '' : `, ${v.x?.[c]} ${xLabel}`}`, (n) => setCell(item.name, r, c, n, rerender), changed) : fmt(x, item.decimals));
    })));
  return h('div', { class: 'dm-mapbox' }, h('table', { class: `dm-map ${oneCol ? 'one' : ''}` }, head ? h('thead', {}, head) : null, h('tbody', {}, rows)));
}

function renderItem(v: ItemValues, canEdit: boolean, rerender: () => void) {
  const item = v.item;
  const editable = canEdit && COOLING_EDITABLE.includes(item.name);
  const label = COOLING_LABELS[item.name] ?? item.name;
  const lim = COOLING_LIMITS[item.name];
  const meta = h('small', { class: 'dm-meta' }, h('span', { class: 'mono' }, item.name), ` · ${hex(item.raw.addr)}`, item.desc ? ` · ${item.desc}` : '', lim && editable ? ` · app limit ${lim[0]}–${lim[1]} ${item.units}` : '');
  if (item.kind === 'const') {
    const now = (K.draft[item.name] ?? v.values)[0][0];
    const changed = Math.abs(now - v.values[0][0]) > 1e-9;
    return h('div', { class: `dm-const ${changed ? 'chg' : ''}` },
      h('div', { class: 'dm-const-l' }, h('b', {}, label), meta),
      h('div', { class: 'dm-const-v' },
        editable ? numInput(item, now, label, (n) => setCell(item.name, 0, 0, n, rerender), changed) : h('span', { class: 'dm-val' }, fmt(now, item.decimals)),
        h('span', { class: 'dm-unit' }, item.units),
        changed ? h('small', {}, `read ${fmt(v.values[0][0], 2)}`) : null));
  }
  return h('div', { class: 'dm-item' },
    h('h3', {}, label, editable ? null : h('small', { class: 'dm-ro' }, 'read only')),
    meta,
    renderTable(v, editable, rerender),
    item.x?.unknown || item.y?.unknown ? h('p', { class: 'note' }, 'The definition does not say where this table’s axis is; rows are numbered.') : null);
}

function saveEdited(ctx: PageCtx | null, rerender: () => void) {
  const { bytes, info } = K;
  if (!bytes || !info?.def) return;
  try {
    const out = buildEditedImage(bytes, info, info.def, K.draft);
    const base = K.name.replace(/\.bin$/i, '');
    const a = h('a', { href: URL.createObjectURL(new Blob([out.image as BlobPart], { type: 'application/octet-stream' })), download: `${base}_cooling.bin` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const cells = out.changes.reduce((n, c) => n + c.cells.length, 0);
    K.msg = { kind: 'ok', text: `Saved ${base}_cooling.bin: ${cells} values in ${out.changes.length} ${out.changes.length === 1 ? 'item' : 'items'} changed, calibration checksums recomputed and checked (${out.checksums.map((s) => s.name).join(', ')}). Your original file is unchanged; keep it.` };
    ctx?.log('info', `Edited DME file saved: ${base}_cooling.bin (${cells} values)`);
  } catch (e) {
    K.msg = { kind: 'err', text: (e as Error).message };
  }
  rerender();
}

export function renderCooling(ctx: PageCtx | null, rerender: () => void, back?: () => void): (Node | null)[] {
  const head = h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Coding · engine (DME)'), h('h1', {}, 'Engine cooling')));
  const intro = h('p', { class: 'lede-sm' }, 'The M52TU and M54 engines have an electric thermostat: the DME chooses the coolant temperature from maps, about 102 °C at part load and 87 °C at high load from the factory. This screen opens a read of the DME (Siemens MS42 or MS43), finds its software version, applies the matching definition and shows those maps, the conditions around them and the fan stages.');
  const stage = h('div', { class: 'msg info' }, 'Works on a DME read file (.bin) for now. Reading the DME through the cable and writing it back come in later versions: nothing on this screen talks to the car.');
  const input = h('input', { type: 'file', accept: '.bin,application/octet-stream', class: 'dm-file', 'aria-label': 'DME read file',
    onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void openFile(ctx, rerender, f); } });
  const step1 = h('section', { class: 'cd-step' },
    h('h2', {}, h('span', { class: 'cd-n' }, '1'), 'Open a DME read'),
    h('p', {}, 'A full read (512 KB) or a calibration read (MS43 64 KB, MS42 32 KB), as saved by MS4x Flasher and similar tools. The file stays on this computer.'),
    h('div', { class: 'row' },
      back ? h('button', { class: 'btn', onclick: back }, '← Back') : null,
      h('label', { class: 'btn primary dm-pick' }, K.info ? 'Open another read' : 'Choose .bin file', input),
      K.name ? h('span', { class: 'note dm-fname' }, K.name) : null));
  const msg = K.msg ? h('div', { class: `msg ${K.msg.kind}` }, K.msg.text) : null;
  const top = [head, intro, stage, step1];
  const i = K.info;
  if (!i) return [...top, msg, h('p', { class: 'refnote' }, `Definitions: MS4X Dev Team (ms4x.net, GPL-3.0). Supported: ${SUPPORTED()}.`)];

  const sums = h('ul', { class: 'dm-sums' }, K.sums.map((s) => h('li', { class: s.ok ? 'ok' : 'bad' },
    h('span', { class: `led ${s.ok ? 'ok' : 'fault'}` }), `${s.name}: `, h('span', { class: 'mono' }, s.ok ? 'OK' : `stored ${s.stored.toString(16).toUpperCase()}, content gives ${s.computed.toString(16).toUpperCase()}`))));
  const card = h('section', { class: 'cd-step' },
    h('h2', {}, h('span', { class: 'cd-n' }, '2'), `${i.family} ${i.version}`),
    h('dl', { class: 'dm-facts' },
      h('div', {}, h('dt', {}, 'Read'), h('dd', {}, i.kind === 'full' ? 'Full, 512 KB' : `Calibration only, ${i.calSize / 1024} KB`)),
      h('div', {}, h('dt', {}, 'Software'), h('dd', {}, i.version, i.programVersion && i.programVersion !== i.version ? ` (program ${i.programVersion}!)` : '')),
      h('div', {}, h('dt', {}, 'Definition'), h('dd', {}, i.def ? `ms4x-net ${i.def.family} ${i.def.version}, v${i.def.xdfVersion}` : 'none')),
      h('div', {}, h('dt', {}, 'Header'), h('dd', { class: 'mono' }, i.header.slice(0, 32)))),
    sums,
    !i.def ? h('div', { class: 'msg err' }, `There is no definition for ${i.family} ${i.version}. Supported: ${SUPPORTED()}. Older MS43 software can be updated to 430069 with WinKFP.`) : null,
    K.fit.length ? h('div', { class: 'msg err' }, 'The definition does not fit this read, so nothing is shown: ', h('ul', {}, K.fit.slice(0, 4).map((p) => h('li', {}, p)))) : null);
  if (!i.def || K.fit.length) return [...top, msg, card];

  const block = editBlock();
  const canEdit = !block;
  const groups = coolingItems(i.def).map((g, gi) => h('section', { class: 'cd-step dm-group' },
    h('h2', {}, g.title),
    h('p', {}, g.note),
    gi === 0 && canEdit ? h('div', { class: 'cd-presets dm-presets', role: 'group', 'aria-label': 'Map presets' },
      ([['read', 'As read', 'The values in this read.'], [100, 'Cap at 100 °C', 'Part load a little cooler; cells already below stay.'], [95, 'Cap at 95 °C', 'A common choice for hot climates. Uses a little more fuel.']] as const)
        .map(([k, t, n]) => {
          const mapItem = K.values.id_tco_sp_ect__n__maf_sub?.item;
          const real = typeof k === 'number' && mapItem ? quantizeAtMost(mapItem, k) : null;
          const step = real !== null && real !== k ? ` Stored as ${fmt(real, 2)} °C (the DME uses ${fmt(Math.abs(mapItem!.scale), 2)} °C steps).` : '';
          return h('button', { class: 'cd-preset', onclick: () => preset(k, rerender) }, h('b', {}, t), h('small', {}, n + step));
        })) : null,
    g.items.map((it) => K.values[it.name] ? renderItem(K.values[it.name], canEdit, rerender) : null)));

  const check = checkDraft(i.def, K.values, K.draft);
  const nChanged = Object.entries(K.draft).reduce((n, [name, vals]) => n + vals.flat().filter((v, k) => Math.abs(v - K.values[name].values.flat()[k]) > 1e-9).length, 0);
  const review = h('section', { class: 'cd-step' },
    h('h2', {}, h('span', { class: 'cd-n' }, '3'), 'Save a modified file'),
    block ? h('div', { class: 'msg warn' }, block)
      : h('p', {}, nChanged ? `${nChanged} ${nChanged === 1 ? 'value' : 'values'} changed. The file gets the new values and recomputed calibration checksums; everything else stays byte for byte as read.` : 'Change values above (or pick a preset) to make a modified file.'),
    check.errors.length ? h('div', { class: 'msg err' }, h('ul', {}, check.errors.map((e) => h('li', {}, e)))) : null,
    check.warnings.length ? h('div', { class: 'msg warn' }, h('ul', {}, check.warnings.map((e) => h('li', {}, e)))) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', disabled: !!block || !nChanged || check.errors.length > 0, onclick: () => saveEdited(ctx, rerender) }, 'Save modified .bin'),
      nChanged ? h('button', { class: 'btn', onclick: () => { K.draft = {}; K.msg = null; rerender(); } }, 'Undo all changes') : null),
    h('p', { class: 'note' }, 'Writing a file to the DME is not part of the app yet. Keep the original read: it is the way back to the factory values.'));

  return [...top, msg, card, ...groups, review, h('p', { class: 'refnote' }, 'Definitions: MS4X Dev Team (ms4x.net, GPL-3.0). Checksum layout: rudywolf (github.com/therudywolf/MS4X). Limits on the editable values are the app’s own, tighter than the DME allows.')];
}
