// Service screen: the common E46 procedures (adaptation resets, ABS bleeding, injector cut-out, self tests), matched
// against the modules this car has. Each runs one job of the module's own file through the normal safety rules.

import { jobStatus, flattenValues } from '../core/api/DiagSession';
import type { JobResponse } from '../core/ediabas/Ediabas';
import { SAFETY_LABEL } from '../core/api/safety';
import { resolveTask, ResolvedTask, SERVICE_TASKS, ServiceCategory, ServiceTask } from '../core/api/service';
import type { PageCtx } from './ctx';
import { confirmDialog, h } from './dom';
import { formatNumber } from './gauge';

const V = {
  resolved: new Map<string, ResolvedTask | null>(), // task id → resolution (null = not on this car)
  loading: false,
  checks: new Map<string, Set<number>>(),
  choice: new Map<string, number>(),
  results: new Map<string, { ok: boolean; text: string; values: { label: string; value: string }[] }>(),
  running: '',
  sig: '',
};

export function resetService() {
  V.resolved.clear();
  V.checks.clear();
  V.choice.clear();
  V.results.clear();
  V.sig = '';
}

async function resolveAll(ctx: PageCtx) {
  V.loading = true;
  const found = ctx.found();
  for (const t of SERVICE_TASKS) {
    const m = found.find((x) => x.def.short === t.module && x.scan?.variant && !x.dtcNA);
    if (!m) {
      V.resolved.set(t.id, null);
      continue;
    }
    const jobs = await ctx.jobs(m.def.group).catch(() => []);
    V.resolved.set(t.id, resolveTask(t, jobs));
  }
  V.loading = false;
  ctx.rerender();
}

async function run(ctx: PageCtx, r: ResolvedTask) {
  const s = ctx.session();
  const m = ctx.found().find((x) => x.def.short === r.task.module);
  if (!s || !m?.scan?.variant) return;
  const opts = r.task.choices ? [r.options[V.choice.get(r.task.id) ?? 0]] : r.options;
  const kind = opts[0].job.safety;
  if (kind === 'test' || kind === 'reset') {
    const ok = await confirmDialog(
      r.task.name,
      `${kind === 'test' ? 'This drives a real component' : 'This erases learned values'} in the ${m.def.short} (${opts.map((o) => o.job.name).join(', ')}).`,
      kind === 'test' ? 'Run test' : 'Reset',
    );
    if (!ok) return;
  }
  ctx.stopLive();
  V.running = r.task.id;
  ctx.setBusy('service');
  ctx.rerender();
  const values: { label: string; value: string }[] = [];
  let ok = true;
  let text = '';
  for (const o of opts) {
    const res: JobResponse = await s.run(m.scan.variant, o.job.name);
    const st = jobStatus(res.resultSets);
    if (res.error) {
      ok = false;
      text = res.error.text;
      break;
    }
    if (st && st !== 'OKAY') {
      ok = false;
      text = `The module answered: ${st}`;
    }
    for (const v of flattenValues(res.resultSets)) if (!/TELEGRAM|^_?TEL_/i.test(v.key)) values.push({ label: v.label, value: `${typeof v.value === 'number' ? formatNumber(v.value) : v.value}${v.unit && v.unit !== '-' ? ` ${v.unit}` : ''}` });
  }
  if (ok) text = kind === 'read' ? 'Read.' : 'Done. The module accepted the request.';
  V.results.set(r.task.id, { ok, text, values });
  ctx.log(ok ? 'info' : 'tx', `Service: ${r.task.name} — ${text}`);
  V.running = '';
  ctx.setBusy('');
  ctx.rerender();
}

const CATS: ServiceCategory[] = ['Adaptations', 'Brakes & DSC', 'Engine checks', 'Instruments & lights', 'Calibration & service'];

