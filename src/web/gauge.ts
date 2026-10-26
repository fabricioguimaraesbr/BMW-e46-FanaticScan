// SVG analog dial, M Sport style: white scale on graphite, blue normal band, amber needle and digital readout.

import type { Reference, RefState } from '../core/api/reference';

const NS = 'http://www.w3.org/2000/svg';
const SWEEP = 270; // degrees
const START = 135; // degrees, 0 = 3 o'clock, clockwise

export interface GaugeRange {
  min: number;
  max: number;
  red?: number; // start of the red zone
  major: number; // major tick step
  label?: (v: number) => string;
}

/** Known scales for the MS43 values; anything else is auto-ranged from what has been seen. */
const RANGES: Record<string, GaugeRange> = {
  STAT_MOTORDREHZAHL_MWB_WERT: { min: 0, max: 7000, red: 6500, major: 1000, label: (v) => String(v / 1000) },
  STAT_GESCHWINDIGKEIT_MWB_WERT: { min: 0, max: 260, major: 40 },
  STAT_MOTORTEMP_MWB_WERT: { min: 40, max: 140, red: 115, major: 20 },
  STAT_KUEHLW_AUSL_TEMP_MWB_WERT: { min: 0, max: 120, major: 20 },
  STAT_OEL_TEMP_MWB_WERT: { min: 40, max: 160, red: 140, major: 20 },
  STAT_AN_LUFTTEMP_MWB_WERT: { min: -20, max: 80, major: 20 },
  STAT_UBATT_MWB_WERT: { min: 8, max: 16, red: 15.2, major: 2 },
  STAT_KL15_MWB_WERT: { min: 8, max: 16, red: 15.2, major: 2 },
  STAT_LMM_MASSE_MWB_WERT: { min: 0, max: 800, major: 200 },
  STAT_EINSPRITZZEIT_MWB_WERT: { min: 0, max: 20, major: 5 },
  STAT_PWG_WINKEL_MWB_WERT: { min: 0, max: 100, major: 20 },
  STAT_DKP_WINKEL_MWB_WERT: { min: 0, max: 100, major: 20 },
  STAT_ZUENDWINKEL_MWB_WERT: { min: -20, max: 60, major: 20 },
  STAT_LAMBDA_INTEGRATOR_1_MWB_WERT: { min: 0.7, max: 1.3, major: 0.1 },
  STAT_LAMBDA_INTEGRATOR_2_MWB_WERT: { min: 0.7, max: 1.3, major: 0.1 },
  STAT_LAST_MWB_WERT: { min: 0, max: 600, major: 100 },
};

