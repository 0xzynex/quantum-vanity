import { difficulty, validate, words, matchSpans } from '../src/pattern.js';
import { Grover } from '../src/grover.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || !Number.isFinite(n) ? '∞' : Math.round(n).toLocaleString('en-US'));
const dur = (s) => {
  if (s == null || !Number.isFinite(s)) return 'forever';
  if (s < 1) return '< 1 s';
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  if (s < 86400 * 365) return `${(s / 86400).toFixed(1)} days`;
  return `${(s / 86400 / 365).toFixed(1)} years`;
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const INK = '#152238', INK2 = '#4b5a73', GRID = '#c3cfdc', MARKER = '#ffe03d', PENCIL = '#c0352d', PEN = '#2350b8';

// ---------------- classical search ----------------
const WHERE_TEXT = { prefix: 'starts with', suffix: 'ends with', contains: 'contains' };
const opts = () => {
  const where = $('where').value;
  const patterns = [...document.querySelectorAll('#pretty input:checked')].map((i) => i.value);
  return { prefix: '', suffix: '', contains: '', [where]: $('words').value, ignoreCase: $('ic').checked, patterns, where };
};
let running = false, lastRate = 0, runOpts = null;

function describe(o) {
  const list = words(o[o.where]);
  const joined = list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
  return `${WHERE_TEXT[o.where]} ${joined}`;
}

function refreshOdds() {
  const o = opts();
  if (!words(o[o.where]).length) {
    $('words').classList.remove('bad');
    $('err').textContent = '';
    $('odds').textContent = 'Type a word to see the odds.';
    $('naive').textContent = '';
    setVs(null);
    return;
  }
  const errors = validate(o);
  $('words').classList.toggle('bad', errors.length > 0);
  $('err').textContent = errors[0] ? errors[0].charAt(0).toUpperCase() + errors[0].slice(1) + '.' : '';
  if (errors.length) { $('odds').textContent = '—'; $('naive').textContent = ''; setVs(null); return; }
  const d = difficulty(o);
  $('odds').innerHTML = `${d.approximate ? 'About one' : 'One'} key in <b>${fmt(d.classical)}</b> ${esc(describe(o))}${o.ignoreCase ? ', in any case' : ''}.`;
  const ratio = d.classical / d.naive;
  if (o.where === 'contains') {
    $('naive').textContent = 'A word can sit anywhere in the 44 characters, so this is much easier than starts with or ends with.';
  } else if (ratio > 1.5) {
    $('naive').innerHTML = `Simple 1-in-58 math says ${fmt(d.naive)}. Solana addresses rarely start with late letters, so this one is <b>${ratio.toFixed(0)}× rarer</b> than most calculators claim.`;
  } else if (ratio < 0.67) {
    $('naive').innerHTML = `Simple 1-in-58 math says ${fmt(d.naive)}. Early letters are common first characters, so this one is <b>${(1 / ratio).toFixed(1)}× easier</b> than most calculators claim.`;
  } else {
    $('naive').textContent = 'Every character here really is a 1-in-58 chance, so simple calculators get this one right.';
  }
  setVs(d);
  if (!running && lastRate > 0) $('tExpected').textContent = dur(d.classical / lastRate);
}

function setVs(d) {
  $('vC').textContent = d ? `${fmt(d.classical)} tries` : '—';
  $('vG').textContent = d ? `${fmt(d.grover)} queries` : '—';
  $('vX').innerHTML = d ? `That is <b>${fmt(d.speedup)} times fewer</b> steps: the square root of the work, times π/4.` : '';
  $('vQ').textContent = d
    ? `It would need about ${Math.max(1, Math.ceil(Math.log2(d.classical)))} qubits to hold every candidate, plus a full ed25519 and base58 circuit as the oracle.`
    : '';
}

const fitWords = () => { $('words').style.width = `${Math.min(28, Math.max(5, $('words').value.length + 1))}ch`; };
$('words').addEventListener('input', fitWords);
fitWords();
['where', 'words', 'ic'].forEach((id) => $(id).addEventListener('input', refreshOdds));

function setRunning(on) {
  running = on;
  $('go').textContent = on ? 'Stop search' : 'Start search';
  $('go').className = on ? 'stop' : '';
  ['where', 'words', 'ic', 'threads', 'count'].forEach((id) => ($(id).disabled = on));
  document.querySelectorAll('#pretty input').forEach((i) => (i.disabled = on));
}

$('go').onclick = async () => {
  if (running) { await fetch('/api/stop', { method: 'POST' }); return; }
  const o = opts();
  if (validate(o).length) return;
  runOpts = o;
  $('found').innerHTML = `<p class="none">Searching for addresses that ${esc(describe(o))}. Each one appears here as soon as it is found.</p>`;
  $('luckyList').innerHTML = '';
  $('keptList').innerHTML = '';
  $('keptBox').hidden = true;
  lastPushed = '';
  $('luckyBox').hidden = !o.patterns.length;
  if (o.patterns.length) $('luckyList').innerHTML = '<p class="none">Nothing yet. Pretty ones show up here as soon as one passes by.</p>';
  lines = [];
  const r = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...o, threads: $('threads').value, count: $('count').value }),
  });
  const j = await r.json();
  if (!r.ok) { $('err').textContent = (j.errors || [j.error]).join(' '); return; }
  setRunning(true);
};

