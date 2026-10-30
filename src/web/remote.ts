// Remote session screen: WebRTC data channel between two browsers, set up by copying two codes (no server of ours).
// The car owner creates an invite code, the helper answers with a reply code, and the browsers connect directly.
// Public STUN servers only tell each browser its internet address; the diagnosis data goes browser to browser.

import { Approval, HelloInfo, Pipe, RemoteAccess, RemoteHost, RemoteSession, makeCode, readCode } from '../core/remote/remote';
import type { ScanEntry, Session } from '../core/api/DiagSession';
import { h } from './dom';

const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CHUNK = 16000;

/** RTCDataChannel as a text pipe; long messages (job lists) are cut into pieces and put back together. */
function dcPipe(dc: RTCDataChannel, pc: RTCPeerConnection): Pipe {
  const parts = new Map<string, string[]>();
  let n = 0;
  const p: Pipe = {
    onmessage: null,
    onclose: null,
    send(t) {
      if (dc.readyState !== 'open') return;
      if (t.length <= CHUNK) return dc.send(t);
      const id = `${Date.now().toString(36)}${n++}`;
      const total = Math.ceil(t.length / CHUNK);
      for (let i = 0; i < total; i++) dc.send(`#${id},${i},${total},${t.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    },
    close() {
      try { dc.close(); } catch { /* closed */ }
      pc.close();
    },
  };
  dc.onmessage = (e) => {
    const t = String(e.data);
    if (!t.startsWith('#')) return p.onmessage?.(t);
    const [id, i, total] = t.slice(1).split(',', 3);
    const data = t.slice(t.indexOf(',', t.indexOf(',', t.indexOf(',') + 1) + 1) + 1);
    const a = parts.get(id) ?? parts.set(id, new Array(Number(total))).get(id)!;
    a[Number(i)] = data;
    if (a.filter((x) => x !== undefined).length === a.length) {
      parts.delete(id);
      p.onmessage?.(a.join(''));
    }
  };
  let closed = false;
  const end = () => { if (closed) return; closed = true; p.onclose?.(); pc.close(); };
  dc.onclose = end;
  pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end(); });
  return p;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, 6000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}

export interface ShareState {
  access: RemoteAccess;
  host: RemoteHost;
  since: number;
  stop(): void;
}

export interface RemoteUi {
  /** the session of the car connected here (cable or simulator), or null */
  carSession(): Session | null;
  app: string;
  carTitle(): string;
  cachedScan(): ScanEntry[];
  sharing(): ShareState | null;
  /** asks the owner on this computer */
  approve(a: Approval): Promise<boolean>;
  onShareStarted(s: ShareState): void;
  onShareEnded(reason: string): void;
  onActivity(text: string, refused: boolean): void;
  onHelperConnected(session: RemoteSession, info: HelloInfo): void;
  onHelperClosed(): void;
}

const copyBtn = (area: HTMLTextAreaElement) =>
  h('button', { class: 'btn', onclick: async (e: Event) => {
    const b = e.target as HTMLButtonElement;
    try { await navigator.clipboard.writeText(area.value); b.textContent = 'Copied'; } catch { area.select(); b.textContent = 'Press Ctrl/⌘+C'; }
    setTimeout(() => (b.textContent = 'Copy code'), 2500);
  } }, 'Copy code');

export function openRemoteDialog(ui: RemoteUi) {
  let pc: RTCPeerConnection | null = null;
  let connected = false;
  const body = h('div', { class: 'rm-body' });
  const status = h('p', { class: 'rm-status', role: 'status' });
  const setStatus = (t: string, cls = '') => { status.textContent = t; status.className = `rm-status ${cls}`; };
  const close = () => d.close();
  const d = h('dialog', { class: 'rm-dlg', 'aria-label': 'Remote session' },
    h('h2', {}, 'Remote session'),
    h('p', {}, 'Let a friend from the community see your car, or look at theirs. The car stays on the computer with the cable; the other app reads it through a direct browser-to-browser link. Both computers need internet.'),
    body, status,
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: close }, 'Close')));
  d.addEventListener('close', () => { if (!connected) pc?.close(); d.remove(); });

  const share = ui.sharing();
  const start = () => {
    setStatus('');
    if (share) {
      body.replaceChildren(
        h('div', { class: 'msg ok' }, `Sharing this car since ${new Date(share.since).toLocaleTimeString('en-GB')} (${share.access === 'read' ? 'read only' : 'read + tests'}). ${share.host.requests} requests so far.`),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: () => { share.stop(); close(); } }, 'Stop sharing')));
      return;
    }
    const car = ui.carSession();
    body.replaceChildren(
      h('div', { class: 'rm-choice' },
        h('button', { class: 'rm-card', disabled: !car, onclick: shareView },
          h('b', {}, 'Share my car'), h('span', {}, car ? 'Your car is connected here. Create an invite code for your helper.' : 'Connect the cable (or the simulator) first.')),
        h('button', { class: 'rm-card', disabled: !!car, onclick: connectView },
          h('b', {}, 'Connect to a car'), h('span', {}, car ? 'Disconnect your own car first.' : 'Paste the invite code a friend sent you.'))));
  };

  const shareView = () => {
    let access: RemoteAccess = 'read';
    const opt = (v: RemoteAccess, title: string, text: string) =>
      h('label', { class: 'rm-opt' }, h('input', { type: 'radio', name: 'rm-access', value: v, checked: v === access, onchange: () => (access = v) }), h('span', {}, h('b', {}, title), ' ', text));
    body.replaceChildren(
      h('h3', {}, 'Share my car'),
      h('p', { class: 'note' }, 'What may your helper do? This computer enforces it, not theirs.'),
      h('div', { class: 'rm-opts', role: 'radiogroup', 'aria-label': 'Access' },
        opt('read', 'Read only.', 'Faults, live data, identification and readings. Clearing faults asks you first.'),
        opt('tests', 'Read + tests.', 'Also actuator tests and adaptation resets, each one approved by you here.'),
        h('p', { class: 'note' }, 'Coding and anything else that writes to a module is never available remotely.')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void createInvite(access) }, 'Create invite code'), h('button', { class: 'btn', onclick: start }, 'Back')));
  };

  const createInvite = async (access: RemoteAccess) => {
    setStatus('Creating the invite code…');
    try {
      pc = new RTCPeerConnection({ iceServers: ICE });
      const dc = pc.createDataChannel('e46scan', { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const code = await makeCode('offer', pc.localDescription!.sdp);
      const invite = h('textarea', { class: 'rm-code', readonly: true, rows: 4, 'aria-label': 'Invite code' }, code);
      const reply = h('textarea', { class: 'rm-code', rows: 4, placeholder: 'E46-REPLY-…', 'aria-label': 'Reply code from your helper' });
      const go = h('button', { class: 'btn primary' }, 'Connect');
      body.replaceChildren(
        h('h3', {}, '1 · Send this invite code to your helper'), invite, h('div', { class: 'row' }, copyBtn(invite)),
        h('h3', {}, '2 · Paste the reply code they send back'), reply, h('div', { class: 'row' }, go),
        h('p', { class: 'note' }, 'Keep this window open until the helper is connected. The code works once.'));
      setStatus('');
      go.addEventListener('click', async () => {
        try {
          const r = await readCode(reply.value);
          if (r.type !== 'answer') throw new Error('That is an invite code. Paste the reply code your helper created.');
          setStatus('Connecting…');
          await pc!.setRemoteDescription({ type: 'answer', sdp: r.sdp });
        } catch (e) {
          setStatus((e as Error).message, 'err');
        }
      });
      const timer = setTimeout(() => { if (!connected && pc?.connectionState !== 'connected') setStatus('Still connecting… If it never connects, one of the two networks blocks direct links (some mobile and company networks). Try another network, such as a phone hotspot.', 'warn'); }, 20000);
      dc.onopen = () => {
        clearTimeout(timer);
        connected = true;
        const pipe = dcPipe(dc, pc!);
        const session = ui.carSession();
        if (!session) return pipe.close();
        const host = new RemoteHost(pipe, { session, access, app: ui.app, car: ui.carTitle, cachedScan: ui.cachedScan, approve: ui.approve, onActivity: ui.onActivity });
        const state: ShareState = { access, host, since: Date.now(), stop: () => { pipe.onclose = null; host.close(); ui.onShareEnded('You stopped sharing.'); } };
        pipe.onclose = () => ui.onShareEnded('The helper disconnected.');
        ui.onShareStarted(state);
        close();
      };
    } catch (e) {
      setStatus(`Could not create the code: ${(e as Error).message}`, 'err');
    }
  };

  const connectView = () => {
    const invite = h('textarea', { class: 'rm-code', rows: 4, placeholder: 'E46-INVITE-…', 'aria-label': 'Invite code' });
    body.replaceChildren(
      h('h3', {}, 'Connect to a car'),
      h('p', { class: 'note' }, 'Paste the invite code the car owner sent you.'),
      invite,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void answer(invite.value) }, 'Create reply code'), h('button', { class: 'btn', onclick: start }, 'Back')));
    invite.focus();
  };

  const answer = async (text: string) => {
    try {
      const r = await readCode(text);
      if (r.type !== 'offer') throw new Error('That is a reply code. Paste the invite code the car owner created.');
      setStatus('Creating the reply code…');
      pc = new RTCPeerConnection({ iceServers: ICE });
      const p = pc;
      p.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.onopen = async () => {
          connected = true;
          const session = new RemoteSession(dcPipe(dc, p), () => ui.onHelperClosed());
          try {
            const info = await session.hello();
            ui.onHelperConnected(session, info);
            close();
          } catch (e) {
            setStatus(`Connected, but the car did not answer: ${(e as Error).message}`, 'err');
          }
        };
      };
      await p.setRemoteDescription({ type: 'offer', sdp: r.sdp });
      await p.setLocalDescription(await p.createAnswer());
      await gathered(p);
      const code = await makeCode('answer', p.localDescription!.sdp);
      const reply = h('textarea', { class: 'rm-code', readonly: true, rows: 4, 'aria-label': 'Reply code' }, code);
      body.replaceChildren(h('h3', {}, 'Send this reply code back to the car owner'), reply, h('div', { class: 'row' }, copyBtn(reply)), h('p', { class: 'note' }, 'Keep this window open. When they paste it, the car opens here by itself.'));
      setStatus('Waiting for the car owner…');
    } catch (e) {
      setStatus((e as Error).message, 'err');
    }
  };

  start();
  document.body.append(d);
  d.showModal();
}

/** Owner approval for a helper's action; refused by itself after a minute. */
export function approvalDialog(a: Approval): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(t); d.close(); resolve(v); };
    const t = setTimeout(() => finish(false), 60000);
    const d = h('dialog', { class: 'rm-dlg' },
      h('p', { class: 'kicker' }, 'Remote session · your helper asks'),
      h('h2', {}, a.title),
      h('p', {}, a.detail),
      a.kind === 'test' ? h('div', { class: 'msg warn' }, 'Drives a real component. Car parked, selector in P, handbrake on. Allowing it unlocks tests & resets on this computer.') : null,
      a.kind === 'reset' ? h('div', { class: 'msg warn' }, 'Erases learned values; the car re-learns them while driving. Allowing it unlocks tests & resets on this computer.') : null,
      h('p', { class: 'note' }, 'Refused automatically in one minute.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => finish(false) }, 'Refuse'), h('button', { class: 'btn danger', onclick: () => finish(true) }, 'Allow')));
    d.addEventListener('cancel', () => finish(false));
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  });
}
