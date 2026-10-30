// Library: how the app works, how to use each screen, supported cars and modules, the fault guides, and the
// diagnostic socket and bus diagrams of the E46. Works without a car (start screen) and while connected.

import { FAULT_GUIDES, FaultGuide } from '../core/api/faultguide';
import { E46_MODULES, E46_OPTIONAL_MODULES, ModuleDef } from '../core/api/modules';
import type { PageCtx } from './ctx';
import { h } from './dom';
import { renderGuide } from './troubleshoot';

type Tab = 'start' | 'screens' | 'cars' | 'faults' | 'wiring';
const TABS: [Tab, string][] = [['start', 'How it works'], ['screens', 'Using each screen'], ['cars', 'Cars & modules'], ['faults', 'Fault guide'], ['wiring', 'Diagnostic socket & buses']];
const V = { tab: 'start' as Tab, guide: '', filter: '' };

/** Opens the Library on a tab (from other screens). */
export function libraryTab(t: Tab, guide = '') {
  V.tab = t;
  V.guide = guide;
}

const p = (...t: (string | Node)[]) => h('p', {}, ...t);
const sec = (title: string, ...kids: (Node | null)[]) => h('section', { class: 'doc-sec' }, h('h2', {}, title), ...kids);
const ul = (items: (string | Node)[]) => h('ul', {}, items.map((i) => h('li', {}, i)));
const b = (t: string) => h('b', {}, t);

function howItWorks() {
  return [
    sec('What the app is',
      p('E46Fanatics Scan reads and clears fault memories, shows live data and runs module tests on the BMW E46, from Chrome or Edge on a Mac or a Windows PC, with a K+DCAN cable or the BMW Scanner 1.4 cable. Everything runs inside the browser on your computer; nothing is sent anywhere.'),
      p('It does what INPA does: each module of the car is described by a BMW module file (.prg/.grp). The app contains its own engine that runs those files, the same way the EDIABAS layer under INPA does, and talks to the car over the K-line.')),
    sec('Two ways of working',
      ul([
        h('span', {}, b('Plug & play (cable only). '), 'Every module is identified (part number, hardware, software). The engine is read over standard OBD-II: P-codes with descriptions, clearing, and standard live values. Other modules can only be identified.'),
        h('span', {}, b('With the module files. '), 'Put the .prg/.grp files in the “modulos” folder of the package (or inside the Mac app). Then every module that has its file gets full fault memory with conditions, all its live values and its functions and tests. Modules without a file stay in plug & play.'),
      ])),
    sec('Protocols on the E46',
      ul([
        h('span', {}, b('DS2 '), '(9600 baud): almost every E46 module, including the MS42/MS43 engine computers, the GS8 transmissions, ABS/ASC/DSC, EWS, cluster, lights, body, climate and airbag.'),
        h('span', {}, b('KWP2000* '), '(9600 baud, same K-line): the MS45 engine computer (M54 from 2003) and the ME9 (318i N42/N46).'),
        h('span', {}, b('BMW-FAST '), '(115200 baud): the MRS5 airbag.'),
        h('span', {}, b('OBD-II / ISO 9141-2: '), 'the standard engine diagnosis used in plug & play mode.'),
      ])),
    sec('Safety',
      p('The app is read-only by default. Reading and clearing faults are always allowed. Actuator tests and adaptation resets are locked until you press “Unlock tests & resets” (for that session only). Anything that writes permanently to a module (coding, programming, EEPROM, immobiliser matching, service interval reset, sensor calibrations) is always blocked; the app checks both the function name and its description in the module file before a single byte goes to the car. Unknown functions are treated as writes.'),
      p('One exception, on its own screen: the coolant gauge curve of the instrument cluster (Coding). It writes only the bytes of that curve, only after a full backup of the cluster EEPROM, checks the cluster still matches the backup right before writing, and reads every byte back. The original curve can be put back at any time.'),
      p('Remote sessions are read-only unless the car owner chooses otherwise; clearing faults and every test are approved by the owner on the computer at the car, and nothing that writes is ever available remotely.')),
    sec('Getting started',
      ul(['Connect the cable to the OBD socket under the dashboard (driver side) and to the computer, ignition on (key position 2).', 'Press “Connect cable” and pick the cable in Chrome’s list. On a K+DCAN cable with a switch, use the position that joins OBD pins 7 and 8 (see “Diagnostic socket & buses”).', 'The app scans the car, reads every fault memory and checks which values your car supports. Then open the screen you need from the menu.'])),
  ];
}