function highlightSpans(a, spans) {
  let out = '', at = 0;
  for (const [i, j] of spans) {
    if (i < at) continue;
    out += esc(a.slice(at, i)) + `<mark>${esc(a.slice(i, j))}</mark>`;
    at = j;
  }
  return out + esc(a.slice(at));
}

// While searching, highlight where the word would have to be.
function slotSpans(a, o) {
  const list = words(o[o.where]);
  const n = list.length ? Math.min(...list.map((w) => w.length)) : 1;
  if (o.where === 'prefix') return [[0, n]];
  if (o.where === 'suffix') return [[a.length - n, a.length]];
  return [];
}

let lines = [], paused = false, lastPushed = '';
const HINT = $('tickhint').textContent;
function pushSample(addr, spans, cls = '') {
  if (!addr || !runOpts || paused || addr === lastPushed) return;
  lastPushed = addr;
  const sp = spans || slotSpans(addr, runOpts);
  const attr = cls ? `class="${cls}"` : `data-a="${esc(addr)}" title="Click to keep this wallet"`;
  lines.unshift(`<div ${attr}>${highlightSpans(addr, sp)}</div>`);
  lines.length = Math.min(lines.length, 7);
  $('stream').innerHTML = lines.join('');
}
$('stream').addEventListener('mouseenter', () => {
  if (!lines.length) return;
  paused = true;
  $('stream').classList.add('paused');
  $('tickhint').classList.add('paused');
  $('tickhint').textContent = 'Paused. Click an address to keep it. The search keeps running in the background.';
});
$('stream').addEventListener('mouseleave', () => {
  paused = false;
  $('stream').classList.remove('paused');
  $('tickhint').classList.remove('paused');
  $('tickhint').textContent = HINT;
});
async function keepAddress(address, row) {
  const r = await fetch('/api/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
  const j = await r.json();
  if (!r.ok) { $('tickhint').textContent = j.error; return; }
  row.classList.add('kept');
  $('keptBox').hidden = false;
  if ($('keptList').querySelector(`[data-k="${CSS.escape(address)}"]`)) return;
  const el = document.createElement('div');
  el.className = 'hit';
  el.dataset.k = address;
  el.innerHTML = `<div class="addr">${esc(address)}</div><p>Kept. Saved to <code>${esc(j.file)}</code>.</p>`;
  $('keptList').prepend(el);
  $('tickhint').textContent = `Kept ${address.slice(0, 6)}… Click more, or move the mouse away to continue.`;
}
$('stream').addEventListener('click', (e) => {
  const row = e.target.closest('[data-a]');
  if (row) keepAddress(row.dataset.a, row);
});

let missedTimer;
$('missed').addEventListener('input', () => {
  clearTimeout(missedTimer);
  missedTimer = setTimeout(async () => {
    const q = $('missed').value.trim();
    if (!q) { $('missedList').innerHTML = ''; return; }
    const { addresses } = await (await fetch('/api/recent?q=' + encodeURIComponent(q))).json();
    if (!addresses.length) {
      $('missedList').innerHTML = `<p>Not in the last few minutes of the ticker. You can search for <b>${esc(q)}</b> with the box above to get a fresh one.</p>`;
      return;
    }
    $('missedList').innerHTML = addresses.map((a) => {
      const i = a.toLowerCase().indexOf(q.toLowerCase());
      return `<div data-m="${esc(a)}" title="Click to keep">${highlightSpans(a, [[i, i + q.length]])}</div>`;
    }).join('') + '<p>Click one to keep it.</p>';
  }, 200);
});
$('missedList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-m]');
  if (row) keepAddress(row.dataset.m, row);
});

function showStats(s) {
  lastRate = s.rate;
  $('tTries').textContent = fmt(s.tries);
  $('tRate').textContent = fmt(s.rate);
  $('tElapsed').textContent = dur(s.seconds);
  $('tExpected').textContent = dur(s.expectedSeconds);
  $('chance').textContent = `${(s.chance * 100).toFixed(s.chance < 0.1 ? 1 : 0)}%`;
  $('chanceBar').style.width = `${(s.chance * 100).toFixed(2)}%`;
}

