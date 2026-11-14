import snApi from 'sn-extension-api';
import { getStroke } from 'perfect-freehand';
import { recognize } from './shapes.js';
import 'sn-extension-api/dist/sn.min.css';
import './style.css';

// ---------- constants ----------
const FORMAT = 'sn-ink';
const PAGE_W = 1000;            // logical page width; scaled to screen width
const COLORS = ['#1a1a1a', '#1f5fd6', '#d23b3b', '#2e9b4f'];
const SIZES = { pen: 3.2, eraser: 14 };

// ---------- state ----------
const state = {
  strokes: [],        // {c, s, p:[[x,y,pr],...]}
  redo: [],
  tool: 'pen',
  color: COLORS[0],
  scrollY: 0,
  scale: 1,
  drawing: null,
  blocked: false,     // note holds non-ink text: don't overwrite
  inSN: window.parent !== window,
  diag: { types: new Set(), pMin: 1, pMax: 0, coalesced: 'getCoalescedEvents' in PointerEvent.prototype, events: 0 },
};
const pathCache = new WeakMap();
let lastLoaded = null; // last note text we loaded or saved (to ignore echoes)

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const wrap = $('#wrap');
const dry = $('#dry');
const wet = $('#wet');
const dctx = dry.getContext('2d');
const wctx = wet.getContext('2d');

// ---------- geometry ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  for (const c of [dry, wet]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }
  state.scale = w / PAGE_W;
  state.dpr = dpr;
  redrawDry();
}
function toPage(e) {
  const r = wet.getBoundingClientRect();
  return [(e.clientX - r.left) / state.scale, (e.clientY - r.top) / state.scale + state.scrollY];
}
function contentBottom() {
  let max = 0;
  for (const s of state.strokes) for (const p of s.p) if (p[1] > max) max = p[1];
  return max;
}

// ---------- rendering ----------
function strokePath(s) {
  let path = pathCache.get(s);
  if (path) return path;
  const pts = getStroke(s.p, {
    size: s.s * 2.2,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: s.sim === 1,
    last: true,
  });
  path = new Path2D();
  if (pts.length) {
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
  }
  pathCache.set(s, path);
  return path;
}
function applyView(ctx) {
  const k = state.scale * state.dpr;
  ctx.setTransform(k, 0, 0, k, 0, -state.scrollY * k);
}
function drawRuling(ctx) {
  const top = state.scrollY, bottom = top + wrap.clientHeight / state.scale;
  ctx.strokeStyle = 'rgba(120,140,170,0.18)';
  ctx.lineWidth = 1 / state.scale;
  ctx.beginPath();
  for (let y = Math.ceil(top / 40) * 40; y < bottom; y += 40) {
    ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y);
  }
  ctx.stroke();
}
function redrawDry() {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dry.width, dry.height);
  applyView(dctx);
  drawRuling(dctx);
  const top = state.scrollY - 50, bottom = state.scrollY + wrap.clientHeight / state.scale + 50;
  for (const s of state.strokes) {
    if (s.maxY !== undefined && (s.maxY < top || s.minY > bottom)) continue;
    dctx.fillStyle = s.c;
    dctx.fill(strokePath(s));
  }
}
function drawWet() {
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, wet.width, wet.height);
  if (!state.drawing) return;
  applyView(wctx);
  pathCache.delete(state.drawing);
  wctx.fillStyle = state.drawing.c;
  wctx.fill(strokePath(state.drawing));
}
let rafPending = false;
function scheduleWet() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; drawWet(); });
}
function bounds(s) {
  let a = Infinity, b = -Infinity;
  for (const p of s.p) { if (p[1] < a) a = p[1]; if (p[1] > b) b = p[1]; }
  s.minY = a; s.maxY = b;
}

function isLocked() {
  if (!state.inSN) return false;
  try { return !!snApi.locked; } catch { return false; }
}

