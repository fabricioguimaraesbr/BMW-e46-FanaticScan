// Coding screen. One function only: the coolant temperature gauge curve of the instrument cluster (the "buffer" that
// keeps the needle at 12 o'clock from 75 to 115 °C). Read → backup file → choose a curve → compare → write → verify.
// Everything else that writes to a module stays blocked (safety.ts); see clusterEeprom.ts for the rules of this one.

import { Backup, ClusterEeprom, CodingError, backupFileName, clusterKind, hasDs2Link } from '../core/coding/clusterEeprom';
import {
  CurvePoint, GaugeCurve, POINT_NAMES, applyCurve, bufferRange, checkCurve, encodeCurve, findCurve, hexLine, needleAngle, presetsFor, sameCurve, withCarAngles,
} from '../core/coding/gaugeCurve';
import type { PageCtx } from './ctx';
import { h } from './dom';

const C = {
  eeprom: null as ClusterEeprom | null,
  /** session the EEPROM object belongs to (a new connection starts over) */
  owner: null as unknown,
  progress: null as { done: number; total: number } | null,
  busy: '',
  backupSaved: false,
  curve: null as GaugeCurve | null,
  draft: [] as CurvePoint[],
  preset: '',
  msg: null as { kind: 'ok' | 'err' | 'warn' | 'info'; text: string; restart?: boolean } | null,
  probe: 95,
  coolant: null as number | null,
  timer: 0 as unknown as ReturnType<typeof setInterval>,
};

export function resetCoding() {
  clearInterval(C.timer);
  Object.assign(C, { eeprom: null, owner: null, progress: null, busy: '', backupSaved: false, curve: null, draft: [], preset: '', msg: null, coolant: null });
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function cluster(ctx: PageCtx) {
  const m = ctx.found().find((x) => x.def.address === 0x80);
  return m?.scan ? { m, kind: clusterKind(m.scan.variant, m.scan.ident) } : null;
}

function saveBackup(b: Backup) {
  const a = h('a', { href: URL.createObjectURL(new Blob([b.original as BlobPart], { type: 'application/octet-stream' })), download: backupFileName(b) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  C.backupSaved = true;
}

async function readEeprom(ctx: PageCtx) {
  const s = ctx.session();
  const c = cluster(ctx);
  if (!hasDs2Link(s) || !c?.kind) return;
  ctx.stopLive();
  C.eeprom = new ClusterEeprom(s, c.kind);
  C.owner = s;
  C.busy = 'read';
  C.msg = null;
  C.backupSaved = false;
  ctx.setBusy('coding');
  ctx.rerender();
  try {
    const b = await C.eeprom.readAll((done, total) => {
      C.progress = { done, total };
      const el = document.querySelector('#cd-progress');
      if (el) el.textContent = `Reading the cluster EEPROM… ${Math.round((done / total) * 100)}%`;
    }, c.m.scan!.ident);
    ctx.log('info', `Cluster EEPROM read: ${b.image.length} bytes (${c.kind.toUpperCase()})`);
    C.curve = findCurve(b.image);
    C.draft = C.curve ? C.curve.points.map((p) => ({ ...p })) : [];
    C.preset = '';
    saveBackup(b);
    C.msg = C.curve
      ? { kind: 'ok', text: `Read ${b.image.length} bytes. The backup file is in your downloads: keep it, it is the way back to your cluster's original data.` }
      : { kind: 'warn', text: 'Read the EEPROM and saved the backup, but the coolant gauge curve was not found in it. Nothing can be changed on this cluster. Send the backup file to the developer to add your cluster.' };
  } catch (e) {
    C.eeprom = null;
    C.msg = { kind: 'err', text: `Could not read the cluster: ${(e as Error).message}. Ignition in position 2, cable in K-line mode with pins 7 and 8 joined.` };
  }
  C.progress = null;
  C.busy = '';
  ctx.setBusy('');
  ctx.rerender();
}

/** Write confirmation: every condition has to be ticked. */
function confirmWrite(title: string, lines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const conds = [
      'Engine off, ignition in position 2 (key on).',
      'Battery healthy or on a charger: a voltage drop during the write can leave the cluster half written.',
      'I saved the backup file and know where it is.',
      'I understand this changes the cluster permanently until I restore the backup.',
    ];
    const boxes = conds.map(() => h('input', { type: 'checkbox' }));
    const go = h('button', { class: 'btn danger', disabled: true }, 'Write to cluster');
    const sync = () => { go.disabled = !boxes.every((b) => b.checked); };
    boxes.forEach((b) => b.addEventListener('change', sync));
    const done = (v: boolean) => { d.close(); resolve(v); };
    go.addEventListener('click', () => done(true));
    const d = h('dialog', { class: 'cd-dlg' },
      h('h2', {}, title),
      h('ul', { class: 'cd-dlg-list' }, lines.map((l) => h('li', {}, l))),
      h('div', { class: 'cd-conds' }, conds.map((t, i) => h('label', { class: 'opt' }, boxes[i], h('span', {}, t)))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), go),
    );
    d.addEventListener('cancel', () => resolve(false));
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => d.remove());
  });
}

