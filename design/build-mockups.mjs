// Generates 3 static design proposals (Live Data screen) for review. node design/build-mockups.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const logo = readFileSync(dir + 'e46fanatics.svg', 'utf8').replace(/<\?xml[^>]*>|<!--[^>]*-->/g, '').replace(/id="Layer_1"/, 'class="logo" aria-label="E46Fanatics"');

const NAV = ['Overview', 'Faults', 'Live Data', 'Tests & Functions', 'Report', 'Log'];
const MODULES = [['DME', 'MS43 engine', 'ok'], ['EGS', '5HP19 transmission', 'ok'], ['ABS/DSC', 'MK20', 'warn'], ['Airbag', 'MRS', 'ok'], ['Cluster', 'KOMBI', 'ok'], ['IHKA', 'Climate', 'ok']];
const DIALS = [
  { label: 'Engine speed', unit: 'rpm', min: 0, max: 7000, red: 6500, major: 1000, v: 720, lo: 600, hi: 6500, fmt: (v) => v / 1000 },
  { label: 'Coolant', unit: '°C', min: 40, max: 140, red: 115, major: 20, v: 96, lo: 80, hi: 113 },
  { label: 'Oil temp', unit: '°C', min: 40, max: 160, red: 140, major: 20, v: 104, lo: 70, hi: 130 },
  { label: 'Battery', unit: 'V', min: 8, max: 16, red: 15.2, major: 2, v: 14.1, lo: 12.4, hi: 14.8 },
];
const TILES = [
  ['Intake air', '31', '°C', '−25 – 60', 'ok'],
  ['Air mass', '17.4', 'kg/h', '10 – 25 at idle', 'ok'],
  ['Injection time', '2.9', 'ms', '1.8 – 4.5 at idle', 'ok'],
  ['Ignition timing', '9.0', '°', '0 – 20 at idle', 'ok'],
  ['Fuel trim B1', '1.12', '', '0.90 – 1.10', 'high'],
  ['Fuel trim B2', '1.04', '', '0.90 – 1.10', 'ok'],
];

const GAUGE_JS = `
const NS='http://www.w3.org/2000/svg';
const P=(cx,cy,r,d)=>{const a=d*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]};
function arc(r,a0,a1){const[x0,y0]=P(100,100,r,a0),[x1,y1]=P(100,100,r,a1);return 'M'+x0+' '+y0+' A'+r+' '+r+' 0 '+(a1-a0>180?1:0)+' 1 '+x1+' '+y1}
function e(t,a,p){const n=document.createElementNS(NS,t);for(const k in a)n.setAttribute(k,a[k]);p&&p.append(n);return n}
function dial(host,d,o){const S=o.sweep,ST=o.start,ang=v=>ST+Math.max(0,Math.min(1,(v-d.min)/(d.max-d.min)))*S;
 const s=e('svg',{viewBox:'0 0 200 '+(o.h||190),class:'dial'},host);
 e('circle',{cx:100,cy:100,r:97,class:'bezel'},s);e('circle',{cx:100,cy:100,r:90,class:'face'},s);
 e('path',{d:arc(84,ST,ST+S),class:'arc'},s);
 if(d.lo!=null)e('path',{d:arc(89,ang(d.lo),ang(d.hi)),class:'ok'},s);
 if(d.red!=null)e('path',{d:arc(84,ang(d.red),ST+S),class:'red'},s);
 const mi=d.major/5,n=Math.round((d.max-d.min)/mi);
 for(let i=0;i<=n;i++){const v=d.min+i*mi,a=ang(v),M=i%5==0,r=d.red!=null&&v>=d.red;const[x0,y0]=P(100,100,M?70:77,a),[x1,y1]=P(100,100,85,a);
  e('line',{x1:x0,y1:y0,x2:x1,y2:y1,class:'tick'+(M?' major':'')+(r?' r':'')},s);
  if(M){const[tx,ty]=P(100,100,56,a);const t=e('text',{x:tx,y:ty+4,class:'num'+(r?' r':''),'text-anchor':'middle'},s);t.textContent=d.fmt?+(d.fmt(+v.toFixed(2))).toFixed(1):+v.toFixed(2)}}
 const g=e('g',{class:'needle',style:'transform-origin:100px 100px;transform:rotate('+ang(d.v)+'deg)'},s);
 e('path',{d:'M86 100 L180 98.6 L180 101.4 Z',class:'ndl'},g);
 e('circle',{cx:100,cy:100,r:o.hub||10,class:'hub'},s);
 const vt=e('text',{x:100,y:o.vy||146,class:'val','text-anchor':'middle'},s);vt.textContent=d.v.toLocaleString('en-US');
 const ut=e('text',{x:100,y:(o.vy||146)+14,class:'unit','text-anchor':'middle'},s);ut.textContent=d.unit;
 const lt=e('text',{x:100,y:(o.h||190)-4,class:'lbl','text-anchor':'middle'},s);lt.textContent=d.label;}
function spark(host,seed){const s=e('svg',{viewBox:'0 0 600 120',preserveAspectRatio:'none',class:'spark'},host);
 for(let i=1;i<4;i++)e('line',{x1:0,x2:600,y1:i*30,y2:i*30,class:'grid'},s);
 let pts=[],y=60;for(let x=0;x<=600;x+=6){y+=Math.sin(x*seed)*5+(Math.random()-.5)*6;y=Math.max(25,Math.min(95,y));pts.push(x+','+y.toFixed(1))}
 e('polyline',{points:pts.join(' '),class:'line'},s);}
`;