function screens() {
  const item = (name: string, text: string) => h('div', { class: 'doc-item' }, h('h3', {}, name), p(text));
  return [
    sec('Screens',
      p('The menu is in four groups: Car (Overview, Vehicle, Faults), Data (Live Data, Data Logger), Workshop (Guided checks, Service, Tests & Functions, Coding) and More (Garage, Library, Log).'),
      item('Overview', 'Every module that answered, with its identification and faults. From here: read all faults, save a text report, save the scan to the Garage. “Scan options” adds the optional modules (navigation, telephone, seats, rain sensor…) and re-checks the supported data.'),
      item('Vehicle', 'The factory order stored in the instrument cluster: build date, type key, paint, upholstery and the option codes, with descriptions for the common E46 options. Below, the VIN stored in each module (cluster, immobiliser, light module, engine, gearbox) and the mileage: the app flags a module from another car, or an engine/gearbox programmed at more kilometres than the odometer shows.'),
      item('Faults', 'Fault memory of one module (tabs on top). Each fault opens to show its details and the conditions when it was stored. “Troubleshoot” explains what the fault means, the likely causes on an E46, how to check them with the values the app reads and how to fix it. “Clear faults” erases the memory; faults still present come back.'),
      item('Live Data', 'All values of the module, read automatically: an instrument panel on top (rev counter, speed, temperatures) and cards grouped by system. The blue band is the normal range where one is known; cards turn red outside it. Chart and CSV recording are in the toolbar.'),
      item('Tests & Functions', 'Every function of the module file, searchable. Readings run at once; actuator tests and resets need “Unlock tests & resets”; permanent writes are hidden.'),
      item('Guided checks', 'Step-by-step checks that follow the live values and explain them: thermostat and warm-up (coolant and radiator outlet from a cold start), automatic gearbox fluid level (tells you when the fluid is between 30 and 50 °C), VANOS target against actual for both camshafts, both pre-cat oxygen sensors and the mixture correction, and rough running and misfire counters per cylinder. They only read; the optional DME misfire check needs “Unlock tests & resets”. Written for the MS43 engine computer and the GS8.60.4 gearbox.'),
      item('Service', 'Guided procedures matched to your car: engine and gearbox adaptation resets, ABS bleeding, ABS pump test, injector cut-out, cluster and light self-tests. Each lists the conditions to confirm before it runs and what to do afterwards.'),
      item('Coding', 'One function: the coolant temperature gauge. The E46 needle sits at 12 o’clock anywhere from 75 to 115 °C; this rewrites the curve in the cluster (as in the E46Fanatics “Temperature Gauge Buffer Mod” guide) so the needle follows the real temperature. Read the cluster (a backup file is saved), pick a curve or set your own points, compare the bytes, write, and the app reads them back. “Put back the original curve” undoes it.'),
      item('Remote session', 'Top bar. “Share my car” creates an invite code to send to a friend (WhatsApp, e-mail); they paste it in “Connect to a car” and send back a reply code; you paste it and their app reads your car directly, browser to browser. You choose read-only or read + tests; clearing faults and tests always ask you first; coding never crosses. Both computers need internet; the car stays on yours.'),
      item('Data Logger', 'Values from several modules at once (engine and gearbox together, for example), with ready-made presets, your own presets, a chart, 20 minutes of history and CSV export.'),
      item('Garage', 'Saves each car and its scans in this browser, and compares two scans: new faults, faults gone and faults still there. Export it to a file to keep a copy. It also opens from the start screen without a car.'),
      item('Library', 'This documentation, the fault guides and the diagnostic socket and bus diagrams. Available without a car.'),
      item('Log', 'The K-line traffic. If something does not work, use “Report a problem” (top bar): it saves a file with the app version, what was done and the last telegrams, with the VIN masked.'),
    ),
    sec('Status indicators',
      ul(['Cable: green when the cable is connected; red when it is unplugged (the app reopens it by itself when it comes back).', 'Car: green when modules answer; orange when the cable is fine but the car does not answer (ignition off, or the cable switch not joining pins 7 and 8).', 'Bottom of the menu: read-only mode or tests & resets unlocked.'])),
    sec('Cable options',
      p('“K+DCAN line control (DTR)” raises the cable’s DTR line only while sending on the K-line, the way the BMW software drives K+DCAN cables. Leave it off when the car reads normally; try it only if no module answers with the cable switch in the right position. If the app reports garbled answers repeatedly, set the FTDI latency timer to 1 ms (Windows: Device Manager → Ports → USB Serial Port → Properties → Port Settings → Advanced).')),
  ];
}