// Remove the doubled-back points older versions recorded on iPad (Safari re-sent coalesced points).
function cleanStroke(s) {
  const out = [];
  const recent = [];
  for (const q of s.p) {
    const key = q[0] + ',' + q[1] + ',' + q[2];
    if (recent.includes(key)) continue;
    recent.push(key); if (recent.length > 8) recent.shift();
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev[0] - q[0], prev[1] - q[1]) < 0.05) { prev[2] = q[2] || prev[2]; continue; }
    out.push([q[0], q[1], q[2] > 0 ? q[2] : (prev ? prev[2] : 0.5)]);
  }
  s.p = out.length ? out : s.p;
  return s;
}

// ---------- persistence ----------
function serialize() {
  return JSON.stringify({
    format: FORMAT, v: 1,
    strokes: state.strokes.map((s) => ({
      c: s.c, s: s.s, ...(s.sim ? { sim: 1 } : {}), ...(s.t ? { t: s.t } : {}),
      p: s.p.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100]),
    })),
  });
}
function load(text) {
  state.redo = [];
  if (!text || !text.trim()) { state.strokes = []; state.blocked = false; }
  else {
    try {
      const d = JSON.parse(text);
      if (d.format !== FORMAT) throw new Error('not ink');
      state.strokes = (d.strokes || []).map(cleanStroke);
      state.strokes.forEach(bounds);
      state.blocked = false;
    } catch {
      state.blocked = true;
    }
  }
  $('#blocked').hidden = !state.blocked;
  redrawDry();
}
function save() {
  if (state.blocked) return;
  const n = state.strokes.length;
  if (state.inSN) {
    try {
      snApi.preview = n ? `✍️ Handwritten note · ${n} stroke${n === 1 ? '' : 's'}` : '✍️ Empty handwritten note';
      const text = serialize();
      lastLoaded = text;
      snApi.text = text;
    } catch (e) { log('Save failed: ' + e.message); }
  }
}

// ---------- input ----------
// Pointer events give the best Pencil data (240 Hz via coalesced events), but inside the
// Standard Notes iPad app iPadOS can cancel them mid-stroke. When that happens we keep the
// stroke going from the stylus's touch events instead, so strokes never break into dots.
let fingerScroll = null;
let holdTimer = null;
const hasTouch = 'ontouchstart' in window;

function startStroke(x, y, pressure, id, viaTouch, sim) {
  if (state.blocked || isLocked()) return;
  const pt = toPage({ clientX: x, clientY: y });
  if (state.tool === 'eraser') {
    state.drawing = { erasing: true, id, viaTouch, removed: [] };
    eraseAt(pt);
    return;
  }
  state.drawing = { c: state.color, s: SIZES.pen, sim, t: Date.now(), id, viaTouch, p: [[pt[0], pt[1], pressure]] };
  state.drawing.hold = pt;
  armHold();
  scheduleWet();
}
function addPoint(x, y, pressure) {
  const d = state.drawing;
  const pt = toPage({ clientX: x, clientY: y });
  state.diag.events++;
  if (pressure > 0 && pressure !== 0.5) {
    state.diag.pMin = Math.min(state.diag.pMin, pressure);
    state.diag.pMax = Math.max(state.diag.pMax, pressure);
  }
  if (d.erasing) { eraseAt(pt); return; }
  if (d.snapped) return;
  const prev = d.p[d.p.length - 1];
  const pr = pressure > 0 ? pressure : (prev ? prev[2] : 0.5);
  if (prev && Math.abs(prev[0] - pt[0]) < 0.05 && Math.abs(prev[1] - pt[1]) < 0.05) { prev[2] = pr; return; }
  d.p.push([pt[0], pt[1], pr]);
  if (Math.hypot(pt[0] - d.hold[0], pt[1] - d.hold[1]) > 4) { d.hold = pt; armHold(); }
}
function armHold() {
  clearTimeout(holdTimer);
  if (!$('#shapes').checked) return;
  const d = state.drawing;
  holdTimer = setTimeout(() => {
    if (state.drawing !== d || d.erasing || d.snapped) return;
    const r = recognize(d.p);
    if (!r) return;
    d.p = r.pts; d.sim = 0; d.snapped = true; d.shape = r.kind;
    state.diag.shapes = (state.diag.shapes || 0) + 1;
    scheduleWet();
  }, 550);
}
function finishStroke() {
  clearTimeout(holdTimer);
  const d = state.drawing;
  if (!d) return;
  state.drawing = null;
  if (d.erasing) {
    if (d.removed.length) { state.redo = []; pushHistory({ type: 'erase', strokes: d.removed }); save(); }
  } else if (d.p.length) {
    delete d.id; delete d.viaTouch; delete d.hold; delete d.snapped; delete d.touchId; delete d.fromTouch; delete d.lastTs; delete d.seen;
    bounds(d);
    pathCache.delete(d);
    state.strokes.push(d);
    state.redo = [];
    pushHistory({ type: 'add', stroke: d });
    redrawDry();
    save();
  }
  drawWet();
  updateDiag();
}