function page(name, title, css, opts) {
  const nav = NAV.map((n) => `<a class="nav${n === 'Live Data' ? ' on' : ''}">${n}</a>`).join('');
  const mods = MODULES.map(([a, b, s], i) => `<button class="mod${i === 0 ? ' on' : ''}"><span class="dot ${s}"></span><b>${a}</b><small>${b}</small></button>`).join('');
  const tiles = TILES.map(([l, v, u, r, s]) => `<div class="tile ${s}"><div class="tl">${l}</div><div class="tv">${v}<span>${u}</span></div><div class="tr">${s === 'high' ? '▲ high · ' : ''}normal ${r}</div></div>`).join('');
  const dialsData = JSON.stringify(DIALS, (k, v) => (typeof v === 'function' ? '__F__' : v)).replace(/"__F__"/g, 'v=>v/1000');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?${opts.fonts}&display=swap" rel="stylesheet">
<style>${css}</style></head><body class="${name}">
<header class="top">
  <div class="brand">${logo}<div class="prod"><b>Scan</b><small>BMW E46 diagnostics</small></div></div>
  <div class="car"><span class="carname">325i</span><span class="carspec">M54B25 · ZF 5HP19 · 2001</span></div>
  <div class="pills"><span class="pill ok"><i></i>Cable<em>FTDI · COM7</em></span><span class="pill ok"><i></i>Car<em>6 modules</em></span><button class="disc">Disconnect</button></div>
</header>
${opts.stripe ? '<div class="mstripe"><i></i><i></i><i></i></div>' : ''}
<div class="shell">
  <nav class="side">${nav}<div class="side-foot">Read-only mode<br><small>Coding & programming blocked</small></div></nav>
  <main>
    <div class="mods">${mods}</div>
    <section class="panel head"><div><h2>Live data · DME MS43</h2><p>Warm idle detected · 1.2 reads/s</p></div><div class="acts"><button class="b">Record CSV</button><button class="b pri">■ Stop</button></div></section>
    <section class="dials" id="dials"></section>
    <section class="tiles">${tiles}</section>
    <section class="panel chart"><div class="ch"><h3>Engine speed · last 60 s</h3><span class="leg">rpm</span></div><div id="sp"></div></section>
  </main>
</div>
<script>${GAUGE_JS}
const D=${dialsData};const O=${JSON.stringify(opts.dial)};
D.forEach(d=>{const w=document.createElement('div');w.className='dw';document.getElementById('dials').append(w);dial(w,d,O)});
spark(document.getElementById('sp'),.031);
</script></body></html>`;
}

// ---------- shared layout
const BASE = `
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;font:400 15px/1.4 var(--sans);color:var(--text);background:var(--bg);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer}
.top{display:flex;align-items:center;gap:24px;padding:14px 24px;background:var(--topbg);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:14px}.logo{height:30px;width:auto}
.prod{display:flex;flex-direction:column;border-left:1px solid var(--line);padding-left:14px;line-height:1.1}.prod b{font:600 18px var(--cond);letter-spacing:.08em;text-transform:uppercase}.prod small{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.car{display:flex;flex-direction:column;margin-left:auto;text-align:right;line-height:1.15}.carname{font:600 20px var(--cond)}.carspec{color:var(--muted);font-size:12px}
.pills{display:flex;gap:8px;align-items:center}
.pill{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:var(--rad);font-size:13px;font-weight:600;background:var(--panel)}
.pill i{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}.pill em{font-style:normal;color:var(--muted);font-weight:400}
.disc{height:34px;padding:0 14px;border:1px solid var(--line);border-radius:var(--rad);background:transparent}
.shell{display:grid;grid-template-columns:210px 1fr;min-height:calc(100vh - 64px)}
.side{display:flex;flex-direction:column;gap:2px;padding:18px 12px;border-right:1px solid var(--line);background:var(--sidebg)}
.nav{padding:10px 14px;border-radius:var(--rad);color:var(--muted);font-weight:500;cursor:pointer}.nav.on{color:var(--text);background:var(--navon)}
.side-foot{margin-top:auto;padding:12px 14px;font-size:12px;color:var(--muted);border-top:1px solid var(--line)}.side-foot small{color:var(--dim)}
main{padding:20px 24px 32px;display:flex;flex-direction:column;gap:16px;min-width:0}
.mods{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}
.mod{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:center;text-align:left;padding:8px 14px;border:1px solid var(--line);border-radius:var(--rad);background:var(--panel);min-width:130px}
.mod small{grid-column:2;color:var(--muted);font-size:11px}.mod b{font:600 14px var(--cond)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);grid-row:span 2}.dot.warn{background:var(--red)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radl);padding:16px 20px}
.head{display:flex;align-items:center;justify-content:space-between}.head h2{margin:0;font:600 22px var(--cond)}.head p{margin:2px 0 0;color:var(--muted);font-size:13px}
.acts{display:flex;gap:8px}.b{height:36px;padding:0 16px;border:1px solid var(--line);border-radius:var(--rad);background:var(--panel2);font-weight:600;font-size:13px}
.dials{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.dw{background:var(--dialbg);border:1px solid var(--line);border-radius:var(--radl);padding:14px 12px 8px}
.dial{width:100%;display:block}
.tiles{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--radl);padding:12px 14px}
.tl{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.tv{font:500 30px var(--valfont);color:var(--amber);margin:6px 0 2px;text-shadow:0 0 14px var(--glow)}.tv span{font:500 13px var(--sans);color:var(--muted);margin-left:4px;text-shadow:none}
.tr{font-size:11px;color:var(--dim)}.tile.high .tv{color:var(--red);text-shadow:0 0 14px rgba(255,70,70,.4)}.tile.high .tr{color:var(--red)}
.ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.ch h3{margin:0;font:600 15px var(--cond);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.leg{color:var(--amber);font-size:12px}
.spark{width:100%;height:120px;display:block}.spark .grid{stroke:var(--line);stroke-width:1}.spark .line{fill:none;stroke:var(--amber);stroke-width:2;vector-effect:non-scaling-stroke;filter:drop-shadow(0 0 4px var(--glow))}
.dial .arc{fill:none;stroke:var(--arc);stroke-width:2}.dial .ok{fill:none;stroke:var(--okband);stroke-width:3;stroke-linecap:round}.dial .red{fill:none;stroke:var(--red);stroke-width:4}
.dial .tick{stroke:var(--tick);stroke-width:1.2}.dial .tick.major{stroke-width:2.6}.dial .tick.r{stroke:var(--red)}
.dial .num{font:600 13px var(--cond);fill:var(--numcol)}.dial .num.r{fill:var(--red)}
.dial .ndl{fill:var(--needle);filter:drop-shadow(0 0 3px var(--needleglow))}.dial .hub{fill:var(--hub);stroke:var(--line);stroke-width:1}
.dial .val{font:500 28px var(--valfont);fill:var(--amber);filter:drop-shadow(0 0 6px var(--glow))}.dial .unit{font:500 11px var(--sans);fill:var(--muted);letter-spacing:.08em}
.dial .lbl{font:600 12px var(--sans);fill:var(--muted);letter-spacing:.08em;text-transform:uppercase}
@media (max-width:1100px){.tiles{grid-template-columns:repeat(3,1fr)}.dials{grid-template-columns:repeat(2,1fr)}}
@media (max-width:760px){.shell{grid-template-columns:1fr}.side{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 16px}.side-foot{display:none}.car{display:none}.top{flex-wrap:wrap;padding:12px 16px}.pills{margin-left:auto}main{padding:16px}.tiles{grid-template-columns:repeat(2,1fr)}.pill em{display:none}}
`;

// ---------- A: Night cluster — the E46 instrument cluster at night: black faces, orange-red lighting, red needles, chrome rings
const A = `:root{--bg:#07080a;--topbg:linear-gradient(#111317,#0a0b0d);--sidebg:#0a0b0e;--panel:#0f1114;--panel2:#16191d;--line:#22262c;--text:#eceae6;--muted:#8d8a86;--dim:#5a5856;
--amber:#ff7a1a;--glow:rgba(255,110,20,.55);--red:#ff3b30;--green:#3be08a;--rad:6px;--radl:12px;--navon:linear-gradient(90deg,rgba(255,122,26,.16),transparent);
--sans:'Barlow',sans-serif;--cond:'Barlow Semi Condensed',sans-serif;--valfont:'Barlow Semi Condensed',sans-serif;
--dialbg:radial-gradient(circle at 50% 45%,#141619,#08090b 70%);--arc:#3a2a1e;--okband:rgba(255,122,26,.35);--tick:#ff8a33;--numcol:#ff9a4d;--needle:#ff2a1a;--needleglow:rgba(255,40,20,.8);--hub:#1b1d20}
body{background:radial-gradient(1000px 500px at 50% -180px,#1a1410,transparent 70%),#07080a}
.nav.on{box-shadow:inset 2px 0 0 var(--amber)}
.dial .bezel{fill:url(#none);fill:#1d2024;stroke:#5d6066;stroke-width:3}.dial .face{fill:#050506}
.dw{border-color:#1b1e22;box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 8px 24px rgba(0,0,0,.5)}
.tile{background:linear-gradient(#111317,#0c0e10)}
.b.pri{background:var(--amber);border-color:var(--amber);color:#160800}
.dial .bezel{stroke:url(#chrome)}
`;
// ---------- B: M Sport — graphite & carbon, M tricolour stripe (same blues/red as the logo), white numerals, amber values
const B = `:root{--bg:#121417;--topbg:#0d0f12;--sidebg:#0f1114;--panel:#1a1d21;--panel2:#23272c;--line:#2b3036;--text:#f2f3f5;--muted:#9aa1aa;--dim:#646b74;
--amber:#ffa033;--glow:rgba(255,160,51,.4);--red:#e22619;--green:#41d38a;--rad:4px;--radl:6px;--navon:#1d2126;
--sans:'Titillium Web',sans-serif;--cond:'Titillium Web',sans-serif;--valfont:'Titillium Web',sans-serif;
--dialbg:#16191c;--arc:#4a5058;--okband:#4290f6;--tick:#e9ecef;--numcol:#f2f3f5;--needle:#ffa033;--needleglow:rgba(255,160,51,.6);--hub:#2b3036}
body{background-color:#121417;background-image:linear-gradient(45deg,rgba(255,255,255,.018) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.018) 75%),linear-gradient(45deg,rgba(255,255,255,.018) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.018) 75%);background-size:8px 8px;background-position:0 0,4px 4px}
.mstripe{display:flex;height:4px}.mstripe i{flex:1}.mstripe i:nth-child(1){background:#4290f6}.mstripe i:nth-child(2){background:#023d79}.mstripe i:nth-child(3){background:#e22619}
.nav{text-transform:uppercase;letter-spacing:.08em;font-size:13px;font-weight:600}.nav.on{border-left:3px solid #4290f6;border-radius:0;background:linear-gradient(90deg,rgba(66,144,246,.14),transparent)}
.head h2,.prod b{font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.dial .bezel{fill:#2a2e33;stroke:#3c4249;stroke-width:1}.dial .face{fill:#0e1012}
.dw{position:relative;overflow:hidden}.dw::before{content:'';position:absolute;left:0;top:0;right:0;height:3px;background:linear-gradient(90deg,#4290f6 33%,#023d79 33% 66%,#e22619 66%)}
.tile{border-left:3px solid #4290f6}.tile.high{border-left-color:#e22619}
.tv{font-weight:600}.b.pri{background:#e22619;border-color:#e22619;color:#fff}
.mod.on{border-color:#4290f6;box-shadow:0 0 0 1px #4290f6 inset}
`;
// ---------- C: Estoril & OBC — titanium-silver trim, Estoril-blue night, values in the amber dot-matrix of the E46 on-board computer
const C = `:root{--bg:#0b1220;--topbg:linear-gradient(180deg,#c9ced4,#9aa1a9);--sidebg:#0d1626;--panel:#111b2e;--panel2:#18243b;--line:#22314d;--text:#e6ebf3;--muted:#8d9bb3;--dim:#5b6a85;
--amber:#ff9a2e;--glow:rgba(255,154,46,.55);--red:#ff5147;--green:#43d98f;--rad:8px;--radl:14px;--navon:rgba(66,144,246,.14);
--sans:'Barlow',sans-serif;--cond:'Barlow Semi Condensed',sans-serif;--valfont:'VT323',monospace;
--dialbg:linear-gradient(#0f192b,#0a1220);--arc:#2c3d5c;--okband:rgba(66,144,246,.55);--tick:#b9c4d6;--numcol:#cfd8e6;--needle:#ff6a2a;--needleglow:rgba(255,106,42,.6);--hub:#c9ced4}
body{background:radial-gradient(900px 500px at 80% -200px,#1b3566,transparent 70%),#0b1220}
.top{color:#141a22;border-bottom:1px solid #6d747c;box-shadow:inset 0 1px 0 #eef1f4,0 4px 18px rgba(0,0,0,.5)}
.top .prod,.top .carspec,.top .prod small{color:#3c444e;border-color:#7d858e}.top .logo .st1{fill:#4a4f55}
.top .pill{background:#0b1220;color:#e6ebf3;border-color:#0b1220}.top .disc{border-color:#5d656e;color:#141a22}
.tv{font-size:40px;font-weight:400;line-height:.9;letter-spacing:.02em}
.dial .val{font-size:36px}
.tile{position:relative;background:linear-gradient(#121d31,#0e1828)}
.tv{background:#1a0e04;background:linear-gradient(#170c03,#0f0802);border:1px solid #2a1a0a;border-radius:4px;padding:4px 8px 2px;display:inline-block;box-shadow:inset 0 0 12px rgba(0,0,0,.8)}
.dial .bezel{fill:#aab1b9;stroke:#e1e5ea;stroke-width:1}.dial .face{fill:#0a1220}
.nav.on{color:#fff;box-shadow:inset 3px 0 0 #4290f6}
.b.pri{background:#4290f6;border-color:#4290f6;color:#fff}
.mod.on{background:linear-gradient(#c9ced4,#a7aeb6);color:#141a22;border-color:#c9ced4}.mod.on small{color:#3c444e}
`;

const chromeDefs = `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dde2"/><stop offset=".5" stop-color="#4c5056"/><stop offset="1" stop-color="#a9adb3"/></linearGradient></defs></svg>`;

const designs = [
  ['a-night-cluster', 'Proposta A · Night Cluster', A, { fonts: 'family=Barlow:wght@400;500;600&family=Barlow+Semi+Condensed:wght@500;600', dial: { sweep: 240, start: 150, vy: 170, h: 222 } }],
  ['b-m-sport', 'Proposta B · M Sport', B, { stripe: true, fonts: 'family=Titillium+Web:wght@400;600;700', dial: { sweep: 270, start: 135, vy: 170, h: 222, hub: 7 } }],
  ['c-estoril-obc', 'Proposta C · Estoril & OBC', C, { fonts: 'family=Barlow:wght@400;500;600&family=Barlow+Semi+Condensed:wght@500;600&family=VT323', dial: { sweep: 240, start: 150, vy: 170, h: 222, hub: 9 } }],
];
for (const [file, title, css, opts] of designs) {
  let html = page(file, title, BASE + css, opts);
  if (file.startsWith('a')) html = html.replace('<header', chromeDefs + '<header');
  writeFileSync(`${dir}${file}.html`, html);
  console.log('wrote', file);
}