function moduleTable(list: ModuleDef[]) {
  return h('table', { class: 'res doc-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Module'), h('th', {}, 'Address'), h('th', {}, 'Module files (variants)'))),
    h('tbody', {}, list.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.short), ` ${m.name}`), h('td', {}, `0x${m.address.toString(16).toUpperCase().padStart(2, '0')}`), h('td', {}, (m.variants ?? []).join(' · '))))));
}

function cars() {
  return [
    sec('Cars',
      p('Only the BMW E46 3 Series: saloon, coupé, touring, convertible and compact, 1998–2006, petrol and diesel. The scan, the module list, the reference ranges and the guides are written for the E46.'),
      ul([
        h('span', {}, b('Tested on a car: '), '325i 2001, M54 with MS43 engine computer, ZF 5HP19 automatic (GS8.60.4), ABS/ASC MK20 — all modules over DS2, with the K+DCAN cable.'),
        h('span', {}, b('Supported through the module files, not yet tried on a car: '), 'MS42 (M52TU), MSS54 (M3), BMS43/46 (M43 four-cylinders), ME9 (N42/N46), MS45 (M54 from 2003), DDE (M47/M57 diesels), GS20 and SMG gearboxes, DSC III / MK60, MRS4/MRS5 airbags.'),
        h('span', {}, b('Reference ranges '), 'in Live Data are written for the M54 with MS43 and MS45; other engines show their values without ranges where none is known.'),
      ])),
    sec('Modules scanned on every car', moduleTable(E46_MODULES)),
    sec('Optional modules', p('Scanned when “Include optional modules” is ticked on the Overview. Each module that is not fitted adds about two seconds to the scan.'), moduleTable(E46_OPTIONAL_MODULES)),
    sec('Module files', p('The module files are not part of the app. Whoever distributes the package puts them in the “modulos” folder (Windows/Mac package) or inside the Mac app (Contents/Resources/modulos). Only the files E46 cars use are loaded (list in e46-modulos.txt), plus three shared tables (T_PCOD, T_AUSB, T_SCOD) used by the newer engine computers.')),
  ];
}