function hitCard(h, spans, tag) {
  const el = document.createElement('div');
  el.className = 'hit';
  el.innerHTML = `<div class="addr">${highlightSpans(h.address, spans)}${tag ? `<span class="why">${esc(tag)}</span>` : ''}</div>` +
    `<p>Saved to <code>${esc(h.file)}</code> after ${fmt(h.tries)} keys (${dur(h.seconds)}).</p>`;
  return el;
}

function addHit(h) {
  if ($('found').querySelector('.none')) $('found').innerHTML = '';
  const spans = matchSpans(h.address, runOpts || opts());
  $('found').prepend(hitCard(h, spans));
  pushSample(h.address, spans, 'match');
}

function addLucky(h) {
  if ($('luckyList').querySelector('.none')) $('luckyList').innerHTML = '';
  const spans = h.span ? [h.span] : [];
  $('luckyList').prepend(hitCard(h, spans, h.why));
  pushSample(h.address, spans, 'match');
}

const es = new EventSource('/api/events');
es.addEventListener('progress', (e) => { const s = JSON.parse(e.data); showStats(s); pushSample(s.sample); });
es.addEventListener('found', (e) => addHit(JSON.parse(e.data)));
es.addEventListener('lucky', (e) => addLucky(JSON.parse(e.data)));
es.addEventListener('stop', (e) => {
  const s = JSON.parse(e.data);
  showStats(s);
  pushSample(s.sample);
  setRunning(false);
  if (!lines.length) $('stream').innerHTML = `<div class="idle">Done in ${dur(s.seconds)}: ${fmt(s.tries)} keys tried, ${s.found} match${s.found === 1 ? '' : 'es'} found. The matches are below.</div>`;
});

fetch('/api/info').then((r) => r.json()).then((info) => {
  for (let t = 1; t <= info.cores; t++) {
    const o = document.createElement('option');
    o.value = o.textContent = t;
    if (t === info.threads) o.selected = true;
    $('threads').appendChild(o);
  }
  if (info.running) {
    setRunning(true);
    if (info.stats) { runOpts = { ...info.stats, where: info.stats.contains ? 'contains' : info.stats.suffix ? 'suffix' : 'prefix' }; showStats(info.stats); }
  }
});

refreshOdds();

// ---------------- Grover figure ----------------
function canvas(id, h) {
  const c = $(id), dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth || c.parentElement.clientWidth;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px';
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
let A, K;
const layout = () => { A = canvas('amps', 250); K = canvas('curve', 150); };
layout();
addEventListener('resize', layout);

let g, marked, from, to, phase, t0, playing = true, pausedAt = 0;
const DUR = { superpose: 900, oracle: 450, diffuse: 550, measure: 1900 };
const FONT = (s, w = 400) => `${w} ${s}px "Plex Sans", system-ui, sans-serif`;
const MONO = (s) => `500 ${s}px "Plex Mono", ui-monospace, monospace`;

function resetGrover() {
  const n = parseInt($('qubits').value, 10);
  $('qOut').textContent = n;
  marked = Math.floor((1 << n) * 0.618);
  g = new Grover(n, [marked]);
  from = new Float64Array(g.N);
  to = Float64Array.from(g.amps);
  phase = 'superpose';
  t0 = performance.now();
}
$('qubits').addEventListener('input', resetGrover);
$('gPlay').onclick = () => {
  playing = !playing;
  $('gPlay').textContent = playing ? 'Pause' : 'Play';
  t0 = performance.now() - pausedAt;
};

function advance() {
  from = Float64Array.from(to);
  if (phase === 'superpose' || phase === 'diffuse') {
    if (g.k >= g.optimal) phase = 'measure';
    else { g.oracle(); phase = 'oracle'; }
  } else if (phase === 'oracle') {
    g.diffuse(); g.k++; phase = 'diffuse';
  } else {
    resetGrover();
    return;
  }
  to = Float64Array.from(g.amps);
}

function drawAmps(cur, u) {
  const { ctx, w, h } = A;
  ctx.clearRect(0, 0, w, h);
  const left = 30, zero = h / 2, scale = zero - 14;
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const v of [1, 0.5, -0.5, -1]) {
    ctx.beginPath(); ctx.moveTo(left, zero - v * scale); ctx.lineTo(w, zero - v * scale); ctx.stroke();
  }
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(left, zero); ctx.lineTo(w, zero); ctx.stroke();
  ctx.fillStyle = INK2; ctx.font = MONO(11); ctx.textAlign = 'right';
  ctx.fillText('+1', left - 6, zero - scale + 4); ctx.fillText('0', left - 6, zero + 4); ctx.fillText('−1', left - 6, zero + scale + 4);
  ctx.textAlign = 'left';

  const N = cur.length, bw = (w - left - 4) / N;
  for (let i = 0; i < N; i++) {
    if (i === marked) continue;
    const a = cur[i], hh = Math.abs(a) * scale;
    ctx.fillStyle = a < 0 ? PENCIL : INK;
    ctx.fillRect(left + 2 + i * bw, a >= 0 ? zero - hh : zero, Math.max(bw - (N <= 64 ? 1.5 : 0), 0.8), Math.max(hh, 0.8));
  }
  // the marked answer: highlighter fill, ink outline
  const a = cur[marked], hh = Math.abs(a) * scale, mx = left + 2 + marked * bw, mw = Math.max(bw, 7);
  ctx.fillStyle = MARKER; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.fillRect(mx - (mw - bw) / 2, a >= 0 ? zero - hh : zero, mw, Math.max(hh, 2));
  ctx.strokeRect(mx - (mw - bw) / 2, a >= 0 ? zero - hh : zero, mw, Math.max(hh, 2));

  if (phase === 'oracle' || phase === 'diffuse') {
    let mean = 0; for (let i = 0; i < N; i++) mean += cur[i]; mean /= N;
    ctx.strokeStyle = PEN; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(left, zero - mean * scale); ctx.lineTo(w, zero - mean * scale); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PEN; ctx.font = FONT(12, 500); ctx.fillText('mean', w - 40, zero - mean * scale - 6);
  }
  ctx.fillStyle = INK; ctx.font = FONT(13, 500); ctx.textAlign = 'center';
  const lx = Math.min(Math.max(mx, 120), w - 120);
  const ket = `|${marked.toString(2).padStart(g.n, '0')}⟩`;
  ctx.fillText(phase === 'measure' ? `Measured ${ket}: ${(g.pMarked() * 100).toFixed(1)}% likely` : `the answer ${ket}`, lx, h - 4);
  ctx.textAlign = 'left';
}

