// Troubleshoot panel for one fault, and the same guide rendered in the Library.

import type { Dtc } from '../core/api/DiagSession';
import { FaultGuide, faultTypeNotes, guideFor, liveLabels, liveModuleFor } from '../core/api/faultguide';
import { SERVICE_TASKS } from '../core/api/service';
import type { PageCtx } from './ctx';
import { h } from './dom';

export interface GuideActions {
  /** module short of the fault (for "open live data") */
  module?: string;
  /** the module answered the scan (actions are only offered with a car connected) */
  canLive?: (short: string) => boolean;
  onLive?: (short: string) => void;
  onService?: () => void;
}

/** The guide body: meaning, causes, checks (with shortcuts), fix, after the repair. */
export function renderGuide(g: FaultGuide, a: GuideActions = {}, fault?: Dtc): HTMLElement {
  const notes = fault ? faultTypeNotes(fault) : [];
  const section = (title: string, ...kids: (Node | string | null)[]) => h('section', { class: 'tg-sec' }, h('h3', {}, title), ...kids);
  return h('div', { class: 'tg' },
    g.warning ? h('div', { class: 'msg err tg-warn' }, h('b', {}, 'Safety: '), g.warning) : null,
    g.generic ? h('p', { class: 'availnote' }, `No guide written for this exact fault yet: this is the general guide for “${g.title.toLowerCase()}”.`) : null,
    section('What it means', h('p', {}, g.meaning)),
    fault && (notes.length || fault.env.length)
      ? section('This fault in your car',
          notes.length ? h('ul', {}, notes.map((n) => h('li', {}, n))) : null,
          fault.env.length ? h('div', { class: 'tg-env' }, h('b', {}, 'Conditions when it was stored'), h('div', { class: 'env' }, fault.env.map((e) => h('div', {}, h('span', {}, e.name), h('b', {}, `${e.value} ${e.unit}`))))) : null)
      : null,
    section('Most likely causes', h('ol', {}, g.causes.map((c) => h('li', {}, c)))),
    section('How to check', h('ol', { class: 'tg-checks' }, g.checks.map((c) => {
      const task = c.service ? SERVICE_TASKS.find((t) => t.id === c.service) : undefined;
      const liveMod = c.live ? liveModuleFor(c.live, a.module ?? '') : '';
      return h('li', {},
        h('span', {}, c.text),
        c.live ? h('div', { class: 'tg-live' }, h('small', {}, `Live Data${liveMod ? ` (${liveMod})` : ''}: ${liveLabels(c.live).join(', ')}`),
          a.onLive && a.canLive?.(liveMod) ? h('button', { class: 'btn', onclick: () => a.onLive!(liveMod) }, `Open ${liveMod} live data`) : null) : null,
        task ? h('div', { class: 'tg-live' }, h('small', {}, `Service: ${task.name}`), a.onService ? h('button', { class: 'btn', onclick: () => a.onService!() }, 'Open Service') : null) : null);
    }))),
    section('How to fix', h('ul', {}, g.fix.map((f) => h('li', {}, f)))),
    g.after?.length ? section('After the repair', h('ul', {}, g.after.map((f) => h('li', {}, f)))) : null,
    h('p', { class: 'refnote' }, 'Written for E46Fanatics Scan from general E46 workshop experience, not from BMW documents. Confirm with a check or a measurement before replacing parts.'),
  );
}

/** Opens the troubleshoot panel for a fault of a module. */
export function openTroubleshoot(ctx: PageCtx, module: { short: string; name: string }, d: Dtc, code: string) {
  const g = guideFor(module.short, d);
  const close = () => dlg.close();
  const found = (s: string) => ctx.found().some((m) => m.def.short === s && !m.dtcNA);
  const dlg = h('dialog', { class: 'tg-dlg', 'aria-label': `Troubleshoot ${code}` },
    h('div', { class: 'tg-head' },
      h('div', {},
        h('p', { class: 'kicker' }, `${module.name} · fault ${code}${d.pcode ? ` · ${d.pcode}` : ''}`),
        h('h2', {}, d.text || 'Fault without description'),
        h('p', { class: 'tg-guide' }, g.generic ? 'General guide' : `Guide: ${g.title}`)),
      h('button', { class: 'btn ghost tg-x', onclick: close, 'aria-label': 'Close' }, '✕')),
    renderGuide(g, {
      module: module.short,
      canLive: found,
      onLive: (s) => { close(); ctx.goLive(s); },
      onService: () => { close(); ctx.goPage('service'); },
    }, d),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: close }, 'Close')),
  );
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
}