async function doWrite(ctx: PageCtx, kind: 'curve' | 'original' | 'file', file?: Uint8Array) {
  const e = C.eeprom;
  const b = e?.lastBackup;
  if (!e || !b || !C.curve) return;
  const target = kind === 'curve' ? C.draft : findCurve(kind === 'file' ? file! : b.original)?.points;
  if (!target) {
    C.msg = { kind: 'err', text: 'The gauge curve was not found in that file.' };
    ctx.rerender();
    return;
  }
  const now = encodeCurve(C.curve.format, C.curve.points);
  const next = encodeCurve(C.curve.format, target);
  const ok = await confirmWrite(kind === 'curve' ? 'Write the new gauge curve?' : 'Put the curve from the backup back?', [
    `Cluster ${e.kind.toUpperCase()}, bytes ${hex(C.curve.offset >> 8)}${hex(C.curve.offset & 0xff)}–${(C.curve.offset + C.curve.length - 1).toString(16).toUpperCase().padStart(4, '0')} only.`,
    `Now: ${now.map(hex).join(' ')}`,
    `New: ${next.map(hex).join(' ')}`,
    'Each word is written, read back and compared. Nothing else in the cluster is touched.',
  ]);
  if (!ok) return;
  ctx.stopLive();
  C.busy = 'write';
  C.msg = null;
  ctx.setBusy('coding');
  ctx.rerender();
  try {
    const step = (t: string) => { const el = document.querySelector('#cd-progress'); if (el) el.textContent = `${t}…`; };
    const r = kind === 'curve' ? await e.writeCurve(C.draft, step) : await e.restoreCurve(kind === 'file' ? file! : b.original, step);
    C.curve = findCurve(b.image);
    C.draft = C.curve ? C.curve.points.map((p) => ({ ...p })) : [];
    ctx.log('info', `Cluster gauge curve written (${r.words.length} words) and verified: ${hexLine(r.verified, 0)}`);
    C.msg = r.words.length
      ? { kind: 'ok', text: `Written and verified (${r.words.length} ${r.words.length === 1 ? 'word' : 'words'}). The cluster uses the new curve after it restarts: press “Restart cluster” or switch the ignition off, wait 30 seconds, and on again.`, restart: true }
      : { kind: 'info', text: 'The cluster already had this curve: nothing was written.' };
  } catch (err) {
    C.msg = { kind: 'err', text: err instanceof CodingError ? err.message : `Write failed: ${(err as Error).message}. Read the EEPROM again before trying anything else.` };
    ctx.log('fault', `Gauge curve write: ${C.msg.text}`);
  }
  C.busy = '';
  ctx.setBusy('');
  ctx.rerender();
}

async function restart(ctx: PageCtx) {
  if (!C.eeprom) return;
  C.busy = 'restart';
  ctx.rerender();
  const ok = await C.eeprom.restart().catch(() => false);
  C.busy = '';
  C.msg = ok ? { kind: 'ok', text: 'The cluster restarted (it may flash and beep: that is normal). Watch the needle as the engine warms up.' } : { kind: 'warn', text: 'The cluster did not confirm the restart. Switch the ignition off, wait 30 seconds and switch it on again.' };
  ctx.rerender();
}

function restoreFromFile(ctx: PageCtx) {
  const input = h('input', { type: 'file', accept: '.bin,application/octet-stream' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      C.eeprom?.adoptBackupFile(bytes);
    } catch (e) {
      C.msg = { kind: 'err', text: (e as Error).message };
      ctx.rerender();
      return;
    }
    await doWrite(ctx, 'file', bytes);
  });
  input.click();
}

// ---------------------------------------------------------------- drawings