function guideList(ctx: PageCtx | null) {
  const f = V.filter.toLowerCase();
  const list = FAULT_GUIDES.filter((g) => !f || g.title.toLowerCase().includes(f) || g.meaning.toLowerCase().includes(f) || g.causes.some((c) => c.toLowerCase().includes(f)));
  const groups: [string, (g: FaultGuide) => boolean][] = [
    ['Engine', (g) => g.modules.includes('DME') && !g.generic],
    ['Automatic transmission', (g) => g.modules.length > 0 && g.modules.every((m) => m === 'EGS')],
    ['ABS / ASC / DSC', (g) => g.modules[0] === 'ABS' && !g.modules.includes('DME')],
    ['Immobiliser, cluster and lights', (g) => ['EWS', 'IKE', 'LCM', 'LWR'].includes(g.modules[0]) && !g.modules.includes('DME')],
    ['Body and climate', (g) => ['ZKE', 'IHKA'].includes(g.modules[0])],
    ['Airbag', (g) => g.modules[0] === 'MRS'],
    ['Any module', (g) => !g.modules.length && !g.generic],
    ['By type of fault', (g) => !!g.generic],
  ];
  const sel = FAULT_GUIDES.find((g) => g.id === V.guide);
  if (sel)
    return [
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => { V.guide = ''; ctx?.rerender() ?? rerenderOffline(); } }, '← All guides'), h('span', { class: 'note' }, sel.modules.length ? `Applies to: ${sel.modules.join(', ')}` : 'Applies to any module')),
      h('h2', { class: 'tg-title' }, sel.title),
      renderGuide(sel, ctx ? { onService: () => ctx.goPage('service'), canLive: (s) => ctx.found().some((m) => m.def.short === s && !m.dtcNA), onLive: (s) => ctx.goLive(s) } : {}),
    ];
  const input = h('input', { type: 'search', placeholder: `Search ${FAULT_GUIDES.length} guides (misfire, VANOS, window…)`, value: V.filter, 'aria-label': 'Search guides' });
  input.addEventListener('input', () => {
    V.filter = input.value;
    const pos = input.selectionStart;
    if (ctx) ctx.rerender(); else rerenderOffline();
    const n = document.querySelector<HTMLInputElement>('.doc-search input');
    n?.focus();
    n?.setSelectionRange(pos, pos);
  });
  return [
    p('Each fault in the Faults screen has a “Troubleshoot” button that opens the guide matching it. The same guides are listed here to read without a car.'),
    h('div', { class: 'doc-search' }, input),
    ...groups.map(([name, test]) => {
      const gs = list.filter(test);
      return gs.length ? sec(name, h('div', { class: 'guide-grid' }, gs.map((g) => h('button', { class: 'guide-card', onclick: () => { V.guide = g.id; if (ctx) ctx.rerender(); else rerenderOffline(); } }, h('b', {}, g.title), h('span', {}, g.meaning.split('. ')[0] + '.'))))) : null;
    }),
  ];
}

// ---------------------------------------------------------------- diagrams (drawn for this app)
function obdSocketSvg() {
  const used: Record<number, string> = { 4: 'gnd', 5: 'gnd', 7: 'k', 8: 'k', 16: 'bat' };
  const pin = (n: number) => {
    const row = n <= 8 ? 0 : 1;
    const col = (n - 1) % 8;
    const x = 70 + col * 46 + (row ? 0 : 0);
    const y = row ? 128 : 78;
    const kind = used[n];
    return `<g class="pin ${kind ?? ''}"><rect x="${x - 13}" y="${y - 17}" width="26" height="34" rx="4"/><text x="${x}" y="${y + 5}">${n}</text></g>`;
  };
  return `<svg viewBox="0 0 470 200" class="diagram" role="img" aria-label="OBD-II socket of the E46, front view">
    <path d="M40 48 H430 L404 168 H66 Z" class="body"/>
    ${Array.from({ length: 16 }, (_, i) => pin(i + 1)).join('')}
    <text x="235" y="192" class="cap">Front view of the socket under the dashboard (as you plug the cable in)</text>
  </svg>`;
}

function busSvg() {
  const box = (x: number, y: number, w: number, label: string, cls = '') => `<g class="node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="34" rx="5"/><text x="${x + w / 2}" y="${y + 22}">${label}</text></g>`;
  return `<svg viewBox="0 0 760 420" class="diagram" role="img" aria-label="Diagnosis lines and data buses of the E46">
    <text x="20" y="24" class="title">Diagnosis (what the cable talks to)</text>
    ${box(20, 50, 120, 'OBD socket', 'obd')}
    <path d="M140 60 H210" class="k"/><path d="M140 74 H210" class="k2"/>
    <text x="146" y="54" class="lbl">pin 7</text><text x="146" y="92" class="lbl">pin 8</text>
    ${box(210, 40, 100, 'DME', 'pt')}${box(320, 40, 100, 'EGS', 'pt')}
    <path d="M210 74 V120 H740" class="k2"/>
    ${['ABS/ASC', 'EWS', 'IKE', 'LCM', 'ZKE', 'IHKA', 'MRS', '…'].map((l, i) => box(210 + i * 66, 130, 60, l, 'body')).join('')}
    <text x="20" y="196" class="note">Measured on a 2001 325i: with the cable not joining pins 7 and 8, only DME and EGS answered.</text>
    <text x="20" y="246" class="title">Data buses between the modules (not used by the cable)</text>
    <path d="M40 300 H720" class="can"/><text x="40" y="290" class="lbl can-t">CAN (powertrain)</text>
    ${['DME', 'EGS / SMG', 'ABS / DSC', 'Steering angle', 'IKE'].map((l, i) => box(60 + i * 130, 310, 110, l, i === 4 ? 'gw' : 'pt')).join('')}
    <path d="M590 344 V372" class="kb"/>
    <path d="M40 380 H720" class="kb"/><text x="40" y="372" class="lbl kb-t">K-bus (body and comfort) — IKE is the gateway</text>
    <text x="40" y="404" class="note">ZKE / GM5 · LCM · IHKA · MRS · radio · navigation · MFL · PDC · rain sensor · seats · phone</text>
  </svg>`;
}