// --- pointer events (Pencil, mouse; finger only when "Finger draws" is on) ---
wet.addEventListener('pointerdown', (e) => {
  state.diag.types.add(e.pointerType);
  if (e.pointerType === 'touch' && !$('#finger').checked) {
    if (!hasTouch) fingerScroll = { y: e.clientY, start: state.scrollY, id: e.pointerId };
    return;
  }
  e.preventDefault();
  try { wet.setPointerCapture(e.pointerId); } catch {}
  const d = state.drawing;
  if (d && d.fromTouch && d.p && d.p.length < 4) { d.id = e.pointerId; d.viaTouch = false; d.fromTouch = false; return; } // touch beat us to it
  if (d) return;
  const sim = e.pointerType !== 'pen' || e.pressure === 0 || e.pressure === 0.5 ? 1 : 0;
  startStroke(e.clientX, e.clientY, e.pressure || 0.5, e.pointerId, false, sim);
});
wet.addEventListener('pointermove', (e) => {
  if (fingerScroll && fingerScroll.id === e.pointerId) {
    state.scrollY = Math.max(0, fingerScroll.start - (e.clientY - fingerScroll.y) / state.scale);
    redrawDry();
    return;
  }
  const d = state.drawing;
  if (!d || d.viaTouch || d.id !== e.pointerId) return;
  e.preventDefault();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  // iPad Safari re-delivers coalesced points it already sent; only take ones newer than the last.
  // Two checks, since Safari's timestamps on re-sent points aren't reliable: drop anything older
  // than the last point we took, and anything identical to one of the last 16 raw points.
  if (!d.seen) d.seen = [];
  for (const ev of evs.length ? evs : [e]) {
    const key = ev.clientX + ',' + ev.clientY + ',' + ev.pressure;
    if ((d.lastTs !== undefined && ev.timeStamp < d.lastTs) || d.seen.includes(key)) {
      state.diag.dupes = (state.diag.dupes || 0) + 1; continue;
    }
    d.lastTs = ev.timeStamp;
    d.seen.push(key); if (d.seen.length > 16) d.seen.shift();
    addPoint(ev.clientX, ev.clientY, ev.pressure);
  }
  if (!d.erasing) scheduleWet();
});
wet.addEventListener('pointerup', (e) => {
  if (fingerScroll && fingerScroll.id === e.pointerId) { fingerScroll = null; return; }
  const d = state.drawing;
  if (d && !d.viaTouch && d.id === e.pointerId) finishStroke();
});
wet.addEventListener('pointercancel', (e) => {
  if (fingerScroll && fingerScroll.id === e.pointerId) { fingerScroll = null; return; }
  const d = state.drawing;
  if (!d || d.viaTouch || d.id !== e.pointerId) return;
  state.diag.cancels = (state.diag.cancels || 0) + 1;
  if (hasTouch) d.viaTouch = true;   // keep going on touch events
  else finishStroke();
  updateDiag();
});