function drawCurve() {
  const { ctx, w, h } = K;
  ctx.clearRect(0, 0, w, h);
  const opt = g.optimal, kmax = Math.max(4, Math.ceil(opt * 1.35));
  const X = (k) => 38 + (k / kmax) * (w - 50), Y = (p) => h - 26 - p * (h - 48);
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((p) => { ctx.beginPath(); ctx.moveTo(38, Y(p)); ctx.lineTo(w - 6, Y(p)); ctx.stroke(); });
  ctx.fillStyle = INK2; ctx.font = MONO(11); ctx.textAlign = 'right';
  ctx.fillText('100%', 34, Y(1) + 4); ctx.fillText('0%', 34, Y(0) + 4);
  ctx.textAlign = 'left'; ctx.font = FONT(13);
  ctx.fillText('Chance the answer is measured, by round', 40, 14);
  ctx.strokeStyle = PEN; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= 200; i++) { const k = (i / 200) * kmax; const p = Grover.theory(k, g.N); i ? ctx.lineTo(X(k), Y(p)) : ctx.moveTo(X(k), Y(p)); }
  ctx.stroke(); ctx.lineWidth = 1;
  ctx.strokeStyle = INK; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(X(opt), Y(0)); ctx.lineTo(X(opt), Y(1)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = INK; ctx.font = FONT(12, 500);
  ctx.fillText(`best stop: round ${opt}`, Math.min(X(opt) + 6, w - 120), Y(0.1));
  ctx.fillStyle = INK2; ctx.font = FONT(12); ctx.textAlign = 'right';
  ctx.fillText(`checking one by one: ~${fmt(g.N / 2)} looks`, w - 6, h - 6); ctx.textAlign = 'left';
  ctx.fillStyle = MARKER; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X(g.k), Y(g.pMarked()), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

function frame(now) {
  if (playing) {
    let u = (now - t0) / DUR[phase];
    while (u >= 1) { t0 += DUR[phase]; advance(); u = (now - t0) / DUR[phase]; }
    pausedAt = now - t0;
    const e = Math.max(0, Math.min(1, u)), ease = e * e * (3 - 2 * e);
    const cur = new Float64Array(g.N);
    for (let i = 0; i < g.N; i++) cur[i] = from[i] + (to[i] - from[i]) * ease;
    drawAmps(cur, e);
  }
  const names = ['superpose', 'oracle', 'diffuse', 'measure'];
  document.querySelectorAll('#stage span').forEach((el, i) => el.classList.toggle('on', names[i] === phase));
  $('gk').textContent = `round ${g.k} of ${g.optimal}`;
  drawCurve();
  requestAnimationFrame(frame);
}

document.fonts.ready.then(() => { layout(); });
resetGrover();
requestAnimationFrame(frame);