/** Physical needle rotation for a curve angle: 90 (12 o'clock) is straight up, the scale spans about ±55°. */
const rot = (a: number) => (a - 90) * 0.62;

function gaugeSvg(needles: { angle: number; cls: string }[], label: string): SVGSVGElement {
  const c = 110;
  const pt = (a: number, r: number) => { const t = ((rot(a) - 90) * Math.PI) / 180; return [c + r * Math.cos(t), 120 + r * Math.sin(t)]; };
  const arc = (a1: number, a2: number, r: number) => { const [x1, y1] = pt(a1, r); const [x2, y2] = pt(a2, r); return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const ticks = [0, 31, 55, 90, 124, 148, 164].map((a) => { const [x1, y1] = pt(a, 92); const [x2, y2] = pt(a, a === 90 ? 76 : 82); return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`; }).join(' ');
  const svg = `<svg viewBox="0 0 220 140" class="cd-gauge" role="img" aria-label="${label}">
    <path d="${arc(0, 168, 96)}" class="track"/>
    <path d="${arc(0, 31, 96)}" class="blue"/>
    <path d="${arc(148, 168, 96)}" class="red"/>
    <path d="${ticks}" class="ticks"/>
    ${needles.map((n) => { const [x, y] = pt(n.angle, 84); return `<line x1="${c}" y1="120" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="needle ${n.cls}"/>`; }).join('')}
    <circle cx="${c}" cy="120" r="7" class="hub"/>
    <text x="${pt(0, 112)[0].toFixed(0)}" y="${(pt(0, 112)[1] + 4).toFixed(0)}" class="end">C</text>
    <text x="${pt(168, 112)[0].toFixed(0)}" y="${(pt(168, 112)[1] + 4).toFixed(0)}" class="end">H</text>
  </svg>`;
  const t = h('template', {});
  t.innerHTML = svg;
  return t.content.firstElementChild as SVGSVGElement;
}

/** Temperature (x) → needle angle (y) of the current and the new curve. */
function curveChart(now: CurvePoint[], next: CurvePoint[], probe: number, live: number | null): SVGSVGElement {
  const W = 900, H = 250, L = 44, B = 30, T = 12, R = 12;
  const x = (t: number) => L + (t / 150) * (W - L - R);
  const y = (a: number) => H - B - (a / 170) * (H - B - T);
  const line = (pts: CurvePoint[]) => {
    const ps = [{ temp: 0, angle: pts[0].angle }, ...pts, { temp: 150, angle: pts[pts.length - 1].angle }];
    return ps.map((p, i) => `${i ? 'L' : 'M'} ${x(p.temp).toFixed(1)} ${y(p.angle).toFixed(1)}`).join(' ');
  };
  let grid = '';
  for (let t = 0; t <= 150; t += 25) grid += `<line x1="${x(t)}" y1="${T}" x2="${x(t)}" y2="${H - B}" class="g"/><text x="${x(t)}" y="${H - B + 16}" class="ax">${t}</text>`;
  for (const a of [0, 45, 90, 135, 168]) grid += `<line x1="${L}" y1="${y(a)}" x2="${W - R}" y2="${y(a)}" class="g ${a === 90 ? 'mid' : ''}"/><text x="${L - 6}" y="${y(a) + 4}" class="ax y">${a === 90 ? '12h' : a === 0 ? 'C' : a === 168 ? 'H' : ''}</text>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="cd-chart" role="img" aria-label="Needle position against coolant temperature">
    ${grid}
    <text x="${W - R}" y="${H - 2}" class="ax" text-anchor="end">°C</text>
    <path d="${line(now)}" class="now"/>
    <path d="${line(next)}" class="next"/>
    ${next.map((p) => `<circle cx="${x(p.temp)}" cy="${y(p.angle)}" r="3.5" class="pt"/>`).join('')}
    <line x1="${x(probe)}" y1="${T}" x2="${x(probe)}" y2="${H - B}" class="probe"/>
    ${live !== null ? `<line x1="${x(live)}" y1="${T}" x2="${x(live)}" y2="${H - B}" class="live"/>` : ''}
  </svg>`;
  const t = h('template', {});
  t.innerHTML = svg;
  return t.content.firstElementChild as SVGSVGElement;
}

/** Hex lines with the changed bytes marked. */
function diffView(curve: GaugeCurve, now: Uint8Array, next: Uint8Array): HTMLElement {
  const start = curve.offset & ~0xf;
  const end = (curve.offset + curve.length + 15) & ~0xf;
  const rows: HTMLElement[] = [];
  for (const [label, img] of [['Now', now], ['New', next]] as const) {
    for (let o = start; o < end; o += 16) {
      rows.push(h('div', { class: 'cd-hex-row' },
        h('span', { class: 'cd-hex-lbl' }, o === start ? label : ''),
        h('span', { class: 'cd-hex-off' }, o.toString(16).toUpperCase().padStart(3, '0')),
        ...Array.from(img.subarray(o, o + 16), (v, k) => {
          const i = o + k;
          const inCurve = i >= curve.offset && i < curve.offset + curve.length;
          return h('span', { class: `cd-hex-b ${inCurve ? 'in' : ''} ${inCurve && now[i] !== next[i] ? 'chg' : ''}` }, hex(v));
        })));
    }
  }
  return h('div', { class: 'cd-hex', role: 'figure', 'aria-label': 'EEPROM bytes now and after the write' }, rows);
}

// ---------------------------------------------------------------- screen

function gauges(curve: GaugeCurve) {
  return h('div', { class: 'cd-gauges' },
    h('figure', {}, gaugeSvg([{ angle: needleAngle(curve.points, C.probe), cls: 'now' }], `Now at ${C.probe} °C`), h('figcaption', {}, `Now · ${Math.round(needleAngle(curve.points, C.probe))}°`)),
    h('figure', {}, gaugeSvg([{ angle: needleAngle(C.draft, C.probe), cls: 'next' }], `New curve at ${C.probe} °C`), h('figcaption', {}, `New · ${Math.round(needleAngle(C.draft, C.probe))}°`)));
}

function liveNote(curve: GaugeCurve) {
  return h('p', { class: 'note', id: 'cd-live' }, C.coolant === null ? '' : [
    h('button', { class: 'link', onclick: () => { C.probe = Math.max(0, Math.min(140, C.coolant!)); updateProbe(curve); } }, `Engine now: ${C.coolant} °C`),
    ' (what the cluster receives from the DME; the dashed line on the chart)']);
}

/** The temperature slider moves the needles and the chart marker without rebuilding the screen (keeps the drag). */
function updateProbe(curve: GaugeCurve) {
  document.querySelector('.cd-gauges')?.replaceWith(gauges(curve));
  const v = document.querySelector('#cd-probe-val');
  if (v) v.textContent = `${C.probe} °C`;
  document.querySelector('.cd-chart')?.replaceWith(curveChart(curve.points, C.draft, C.probe, C.coolant));
}

function pollCoolant(ctx: PageCtx) {
  clearInterval(C.timer);
  if (!C.eeprom || C.eeprom.kind !== 'kombi46') return;
  C.timer = setInterval(async () => {
    if (!document.querySelector('.cd') || C.busy || ctx.busy() || !C.eeprom) {
      if (!document.querySelector('.cd')) clearInterval(C.timer);
      return;
    }
    const t = await C.eeprom.coolant().catch(() => null);
    if (t !== C.coolant && document.querySelector('.cd') && C.curve) {
      C.coolant = t;
      document.querySelector('#cd-live')?.replaceWith(liveNote(C.curve));
      document.querySelector('.cd-chart')?.replaceWith(curveChart(C.curve.points, C.draft, C.probe, C.coolant));
    }
  }, 2500);
}

export function renderCoding(ctx: PageCtx): (Node | null)[] {
  const head = h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Coding · instrument cluster'), h('h1', {}, 'Coolant gauge')));
  const intro = h('p', { class: 'lede-sm' }, 'The E46 temperature needle sits at 12 o’clock anywhere from 75 to 115 °C, so a thermostat stuck open or an engine starting to overheat look normal. This rewrites the gauge curve in the cluster, as in the E46Fanatics guide “DIY: Temperature Gauge Buffer Mod”, so the needle follows the real temperature more closely.');
  const s = ctx.session();
  if (ctx.mode() === 'remote' || !hasDs2Link(s)) return [head, intro, h('div', { class: 'empty' }, h('strong', {}, 'Only on the computer at the car'), 'Coding is never done over a remote session. The person with the cable connected can do it on their own computer.')];
  if (C.owner && C.owner !== s) resetCoding();
  const c = cluster(ctx);
  if (!c) return [head, intro, h('div', { class: 'empty' }, h('strong', {}, ctx.scanning() ? 'Looking for the cluster…' : 'The instrument cluster did not answer'), 'The cluster (IKE, address 0x80) must answer the scan. Ignition in position 2, cable in K-line mode with OBD pins 7 and 8 joined.')];
  if (!c.kind) return [head, intro, h('div', { class: 'empty' }, h('strong', {}, 'Cluster not supported'), `This cluster (${c.m.scan!.variant ?? 'unknown'}, diag index ${c.m.scan!.ident.ID_DIAG_INDEX ?? '?'}) is not an E46 KOMBI46 / KOMBI46R. Nothing is offered for it.`)];
  const b = C.eeprom?.lastBackup ?? null;
  const busy = !!C.busy || ctx.busy();
  const msg = C.msg ? h('div', { class: `msg ${C.msg.kind}` }, C.msg.text, C.msg.restart ? h('div', { class: 'row' }, h('button', { class: 'btn', disabled: busy, onclick: () => restart(ctx) }, C.busy === 'restart' ? 'Restarting…' : 'Restart cluster')) : null) : null;
  const status = busy && C.busy ? h('div', { class: 'msg info', id: 'cd-progress' }, C.busy === 'read' ? 'Reading the cluster EEPROM…' : C.busy === 'write' ? 'Writing…' : 'Working…') : null;
  const step1 = h('section', { class: 'cd-step cd' },
    h('h2', {}, h('span', { class: 'cd-n' }, '1'), 'Read the cluster and keep the backup'),
    h('p', {}, `${c.kind.toUpperCase()} (${c.kind === 'kombi46' ? 'up to about 2002' : 'about 2003 on'}), ${c.kind === 'kombi46' ? 512 : 2048} bytes of EEPROM. Reading changes nothing and takes ${c.kind === 'kombi46' ? 'a few' : 'about 15'} seconds; the whole EEPROM goes to a backup file in your downloads.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', disabled: busy, onclick: () => readEeprom(ctx) }, b ? 'Read again' : 'Read cluster EEPROM'),
      b ? h('button', { class: 'btn', disabled: busy, onclick: () => { saveBackup(b); ctx.rerender(); } }, 'Save backup file again') : null,
      b ? h('span', { class: 'note' }, `Read at ${new Date(b.readAt).toLocaleTimeString('en-GB')} · ${backupFileName(b)}`) : null),
  );
  if (!b || !C.curve) return [head, intro, status, msg, step1, h('p', { class: 'refnote' }, 'Based on community findings (TerraPhantm, SilberVogel and others on E46Fanatics). Works on the cluster’s own memory service, the same one PA Soft uses. Only the bytes of the gauge curve can be changed here.')];

  const curve = C.curve;
  const format = curve.format;
  const check = checkCurve(C.draft, format);
  const changed = !sameCurve(C.draft, curve.points, format);
  const next = check.errors.length ? b.image : applyCurve(b.image, curve, C.draft);
  const buf = bufferRange(C.draft);
  const bufNow = bufferRange(curve.points);
  const setDraft = (pts: CurvePoint[], preset = '') => { C.draft = pts; C.preset = preset; ctx.rerender(); };
  const presets = presetsFor(format);
  const num = (v: number, min: number, max: number, on: (n: number) => void, label: string) =>
    h('input', { type: 'number', min, max, step: 1, value: String(v), 'aria-label': label, class: 'cd-num', onchange: (e: Event) => on(Math.round(Number((e.target as HTMLInputElement).value))) });

  const step2 = h('section', { class: 'cd-step' },
    h('h2', {}, h('span', { class: 'cd-n' }, '2'), 'Choose the new curve'),
    h('p', {}, `Found at byte ${curve.offset.toString(16).toUpperCase().padStart(3, '0')} (${format === 'pairs' ? 'early layout: temperature and needle angle pairs' : '2003+ layout: temperatures only, the angles are fixed'}). Your cluster now: ${bufNow ? `buffer ${bufNow[0]}–${bufNow[1]} °C` : 'no buffer'}, red from ${curve.points[4].temp} °C.`),
    h('div', { class: 'cd-presets', role: 'group', 'aria-label': 'Curves' },
      presets.map((p) => h('button', { class: `cd-preset ${sameCurve(C.draft, withCarAngles(p.points, curve), format) ? 'on' : ''}`, onclick: () => setDraft(withCarAngles(p.points, curve), p.id) }, h('b', {}, p.name), h('small', {}, p.note))),
      h('button', { class: `cd-preset ${!changed ? 'on' : ''}`, onclick: () => setDraft(curve.points.map((p) => ({ ...p }))) }, h('b', {}, 'As in my cluster now'), h('small', {}, 'What the cluster holds today. Edit the points below for your own curve.'))),
    h('div', { class: 'cd-edit' },
      h('table', { class: 'cd-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Point'), h('th', {}, 'Temperature'), h('th', {}, 'Needle'), h('th', {}, 'Now'))),
        h('tbody', {}, C.draft.map((p, i) => h('tr', { class: curve.points[i].temp !== p.temp || curve.points[i].angle !== p.angle ? 'chg' : '' },
          h('td', {}, POINT_NAMES[i]),
          h('td', {}, num(p.temp, 1, 150, (n) => setDraft(C.draft.map((q, k) => (k === i ? { ...q, temp: n } : q))), `${POINT_NAMES[i]} temperature`), ' °C ', h('small', { class: 'mono' }, `0x${hex(p.temp & 0xff)}`)),
          h('td', {}, format === 'pairs' && i > 0
            ? [num(p.angle, 0, 180, (n) => setDraft(C.draft.map((q, k) => (k === i ? { ...q, angle: n } : q))), `${POINT_NAMES[i]} needle angle`), '°']
            : h('span', { class: 'muted' }, `${p.angle}°${p.angle === 90 ? ' (12h)' : ''}`)),
          h('td', { class: 'muted' }, `${curve.points[i].temp} °C · ${curve.points[i].angle}°`),
        ))),
      ),
      h('div', { class: 'cd-side' },
        gauges(curve),
        h('label', { class: 'cd-probe' }, h('span', {}, `Coolant at `, h('b', { id: 'cd-probe-val' }, `${C.probe} °C`)),
          h('input', { type: 'range', min: 0, max: 140, value: String(C.probe), 'aria-label': 'Try a coolant temperature', oninput: (e: Event) => { C.probe = Number((e.target as HTMLInputElement).value); updateProbe(curve); } })),
        liveNote(curve),
      ),
    ),
    h('div', { class: 'cd-chartbox' }, curveChart(curve.points, C.draft, C.probe, C.coolant), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'lg-now' }), 'Now'), h('span', {}, h('i', { class: 'lg-next' }), 'New'), C.coolant !== null ? h('span', {}, h('i', { class: 'lg-live' }), 'Engine now') : null)),
    h('p', { class: 'note' }, `New curve: ${buf ? `12 o’clock from ${buf[0]} to ${buf[1]} °C` : '12 o’clock only at one temperature (no buffer)'}, red from ${C.draft[4]?.temp ?? '—'} °C, end of scale at ${C.draft[5]?.temp ?? '—'} °C. A healthy M54 runs about 88–105 °C depending on load (the map thermostat opens more under load).`),
    check.errors.length ? h('div', { class: 'msg err' }, check.errors.join(' ')) : null,
    check.warnings.length ? h('div', { class: 'msg warn' }, h('ul', {}, check.warnings.map((w) => h('li', {}, w)))) : null,
  );

  const step3 = h('section', { class: 'cd-step' },
    h('h2', {}, h('span', { class: 'cd-n' }, '3'), 'Compare and write'),
    diffView(curve, b.image, next),
    h('p', { class: 'note' }, 'Only the marked bytes change. The cluster must still hold exactly what was read; it is checked again right before writing, and every word is read back after.'),
    !C.backupSaved ? h('div', { class: 'msg warn' }, 'Save the backup file first.') : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn danger', disabled: busy || !changed || !!check.errors.length || !C.backupSaved, onclick: () => doWrite(ctx, 'curve') }, C.busy === 'write' ? 'Writing…' : 'Write to cluster'),
      h('button', { class: 'btn', disabled: busy || sameCurve(findCurve(b.original)?.points ?? [], curve.points, format), onclick: () => doWrite(ctx, 'original'), title: 'Writes back the curve this cluster had when it was first read in this session' }, 'Put back the original curve'),
      h('button', { class: 'btn', disabled: busy, onclick: () => restoreFromFile(ctx), title: 'Takes only the gauge curve from a backup file saved earlier' }, 'Restore curve from a backup file…')),
  );
  pollCoolant(ctx);
  return [head, intro, status, msg, step1, step2, step3,
    h('p', { class: 'refnote' }, 'Based on community findings (TerraPhantm, SilberVogel, blarf and others in the E46Fanatics thread). Tested in the simulator; the curve values are the ones members report using. You use it at your own risk: keep the backup file.')];
}
