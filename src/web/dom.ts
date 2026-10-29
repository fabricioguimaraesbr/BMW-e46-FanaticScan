// Tiny DOM helpers shared by the screens.

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Child | Child[] | Child[][])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(2) as Child[]) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const nodes = (xs: (Node | null | false | undefined)[]) => xs.filter((x): x is Node => !!x);

export function confirmDialog(title: string, text: string, action: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const d = h('dialog', {},
      h('h2', {}, title),
      h('p', {}, text),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { d.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { d.close(); resolve(true); } }, action),
      ),
    );
    d.addEventListener('cancel', () => resolve(false));
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => d.remove());
  });
}

/** Asks for a short text (a car name, a preset name). Resolves null when cancelled. */
export function promptDialog(title: string, text: string, value: string, action: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, 'aria-label': title, class: 'dlg-input' });
    const done = (v: string | null) => { d.close(); resolve(v); };
    const d = h('dialog', {},
      h('h2', {}, title),
      text ? h('p', {}, text) : null,
      input,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => done(input.value.trim() || null) }, action),
      ),
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); });
    d.addEventListener('cancel', () => resolve(null));
    document.body.append(d);
    d.showModal();
    input.select();
    d.addEventListener('close', () => d.remove());
  });
}

export function download(name: string, data: string, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};
