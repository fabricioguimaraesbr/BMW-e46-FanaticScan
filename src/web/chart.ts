// Minimal canvas charts (no dependencies). Each series is auto-scaled so different units share one plot.

function prep(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const hgt = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  return { g, w, h: hgt };
}

function line(g: CanvasRenderingContext2D, data: number[], color: string, x0: number, y0: number, w: number, h: number, maxPoints: number, width: number) {
  if (data.length < 2) return;
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const step = w / (maxPoints - 1);
  const start = maxPoints - data.length;
  g.beginPath();
  data.forEach((v, i) => {
    const x = x0 + (start + i) * step;
    const y = y0 + h - ((v - min) / (max - min)) * h;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.stroke();
}

export function drawSpark(c: HTMLCanvasElement, data: number[], color: string) {
  const { g, w, h } = prep(c);
  line(g, data.slice(-80), color, 0, 2, w, h - 4, 80, 1.5);
}

export function drawChart(c: HTMLCanvasElement, series: { data: number[]; color: string }[]) {
  const { g, w, h } = prep(c);
  const grid = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#ddd';
  g.strokeStyle = grid;
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round((h - 1) * (i / 4)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  for (const s of series) line(g, s.data.slice(-300), s.color, 0, 6, w, h - 12, 300, 2);
}