// --- touch events: finger scrolling, and stroke fallback when pointer events get cancelled ---
const isPenTouch = (t) => t.touchType === 'stylus' || $('#finger').checked;
function findTouch(list, id) { for (const t of list) if (t.identifier === id) return t; return null; }
wet.addEventListener('touchstart', (e) => {
  e.preventDefault(); // blocks iPadOS scroll / selection / callouts on the canvas
  for (const t of e.changedTouches) {
    const running = state.drawing && state.drawing.touchId === undefined;
    if (isPenTouch(t) || running) {
      const d = state.drawing;
      if (d && d.touchId === undefined) d.touchId = t.identifier; // pointer stroke already running
      else if (!d) {
        const f = t.force || 0;
        startStroke(t.clientX, t.clientY, f || 0.5, 'touch', true, t.touchType === 'stylus' && f > 0 ? 0 : 1);
        if (state.drawing) { state.drawing.touchId = t.identifier; state.drawing.fromTouch = true; }
      }
    } else if (!state.drawing) {
      fingerScroll = { y: t.clientY, start: state.scrollY, touchId: t.identifier };
    }
  }
}, { passive: false });
wet.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (fingerScroll && fingerScroll.touchId !== undefined) {
    const t = findTouch(e.changedTouches, fingerScroll.touchId);
    if (t) { state.scrollY = Math.max(0, fingerScroll.start - (t.clientY - fingerScroll.y) / state.scale); redrawDry(); }
  }
  const d = state.drawing;
  if (!d || !d.viaTouch) return;
  const t = findTouch(e.changedTouches, d.touchId);
  if (!t) return;
  state.diag.touchPts = (state.diag.touchPts || 0) + 1;
  addPoint(t.clientX, t.clientY, t.force || 0);
  if (!d.erasing) scheduleWet();
}, { passive: false });
function touchEnd(e) {
  if (fingerScroll && findTouch(e.changedTouches, fingerScroll.touchId)) fingerScroll = null;
  const d = state.drawing;
  if (d && d.viaTouch && findTouch(e.changedTouches, d.touchId)) finishStroke();
}
wet.addEventListener('touchend', touchEnd);
wet.addEventListener('touchcancel', touchEnd);
wrap.addEventListener('wheel', (e) => {
  state.scrollY = Math.max(0, state.scrollY + e.deltaY / state.scale);
  redrawDry();
  e.preventDefault();
}, { passive: false });

function eraseAt([x, y]) {
  const r = SIZES.eraser;
  const hit = state.strokes.filter((s) => s.maxY >= y - r && s.minY <= y + r && s.p.some((p) => Math.hypot(p[0] - x, p[1] - y) < r + s.s));
  if (!hit.length) return;
  state.strokes = state.strokes.filter((s) => !hit.includes(s));
  state.drawing.removed.push(...hit);
  redrawDry();
}

// ---------- undo/redo ----------
const history = [];
function pushHistory(h) { history.push(h); }
function undo() {
  const h = history.pop(); if (!h) return;
  if (h.type === 'add') state.strokes = state.strokes.filter((s) => s !== h.stroke);
  else state.strokes.push(...h.strokes);
  state.redo.push(h); redrawDry(); save();
}
function redo() {
  const h = state.redo.pop(); if (!h) return;
  if (h.type === 'add') state.strokes.push(h.stroke);
  else state.strokes = state.strokes.filter((s) => !h.strokes.includes(s));
  history.push(h); redrawDry(); save();
}

