// Start screen backdrop: dark, slowly moving light behind frosted glass (pure CSS animation, no images).

let backdrop: HTMLElement | null = null;

/** One instance, reused across redraws so the motion does not restart. */
export function liquidBackdrop(): HTMLElement {
  if (backdrop) return backdrop;
  const wrap = document.createElement('div');
  wrap.className = 'liquid';
  wrap.setAttribute('aria-hidden', 'true');
  for (const c of ['b1', 'b2', 'b3', 'b4', 'b5']) {
    const blob = document.createElement('span');
    blob.className = `blob ${c}`;
    wrap.append(blob);
  }
  const sheen = document.createElement('span');
  sheen.className = 'sheen';
  wrap.append(sheen);
  backdrop = wrap;
  return wrap;
}