function wiring() {
  const svg = (s: string) => {
    const d = h('div', { class: 'diagram-wrap' });
    d.innerHTML = s;
    return d;
  };
  return [
    p('Diagrams drawn for this app from what the E46 modules report and what was measured on a car. They show how diagnosis reaches the modules, not factory wiring. For repairs, use the BMW wiring diagrams.'),
    sec('OBD-II socket (16 pins)', svg(obdSocketSvg()),
      h('table', { class: 'res doc-table' }, h('tbody', {},
        [['4', 'Chassis ground'], ['5', 'Signal ground'], ['7', 'Diagnosis line (K-line): engine (DME) and automatic transmission (EGS)'], ['8', 'Second diagnosis line: all other modules (ABS/ASC, EWS, cluster, lights, body, climate, airbag…)'], ['16', 'Battery positive (always on)'], ['6, 14', 'Not used for diagnosis on the E46 (no D-CAN)']].map(([a, t]) => h('tr', {}, h('td', {}, `Pin ${a}`), h('td', {}, t))))),
      p('Early E46s also have the round 20-pin diagnostic socket in the engine bay. This app uses the 16-pin socket under the dashboard.')),
    sec('Why the K+DCAN switch matters', p('A K+DCAN cable has one K-line. On cars that have two diagnosis lines (pins 7 and 8), the cable has to join both pins to reach every module: that is what the switch position for “older cars” does (the numbering differs between cables). With pins 7 and 8 separate, only the engine and the transmission answer. Changing the switch position does not harm the car; you can find the right one with a multimeter (continuity between pins 7 and 8 of the cable plug).')),
    sec('Diagnosis lines and buses', svg(busSvg()),
      ul(['CAN links the engine, transmission/SMG, ABS/DSC, steering angle sensor and instrument cluster. “CAN timeout” and “No CAN ID” faults mean a message on this bus went missing.', 'The K-bus links the instrument cluster (the gateway) with the body, light, climate, airbag and entertainment modules. “K-bus” faults point here.', 'The cable never talks on CAN or K-bus directly: diagnosis goes over the diagnosis lines.'])),
  ];
}

let offlineRerender: (() => void) | null = null;
const rerenderOffline = () => offlineRerender?.();

export function renderLibrary(ctx: PageCtx | null, back?: () => void, rerender?: () => void): (Node | null)[] {
  if (rerender) offlineRerender = rerender;
  const tabs = h('div', { class: 'doc-tabs', role: 'tablist', 'aria-label': 'Library' },
    TABS.map(([t, label]) => h('button', { class: 'chip', role: 'tab', 'aria-selected': V.tab === t ? 'true' : 'false', onclick: () => { V.tab = t; V.guide = ''; if (ctx) ctx.rerender(); else rerenderOffline(); } }, h('b', {}, label))));
  const body = V.tab === 'start' ? howItWorks() : V.tab === 'screens' ? screens() : V.tab === 'cars' ? cars() : V.tab === 'faults' ? guideList(ctx) : wiring();
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Docs and knowledge base'), h('h1', {}, 'Library'))),
    back ? h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: back }, '← Back')) : null,
    tabs,
    h('div', { class: 'doc' }, ...body),
  ];
}