function niceStep(span: number) {
  const raw = span / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

const BASE_RANGES: Record<string, GaugeRange> = {
  GETRIEBETEMPERATUR: { min: 20, max: 140, red: 120, major: 20 },
  UBAT: { min: 8, max: 16, red: 15.2, major: 2 },
  STEGDREHZAHL: { min: 0, max: 7000, major: 1000, label: (v) => String(v / 1000) },
  ABTRIEBSDREHZAHL: { min: 0, max: 7000, major: 1000, label: (v) => String(v / 1000) },
  MOTORDREHZAHL: { min: 0, max: 7000, red: 6500, major: 1000, label: (v) => String(v / 1000) },
  MOTORTEMPERATUR: { min: 40, max: 140, red: 115, major: 20 },
  OBD_0C: { min: 0, max: 7000, red: 6500, major: 1000, label: (v) => String(v / 1000) },
  OBD_0D: { min: 0, max: 260, major: 40 },
  OBD_05: { min: 40, max: 140, red: 115, major: 20 },
  OBD_0F: { min: -20, max: 80, major: 20 },
  OBD_42: { min: 8, max: 16, red: 15.2, major: 2 },
  RAD_GESCHW_VL: { min: 0, max: 260, major: 40 }, RAD_GESCHW_VR: { min: 0, max: 260, major: 40 },
  RAD_GESCHW_HL: { min: 0, max: 260, major: 40 }, RAD_GESCHW_HR: { min: 0, max: 260, major: 40 },
};

export function rangeFor(key: string, history: number[]): GaugeRange {
  if (RANGES[key]) return RANGES[key];
  const base = key.toUpperCase().replace(/^(STATUS|STAT)_/, '').replace(/_(WERT|EIN)$/, '').replace(/_MWB$/, '');
  if (BASE_RANGES[base]) return BASE_RANGES[base];
  let lo = Math.min(0, ...history);
  let hi = Math.max(1, ...history);
  const step = niceStep(hi - lo || 1);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil((hi * 1.15) / step) * step;
  return { min: lo, max: hi, major: step };
}

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const angleOf = (r: GaugeRange, v: number) => START + (Math.max(0, Math.min(1, (v - r.min) / (r.max - r.min))) * SWEEP);

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

export class Gauge {
  readonly root: SVGSVGElement;
  private needle: SVGGElement;
  private valueText: SVGTextElement;
  private unitText: SVGTextElement;
  private labelText: SVGTextElement;
  private scale: SVGGElement;
  private range: GaugeRange | null = null;
  private key = '';
  private ref: Reference | undefined;

  constructor() {
    const cx = 100, cy = 100;
    this.root = el('svg', { viewBox: '0 0 200 222', class: 'dial', role: 'img' });
    this.root.append(el('circle', { cx, cy, r: 96, class: 'dial-bezel' }));
    this.root.append(el('circle', { cx, cy, r: 90, class: 'dial-face' }));
    this.scale = el('g', {});
    this.root.append(this.scale);
    this.needle = el('g', { class: 'dial-needle' });
    this.needle.append(el('path', { d: `M ${cx - 4} ${cy} L ${cx + 78} ${cy - 1.2} L ${cx + 78} ${cy + 1.2} Z`, class: 'needle' }));
    this.root.append(this.needle);
    this.root.append(el('circle', { cx, cy, r: 7, class: 'hub' }));
    this.valueText = el('text', { x: cx, y: 168, class: 'dial-value', 'text-anchor': 'middle' });
    this.unitText = el('text', { x: cx, y: 184, class: 'dial-unit', 'text-anchor': 'middle' });
    this.labelText = el('text', { x: cx, y: 216, class: 'dial-label', 'text-anchor': 'middle' });
    this.root.append(this.valueText, this.unitText, this.labelText);
  }

  private drawScale(r: GaugeRange) {
    const cx = 100, cy = 100;
    this.scale.replaceChildren();
    this.scale.append(el('path', { d: arcPath(cx, cy, 82, START, START + SWEEP), class: 'scale-arc' }));
    if (r.red !== undefined) this.scale.append(el('path', { d: arcPath(cx, cy, 82, angleOf(r, r.red), START + SWEEP), class: 'scale-red' }));
    const ref = this.ref;
    if (ref && (ref.lo !== undefined || ref.hi !== undefined)) {
      const a0 = angleOf(r, ref.lo ?? r.min);
      const a1 = angleOf(r, ref.hi ?? r.max);
      if (a1 - a0 > 1) this.scale.append(el('path', { d: arcPath(cx, cy, 88, a0, a1), class: 'scale-ok' }));
    }
    const minor = r.major / 5;
    const n = Math.round((r.max - r.min) / minor);
    for (let i = 0; i <= n; i++) {
      const v = r.min + i * minor;
      const a = angleOf(r, v);
      const major = i % 5 === 0;
      const [x0, y0] = polar(cx, cy, major ? 70 : 76, a);
      const [x1, y1] = polar(cx, cy, 84, a);
      const red = r.red !== undefined && v >= r.red;
      this.scale.append(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: `tick ${major ? 'major' : ''} ${red ? 'red' : ''}` }));
      if (major) {
        const [tx, ty] = polar(cx, cy, 57, a);
        const t = el('text', { x: tx, y: ty + 4, class: `tick-label ${red ? 'red' : ''}`, 'text-anchor': 'middle' });
        const val = +v.toFixed(3);
        t.textContent = r.label ? r.label(val) : String(val);
        this.scale.append(t);
      }
    }
  }

  update(key: string, label: string, value: number | string | undefined, unit: string, history: number[], ref?: Reference, state: RefState = 'na') {
    if (key !== this.key) {
      this.key = key;
      this.range = null;
      this.ref = ref;
    }
    const num = typeof value === 'number' ? value : NaN;
    const r = rangeFor(key, history);
    const changed = !this.range || r.min !== this.range.min || r.max !== this.range.max;
    if (changed) {
      this.range = r;
      this.drawScale(r);
    }
    const a = Number.isNaN(num) ? START : angleOf(this.range!, num);
    this.needle.style.transform = `rotate(${a}deg)`;
    this.valueText.textContent = Number.isNaN(num) ? '—' : formatNumber(num);
    this.unitText.textContent = unit === '-' ? '' : unit;
    this.labelText.textContent = label;
    this.root.setAttribute('aria-label', `${label}: ${this.valueText.textContent} ${unit}`);
    this.root.classList.toggle('redline', (this.range!.red !== undefined && num >= this.range!.red) || state === 'high' || state === 'low');
    this.root.classList.toggle('cold', state === 'cold');
  }
}

export function formatNumber(v: number) {
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  const a = Math.abs(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2, minimumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
}