// ---------- toolbar ----------
const colorBox = $('#colors');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' on' : '');
  b.style.background = c;
  b.setAttribute('aria-label', 'Color ' + (i + 1));
  b.onclick = () => {
    state.color = c; setTool('pen');
    colorBox.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
  };
  colorBox.appendChild(b);
});
function setTool(t) {
  state.tool = t;
  $('#pen').classList.toggle('on', t === 'pen');
  $('#eraser').classList.toggle('on', t === 'eraser');
}
$('#pen').onclick = () => setTool('pen');
$('#eraser').onclick = () => setTool('eraser');
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#top').onclick = () => { state.scrollY = 0; redrawDry(); };
$('#end').onclick = () => { state.scrollY = Math.max(0, contentBottom() - 200); redrawDry(); };
$('#diagbtn').onclick = () => { $('#diag').hidden = !$('#diag').hidden; updateDiag(); };

// ---------- diagnostics ----------
function log(msg) {
  const el = $('#log');
  const line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  el.prepend(line);
}
function updateDiag() {
  const d = state.diag;
  $('#diaginfo').textContent = [
    'Plugin version: 0.4',
    'Inside Standard Notes: ' + (state.inSN ? 'yes' : 'no (standalone preview)'),
    'Platform: ' + (state.inSN ? (snApi.platform || '?') + ' / ' + (snApi.environment || '?') : navigator.platform),
    'Input types seen: ' + ([...d.types].join(', ') || 'none yet — draw something'),
    'Pressure range: ' + (d.pMax ? d.pMin.toFixed(2) + ' – ' + d.pMax.toFixed(2) : 'n/a'),
    'Coalesced events: ' + (d.coalesced ? 'supported' : 'not supported') + ' · samples: ' + d.events,
    'Pointer cancels rescued: ' + (d.cancels || 0) + ' · touch-fallback samples: ' + (d.touchPts || 0),
    'Shapes snapped: ' + (d.shapes || 0) + ' · repeated points dropped: ' + (d.dupes || 0),
    'Mic API present: ' + (!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)),
    'Permissions policy allows mic: ' + micPolicy(),
  ].join('\n');
}
function micPolicy() {
  const pol = document.permissionsPolicy || document.featurePolicy;
  if (!pol || !pol.allowsFeature) return 'unknown (browser doesn’t say)';
  return pol.allowsFeature('microphone') ? 'yes' : 'NO — host app blocks it';
}

// ---------- microphone test ----------
let rec = null;
$('#mic').onclick = async () => {
  const out = $('#micresult');
  const btn = $('#mic');
  if (rec) { rec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    out.textContent = '❌ No microphone API in this frame. Recording is not possible here.';
    log('mic: navigator.mediaDevices.getUserMedia missing');
    return;
  }
  out.textContent = 'Asking for microphone…';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    out.textContent = '❌ Microphone blocked: ' + e.name + ' — ' + e.message;
    log('mic error: ' + e.name + ': ' + e.message);
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    out.textContent = '⚠️ Got the mic, but MediaRecorder is missing, so audio can’t be saved.';
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
    const kb = Math.round(blob.size / 1024);
    out.textContent = `✅ Recorded ${kb} KB as ${rec.mimeType || 'unknown type'}. Tap play to check it.`;
    log('mic ok: ' + kb + ' KB ' + rec.mimeType);
    const a = $('#playback');
    a.src = URL.createObjectURL(blob);
    a.hidden = false;
    btn.textContent = '🎙 Test mic again';
    rec = null;
  };
  rec.start();
  btn.textContent = '■ Stop recording';
  out.textContent = '🔴 Recording… say something, then tap Stop (auto-stops after 10s).';
  setTimeout(() => rec && rec.state === 'recording' && rec.stop(), 10000);
};

// ---------- boot ----------
window.addEventListener('resize', resize);
resize();
updateDiag();
if (state.inSN) {
  snApi.initialize({ debounceSave: 400 });
  snApi.subscribe((text) => {
    if (state.drawing) return;
    // ignore echoes of our own saves
    if (text === lastLoaded) return;
    lastLoaded = text;
    load(text);
    updateDiag();
  });
} else {
  log('Standalone preview: drawings are not saved anywhere.');
}