function card(ctx: PageCtx, r: ResolvedTask) {
  const t: ServiceTask = r.task;
  const blocked = r.safety === 'write';
  const locked = (r.safety === 'test' || r.safety === 'reset') && !ctx.isService();
  const checks = V.checks.get(t.id) ?? V.checks.set(t.id, new Set()).get(t.id)!;
  const ready = checks.size >= t.before.length;
  const res = V.results.get(t.id);
  const busy = ctx.busy() || !!V.running;
  return h('article', { class: `svc ${blocked ? 'blocked' : ''}` },
    h('div', { class: 'svc-head' },
      h('h3', {}, t.name),
      h('span', { class: 'chip-mini' }, t.module),
      h('span', { class: `tag safety-${r.safety}` }, blocked ? 'Not available: permanent write' : SAFETY_LABEL[r.safety])),
    h('p', { class: 'desc' }, t.what),
    blocked
      ? h('div', { class: 'msg warn' }, t.blockedNote ?? 'This procedure writes permanently to the module, which this version never does.')
      : [
          t.before.length
            ? h('div', { class: 'svc-before' }, h('b', {}, 'Before you start'), t.before.map((b, i) => h('label', {},
                h('input', { type: 'checkbox', checked: checks.has(i), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) checks.add(i); else checks.delete(i); ctx.rerender(); } }), b)))
            : null,
          t.choices && r.options.length > 1
            ? h('div', { class: 'svc-choices', role: 'radiogroup', 'aria-label': 'Choose' }, r.options.map((o, i) => h('button', { class: `btn ${(V.choice.get(t.id) ?? 0) === i ? 'on' : ''}`, 'aria-pressed': (V.choice.get(t.id) ?? 0) === i ? 'true' : 'false', onclick: () => { V.choice.set(t.id, i); ctx.rerender(); } }, o.label)))
            : null,
          h('div', { class: 'toolbar' },
            locked
              ? h('button', { class: 'btn', onclick: () => ctx.unlockService() }, 'Unlock tests & resets to run')
              : h('button', { class: 'btn primary', disabled: !ready || busy || !ctx.cableOk(), onclick: () => run(ctx, r) }, V.running === t.id ? 'Running…' : r.safety === 'read' ? 'Read' : 'Run'),
            !ready && !locked ? h('span', { class: 'note' }, 'Tick every condition first.') : null,
            h('span', { class: 'note mono' }, (t.choices ? [r.options[V.choice.get(t.id) ?? 0]] : r.options).map((o) => o.job.name).join(', '))),
          res ? h('div', { class: `msg ${res.ok ? 'ok' : 'err'}` }, res.text) : null,
          res?.values.length ? h('table', { class: 'res' }, h('tbody', {}, res.values.slice(0, 40).map((v) => h('tr', {}, h('td', {}, v.label), h('td', {}, v.value))))) : null,
          res?.ok && t.after ? h('p', { class: 'availnote' }, h('b', {}, 'Next: '), t.after) : null,
        ]);
}

export function renderService(ctx: PageCtx): (Node | null)[] {
  const sig = ctx.found().map((m) => `${m.def.short}:${m.scan?.variant}`).join(',');
  if (sig !== V.sig && !V.loading && ctx.found().length) {
    V.sig = sig;
    V.resolved.clear();
    void resolveAll(ctx);
  }
  const avail = SERVICE_TASKS.map((t) => V.resolved.get(t.id)).filter((r): r is ResolvedTask => !!r);
  const missing = SERVICE_TASKS.filter((t) => V.resolved.get(t.id) === null);
  const service = ctx.isService();
  return [
    h('div', { class: 'mh' }, h('div', {}, h('p', { class: 'kicker' }, 'Guided procedures for this car'), h('h1', {}, 'Service'))),
    h('div', { class: `safety ${service ? 'unlocked' : ''}` },
      h('span', { class: `led ${service ? 'warn' : 'ok'}` }),
      h('div', {}, h('b', {}, service ? 'Tests & resets unlocked' : 'Read-only mode'), h('span', {}, service ? 'Procedures that drive parts or erase learned values can run.' : 'Readings run now. Tests and resets need “Unlock tests & resets”. Permanent writes are never sent.')),
      service ? null : h('button', { class: 'btn', onclick: () => ctx.unlockService() }, 'Unlock tests & resets')),
    !ctx.found().length ? h('div', { class: 'empty' }, h('strong', {}, 'Scan the car first'), 'The procedures are matched to the modules that answer.') : null,
    V.loading ? h('div', { class: 'msg info' }, 'Matching procedures to this car’s modules…') : null,
    ...CATS.map((c) => {
      const list = avail.filter((r) => r.task.category === c);
      return list.length ? h('section', { class: 'lv-group' }, h('div', { class: 'lv-group-head' }, h('h2', {}, c), h('span', {}, `${list.length}`)), h('div', { class: 'svc-grid' }, list.map((r) => card(ctx, r)))) : null;
    }),
    missing.length && !V.loading
      ? h('details', { class: 'availnote' }, h('summary', {}, `${missing.length} procedures are not available on this car`),
          h('p', {}, 'The module is not fitted, did not answer, has no module file, or its file has no such job:'),
          h('ul', {}, missing.map((t) => h('li', {}, `${t.name} (${t.module})`))))
      : null,
  ];
}
