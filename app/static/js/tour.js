/* Sandra's FrontDoor: guided, photoreal remodel preview inside a Matterport tour.
 *
 * How a change works
 *  1. You circle something (loosely is fine) and say what you want, or the guided tour proposes it.
 *  2. The view and camera pose are frozen at that moment, so you can keep walking while it works.
 *  3. The agent finds the WHOLE object you meant in that frozen view, picks a product and prices it.
 *  4. Gemini edits the photo; the edit is projected back into the tour from that exact scan point.
 *  5. An independent reviewer (OpenAI, Gemini fallback) checks before/after; if it's not a clear, finished,
 *     believable result it is re-rendered with the reviewer's fix (up to 2 retries).
 *  6. When ready you get a card with "Show me"; walking to other spots re-renders it from there.
 */
const H = window.HOME;
const NEEDS = (new URLSearchParams(location.search).get('needs') || '').split(',').filter(Boolean);
const STORE = `frontdoor-v3-${H.id}`;
const BUDGET = (() => { try { return +sessionStorage.getItem('fd-budget') || 0; } catch { return 0; } })();
const PERSONA = (() => { try { return sessionStorage.getItem('fd-persona') || ''; } catch { return ''; } })();
const $ = (s, r = document) => r.querySelector(s);
const money = (n) => '$' + Math.round(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const soon = (p, ms = 4000) => Promise.race([Promise.resolve(p).catch(() => null), sleep(ms)]);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let sdk = null, info = null;
let mode = 'walk', view = 'after';
let poseCache = null, lastSweep = null;
let selections = [];
let edits = [];
const live = {};                 // editId -> {patches: {sweepId: node}}
const selFor = new Map();        // editId -> selection (frozen frame, kept in memory)
const pending = new Set();
let chatHistory = [];
let agentBusy = false, agentAbort = false;
const keyOf = (room, title) => `${room}|${String(title).toLowerCase()}`;
const declined = new Set((() => { try { return JSON.parse(localStorage.getItem(`frontdoor-declined-${window.HOME.id}`) || '[]'); } catch { return []; } })());
const saveDeclined = () => { try { localStorage.setItem(`frontdoor-declined-${H.id}`, JSON.stringify([...declined])); } catch {} };
// Everything the agent should know about what's already been done in this home
const stateForAgent = () => edits.filter((x) => x.status !== 'failed').map((x) => ({ room: x.room, change: x.title, replaced: x.item, product: x.option?.name, shown: x.on !== false, status: x.status }));

/* ================= boot ================= */
const iframe = $('#showcase');
iframe.src = `/bundle/showcase.html?m=${H.matterport_id}&play=1&qs=1&brand=0&help=0&mls=2&applicationKey=${encodeURIComponent(window.SDK_KEY)}`;
iframe.addEventListener('load', async () => {
  try {
    sdk = await iframe.contentWindow.MP_SDK.connect(iframe.contentWindow);
    await new Promise((res) => { const sub = sdk.App.state.subscribe((s) => { if (s.phase === sdk.App.Phase.PLAYING) { res(); setTimeout(() => sub.cancel()); } }); });
    window.hmSdk = sdk;
    await sdk.Scene.register('fd.photo', () => new PhotoPatch());
    await loadRooms();
    sdk.Camera.pose.subscribe(onPose);
    await restoreEdits();
    hint('Drag to look around. Click <b>✎ Change something</b> to reimagine any spot.', 6000);
    welcome();
  } catch (e) { console.error(e); hint('3D tour failed to load: ' + (e.message || e)); }
});

/* ================= photo patches ================= */
function PhotoPatch() {   // edited photo, projected along the camera rays it was taken with
  this.inputs = { url: '', corners: [], visible: true };
  this.onInit = function () {
    const T = this.context.three, c = this.inputs.corners;
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([c[0], c[1], c[2], c[3]].flatMap((p) => [p.x, p.y, p.z]), 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 3, 1, 1, 3, 2]);
    const tex = new T.TextureLoader().load(this.inputs.url);
    if ('colorSpace' in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
    tex.anisotropy = 8;
    this.mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
    this.mesh.renderOrder = 3000; this.mesh.frustumCulled = false;
    this.outputs.objectRoot = this.mesh; this.apply();
  };
  this.apply = function () { this.outputs.objectRoot.visible = this.inputs.visible; };
  this.onInputsUpdated = function () { this.apply(); };
}
async function addNode(component, inputs) {
  const [obj] = await sdk.Scene.createObjects(1);
  const n = obj.addNode(); n.addComponent(component, inputs); obj.start(); return n;
}
const comp = (n) => [...n.componentIterator()][0];

/* ================= camera math ================= */
function rayDir(px, py, pose) {
  const W = pose.W || iframe.clientWidth, Hh = pose.H || iframe.clientHeight, P = pose.projection;
  const nx = (px / W) * 2 - 1, ny = -((py / Hh) * 2 - 1);
  const x = (nx + (P ? P[8] : 0)) / (P ? P[0] : 1.2), y = (ny + (P ? P[9] : 0)) / (P ? P[5] : 1.2), z = -1;
  const pitch = pose.rotation.x * Math.PI / 180, yaw = pose.rotation.y * Math.PI / 180;
  const y2 = y * Math.cos(pitch) - z * Math.sin(pitch), z2 = y * Math.sin(pitch) + z * Math.cos(pitch);
  const x3 = x * Math.cos(yaw) + z2 * Math.sin(yaw), z3 = -x * Math.sin(yaw) + z2 * Math.cos(yaw);
  const L = Math.hypot(x3, y2, z3);
  return { x: x3 / L, y: y2 / L, z: z3 / L };
}
function patchCorners(rectN, pose, d = 0.6) {
  const W = pose.W || iframe.clientWidth, Hh = pose.H || iframe.clientHeight, c = pose.position;
  const fwd = rayDir(W / 2, Hh / 2, pose);
  return [[rectN[0], rectN[1]], [rectN[2], rectN[1]], [rectN[2], rectN[3]], [rectN[0], rectN[3]]].map(([u, v]) => {
    const r = rayDir(u * W, v * Hh, pose), k = d / (r.x * fwd.x + r.y * fwd.y + r.z * fwd.z);
    return { x: c.x + r.x * k, y: c.y + r.y * k, z: c.z + r.z * k };
  });
}
const snapPose = (p = poseCache) => ({ sweep: p.sweep, position: { ...p.position }, rotation: { ...p.rotation },
  projection: p.projection ? Array.from(p.projection) : null, W: iframe.clientWidth, H: iframe.clientHeight });
async function hitAt(x, y) {
  try { const d = await sdk.Renderer.getWorldPositionData({ x, y }); return d && d.position ? d.position : null; } catch { return null; }
}
/* Walk to a scan point through its neighbors, like stepping through the house, instead of jumping. */
async function walkTo(target) {
  if (!poseCache || poseCache.sweep === target) return;
  const byId = Object.fromEntries(sweepList.map((s) => [s.id, s]));
  const prev = { [poseCache.sweep]: null }, q = [poseCache.sweep];
  while (q.length && !(target in prev)) { const c = q.shift(); for (const n of byId[c]?.neighbors || []) if (!(n in prev) && byId[n]) { prev[n] = c; q.push(n); } }
  const path = [];
  if (target in prev) for (let c = target; c && c !== poseCache.sweep; c = prev[c]) path.unshift(c);
  else path.push(target);
  for (const id of path.slice(0, 12)) await soon(sdk.Sweep.moveTo(id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 520 }), 2500);
  if (path.length > 12) await soon(sdk.Sweep.moveTo(target, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }), 3000);
  await sleep(250);
}
/* Spotlight an exact item on screen (loc.rect is normalized for the view at loc.rot). */
function spotlight(loc) {
  clearSpot();
  const W = overlay.clientWidth, Hh = overlay.clientHeight, [x0, y0, x1, y1] = loc.rect;
  const el = document.createElement('div'); el.className = 'spot'; el.id = 'spot';
  Object.assign(el.style, { left: x0 * W + 'px', top: y0 * Hh + 'px', width: (x1 - x0) * W + 'px', height: (y1 - y0) * Hh + 'px' });
  if (loc.label) el.innerHTML = `<span class="sel-label">${esc(loc.label)}</span>`;
  overlay.appendChild(el); spotFor = loc;
}
let spotFor = null;
function clearSpot() { $('#spot')?.remove(); spotFor = null; }
async function goTo(loc) {
  stopAgentSoft(); switchView('tour'); closeDrawers(); setMode('walk');
  await walkTo(loc.sweep); await lookAt(loc.rot, 120); await sleep(150);
  spotlight(loc);
}
function stopAgentSoft() { /* navigating from chat while the tour waits for an answer is fine */ }
// Camera.setRotation is sometimes ignored by the SDK; rotate (yaw -h, pitch +v) and verify.
async function lookAt(rot, speed = 10000) {     // speed in degrees/second; ~90 looks like turning your head
  const off = () => { const c = poseCache.rotation; return { dy: ((rot.y - c.y + 540) % 360) - 180, dx: rot.x - c.x }; };
  for (let k = 0; k < 4; k++) {
    const { dy, dx } = off();
    if (Math.abs(dy) < 0.6 && Math.abs(dx) < 0.6) return true;
    const ms = Math.min(4000, (Math.max(Math.abs(dy), Math.abs(dx)) / speed) * 1000);
    await soon(sdk.Camera.rotate(-dy, dx, { speed }), ms + 2500); await sleep(k ? 250 : Math.max(250, ms * 0.15));
    speed = Math.max(speed, 300);   // small corrections can be quick
  }
  const { dy, dx } = off(); return Math.abs(dy) < 1.5 && Math.abs(dx) < 1.5;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
async function worldFromRect(r) {       // fit a house-aligned 3D box to what's inside a screen rectangle
  const cam = poseCache.position;
  const center = await hitAt(r.x + r.w / 2, r.y + r.h / 2);
  if (!center) return null;
  const N = 6, jobs = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) jobs.push(hitAt(r.x + r.w * (0.06 + 0.88 * i / (N - 1)), r.y + r.h * (0.06 + 0.88 * j / (N - 1))));
  let pts = (await Promise.all(jobs)).filter(Boolean).filter((p) => dist(cam, p) < dist(cam, center) + 1.2);
  if (pts.length < 4) pts = [center];
  const yaw = Math.round(Math.atan2(cam.x - center.x, cam.z - center.z) / (Math.PI / 2)) * (Math.PI / 2);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const loc = pts.map((p) => ({ x: (p.x - center.x) * c - (p.z - center.z) * s, z: (p.x - center.x) * s + (p.z - center.z) * c }));
  const xs = loc.map((p) => p.x), zs = loc.map((p) => p.z), ys = pts.map((p) => p.y);
  const x0 = pct(xs, 0.08), x1 = pct(xs, 0.92), z0 = pct(zs, 0.08), z1 = pct(zs, 0.92);
  const camFloor = cam.y - 1.45, yMin = Math.min(...ys);
  const floorY = Math.abs(yMin - camFloor) < 0.35 ? yMin : Math.min(yMin, camFloor);
  const w = Math.max(0.2, x1 - x0), d = Math.max(0.2, z1 - z0), h = Math.max(0.2, pct(ys, 0.92) - floorY);
  const lx = (x0 + x1) / 2, lz = (z0 + z1) / 2;
  return { center: { x: center.x + lx * c + lz * s, y: floorY + h / 2, z: center.z - lx * s + lz * c }, w, h, d, yaw, floorY, rise: Math.max(...ys) - Math.min(...ys) };
}
function projectBox(world, pose = poseCache) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, c = Math.cos(world.yaw), s = Math.sin(world.yaw), xs = [], ys = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    const lx = dx * world.w / 2, lz = dz * world.d / 2;
    const q = sdk.Conversion.worldToScreen({ x: world.center.x + lx * c + lz * s, y: world.center.y + dy * world.h / 2, z: world.center.z - lx * s + lz * c }, pose, { w: W, h: Hh });
    if (!q || q.z > 1 || q.z < -1) return null;
    xs.push(q.x); ys.push(q.y);
  }
  const full = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  const r = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(W, Math.max(...xs)), y1: Math.min(Hh, Math.max(...ys)) };
  if (r.x1 - r.x0 < 50 || r.y1 - r.y0 < 50 || (r.x1 - r.x0) * (r.y1 - r.y0) < 0.3 * full) return null;
  return r;
}

/* ================= rooms ================= */
let sweepList = [], roomList = [], roomIdx = 0;
async function collect(obs) {
  const out = []; let sub;
  await Promise.race([new Promise((r) => { sub = obs.subscribe({ onCollectionUpdated: (c) => { const v = Object.values(c); if (v.length) { out.splice(0, out.length, ...v); r(); } } }); }), sleep(10000)]);
  setTimeout(() => sub?.cancel?.());
  return out;
}
async function loadRooms() {
  sweepList = await collect(sdk.Sweep.data);
  let rooms = await collect(sdk.Room.data).catch(() => []);
  if (!rooms.filter((r) => r.label).length) {
    for (let i = 0; i < 100 && !info; i++) await sleep(100);
    rooms = (info?.scan?.rooms || []).map((r) => ({ id: r.id, label: r.type }));
  }
  const bySweep = {};
  for (const s of sweepList) if (s.roomInfo?.id) (bySweep[s.roomInfo.id] ||= []).push(s);
  roomList = rooms.filter((r) => r.label && bySweep[r.id]).map((r) => ({ id: r.id, label: r.label.split(/,| \/ /)[0].trim(), sweeps: bySweep[r.id] }));
  const n = {}; roomList.forEach((r) => { n[r.label] = (n[r.label] || 0) + 1; r.k = n[r.label]; });
  roomList.forEach((r) => { if (n[r.label] > 1) r.label += ' ' + r.k; });
  $('#room-nav').classList.toggle('hidden', !roomList.length);
}
const currentRoom = () => { const s = sweepList.find((x) => x.id === lastSweep); return roomList.find((r) => r.id === s?.roomInfo?.id); };
function centerSweep(r) {
  const cx = r.sweeps.reduce((a, s) => a + s.position.x, 0) / r.sweeps.length, cz = r.sweeps.reduce((a, s) => a + s.position.z, 0) / r.sweeps.length;
  return [...r.sweeps].sort((a, b) => Math.hypot(a.position.x - cx, a.position.z - cz) - Math.hypot(b.position.x - cx, b.position.z - cz))[0];
}
async function goRoom(i) {
  if (!roomList.length) return;
  roomIdx = (i + roomList.length) % roomList.length;
  $('#room-name').textContent = roomList[roomIdx].label;
  await soon(sdk.Sweep.moveTo(centerSweep(roomList[roomIdx]).id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }));
}
$('#room-prev').onclick = () => { stopAgent(); goRoom(roomIdx - 1); };
$('#room-next').onclick = () => { stopAgent(); goRoom(roomIdx + 1); };
$('#room-name').onclick = () => {
  const m = $('#room-menu');
  m.innerHTML = roomList.map((r, i) => `<button data-i="${i}" class="block w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-100">${esc(r.label)}</button>`).join('');
  m.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { m.classList.add('hidden'); stopAgent(); goRoom(+b.dataset.i); });
  m.classList.toggle('hidden');
};

/* ================= pose: show patches for this spot, re-render where useful ================= */
let settleTimer = null;
function onPose(p) {
  poseCache = p;
  if (p.sweep !== lastSweep) {
    lastSweep = p.sweep;
    const r = currentRoom(); if (r) roomIdx = roomList.indexOf(r);
    $('#room-name').textContent = r ? r.label : 'Between rooms';
    refreshVisibility();
  }
  overlay.querySelectorAll('.sel-box').forEach((e) => e.remove());   // 2D outlines only make sense for the view they were drawn in
  if (spotFor && (p.sweep !== spotFor.sweep || Math.abs(((p.rotation.y - spotFor.rot.y + 540) % 360) - 180) + Math.abs(p.rotation.x - spotFor.rot.x) > 2)) clearSpot();
  if (mode === 'select') hideMenu();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(renderMissingViews, 1100);
}
function refreshVisibility() {
  for (const e of edits) for (const [sw, n] of Object.entries(live[e.id]?.patches || {})) {
    comp(n).inputs.visible = view === 'after' && sw === lastSweep && e.on !== false && e.status === 'ready';
    comp(n).onInputsUpdated();
  }
}
async function renderMissingViews() {
  if (!sdk || agentBusy || view !== 'after' || !poseCache) return;
  const pose = poseCache, W = iframe.clientWidth, Hh = iframe.clientHeight;
  for (const e of edits) {
    if (e.on === false || !e.world || e.status !== 'ready' || e.patches.some((p) => p.sweep === pose.sweep)) continue;
    const key = `${e.id}@${pose.sweep}`, d = dist(pose.position, e.world.center);
    const sameRoom = e.roomId && currentRoom()?.id === e.roomId;
    if (pending.has(key) || d > 4.5 || (!sameRoom && d > 2.5)) continue;
    const r = projectBox(e.world, pose);
    if (!r || (r.x1 - r.x0) < 160 || (r.y1 - r.y0) < 140 || (r.x1 - r.x0) * (r.y1 - r.y0) < 0.06 * W * Hh) continue;
    let clear = 0;
    for (const [u, v] of [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.7], [0.7, 0.7]]) {
      const hit = await hitAt(r.x0 + (r.x1 - r.x0) * u, r.y0 + (r.y1 - r.y0) * v);
      if (hit && dist(pose.position, hit) > d - Math.max(e.world.w, e.world.d) * 0.75) clear++;
    }
    if (clear < 4 || pose.sweep !== poseCache.sweep) continue;
    pending.add(key);
    const card = jobCard({ id: key, title: `Showing “${e.title}” from here`, step: 'Rendering this angle', pct: 60, busy: true });
    try { await renderPatch(e, r, snapPose(pose), null, null); e.patches.at(-1).extra = true; save(); }
    catch (err) { console.warn(err); }
    pending.delete(key); card.remove(); refreshVisibility();
  }
}

/* ================= rendering ================= */
async function grabFrame() {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, k = Math.min(2, 1600 / W);
  return sdk.Renderer.takeScreenShot({ width: Math.round(W * k), height: Math.round(Hh * k) }, { mattertags: false, sweeps: false });
}
function taskText(e) {
  const what = e.custom || (e.option ? `${e.option.name} (${e.option.spec})` : e.title);
  if (e.action === 'remove') return `Remove ${e.item || 'the selected item'} completely and fill the space with the surrounding floor and wall. ${e.custom || ''}`;
  if (e.action === 'add') return `Install ${what}. Purpose: ${e.title}.`;
  return `Replace ${e.item || 'what is in the masked area'} with ${what}. Purpose: ${e.title}.`;
}
async function renderPatch(e, r, pose, image, poly, fix) {
  image = image || await grabFrame();
  const W = pose.W, Hh = pose.H;
  const meta = await fetch(`/api/home/${H.id}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, rect: [r.x0 / W, r.y0 / Hh, r.x1 / W, r.y1 / Hh], task: taskText(e), ref: e.ref || null, fix: fix || null,
      poly: poly ? poly.map(([x, y]) => [x / W, y / Hh]) : null }) }).then((x) => x.json());
  if (meta.error) throw new Error(meta.error);
  const p = { sweep: pose.sweep, rid: meta.id, corners: patchCorners(meta.rect, pose), rot: { ...pose.rotation }, rectN: meta.rect };
  e.patches.push(p); save();
  await mountPatch(e, p);
  return meta;
}
async function mountPatch(e, p) {
  const n = await addNode('fd.photo', { url: `/api/home/${H.id}/render/${p.rid}/patch`, corners: p.corners, visible: false });
  (live[e.id] ||= { patches: {} }).patches[p.sweep] = n;
}
function dropPatch(e, p) {
  const n = live[e.id]?.patches?.[p.sweep]; if (n) { n.stop(); delete live[e.id].patches[p.sweep]; }
  e.patches = e.patches.filter((x) => x !== p);
}

/* ================= processing window ================= */
const STEPS = { understanding: ['Understanding your request', 15], designing: ['Choosing the product & price', 35], rendering: ['Rendering it into your home', 60],
  checking: ['Checking the result looks right', 88], fixing: ['Fixing what the check found', 70], ready: ['Ready', 100], failed: ['Could not finish', 100] };
function jobCard({ id, title, step, pct, busy, thumb }) {
  let el = document.getElementById('job-' + id);
  if (!el) { el = document.createElement('div'); el.id = 'job-' + id; el.className = 'job'; $('#jobs').prepend(el); }
  el.innerHTML = `<div class="flex items-start gap-2">${thumb ? `<img src="${thumb}" class="w-10 h-10 rounded-md object-cover shrink-0">` : ''}
    <div class="min-w-0 flex-1"><div class="text-sm font-semibold leading-tight truncate">${esc(title)}</div>
    <div class="text-xs text-slate-500 mt-0.5">${esc(step)}</div></div></div>
    <div class="job-bar mt-2 ${busy ? 'busy' : ''}"><div style="width:${pct}%"></div></div>`;
  return el;
}
function showJob(e) {
  const [step, pct] = STEPS[e.status] || ['', 0];
  const el = jobCard({ id: e.id, title: e.title, step: e.status === 'checking' && e.tries ? `${step} (attempt ${e.tries + 1})` : step, pct,
    busy: ['rendering', 'fixing', 'checking', 'understanding'].includes(e.status), thumb: e.crop });
  if (e.status === 'ready') {
    el.innerHTML = `<div class="flex items-center gap-2"><img src="/api/home/${H.id}/render/${e.patches[0]?.rid}/after" class="w-14 h-11 rounded-md object-cover shrink-0">
      <div class="min-w-0 flex-1"><div class="text-[11px] font-bold text-emerald-700">READY${e.score ? ` · quality ${e.score}/10` : ''}</div>
      <div class="text-sm font-semibold leading-tight truncate">${esc(e.title)}</div></div></div>
      <div class="mt-2 flex gap-2"><button data-show class="flex-1 text-sm font-semibold bg-brand-600 text-white rounded-lg py-1.5 hover:bg-brand-700">Show me</button>
      <button data-dismiss class="text-sm text-slate-500 px-2 rounded-lg hover:bg-slate-100">Later</button></div>`;
    el.querySelector('[data-show]').onclick = () => { el.remove(); flyTo(e); };
    el.querySelector('[data-dismiss]').onclick = () => el.remove();
  } else if (e.status === 'failed') {
    el.innerHTML = `<div class="text-sm font-semibold text-red-700">${esc(e.title)}</div><div class="text-xs text-slate-500">${esc(e.error || 'Something went wrong')}</div>
      <div class="mt-1.5 flex gap-2"><button data-retry class="text-xs font-semibold border rounded-lg px-2 py-1">Try again</button><button data-dismiss class="text-xs text-slate-500 px-2">Dismiss</button></div>`;
    el.querySelector('[data-retry]').onclick = () => { el.remove(); const s = selFor.get(e.id); removeEdit(e.id, true); if (s) command(s, e.instruction || e.title, e.title); };
    el.querySelector('[data-dismiss]').onclick = () => { el.remove(); removeEdit(e.id, true); };
  }
}

/* ================= changes: locate -> price -> render -> review -> ready ================= */
function annotate(sel) {      // frozen frame with the user's loose outline drawn on it, for the agent
  return new Promise((res) => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'), k = Math.min(1, 1100 / img.naturalWidth);
      c.width = img.naturalWidth * k; c.height = img.naturalHeight * k;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
      if (!sel.whole) {
        const sx = c.width / sel.pose.W, sy = c.height / sel.pose.H;
        ctx.strokeStyle = '#ff00ff'; ctx.lineWidth = 4; ctx.setLineDash([12, 8]); ctx.beginPath();
        if (sel.poly) sel.poly.forEach(([x, y], i) => i ? ctx.lineTo(x * sx, y * sy) : ctx.moveTo(x * sx, y * sy));
        else ctx.rect(sel.rect.x * sx, sel.rect.y * sy, sel.rect.w * sx, sel.rect.h * sy);
        ctx.closePath(); ctx.stroke();
      }
      res(c.toDataURL('image/jpeg', 0.88));
    };
    img.src = sel.frame;
  });
}
const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'with', 'and', 'to', 'make', 'into', 'add', 'replace', 'remove', 'here', 'of', 'for', 'in', 'on', 'please', 'accessible', 'needs']);
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || []);
function similarEdit(sel, instruction) {
  const want = words(instruction);
  return edits.find((e) => e.status !== 'failed' && e.on !== false && e.roomId && e.roomId === sel.roomId &&
    ((e.world && sel.world && !sel.whole && dist(e.world.center, sel.world.center) < 1.2) || [...words(e.title + ' ' + (e.instruction || ''))].filter((w) => want.has(w)).length >= 2));
}
function ask(html, buttons, loc = null) {   // a question in the chat with button answers
  return new Promise((res) => {
    const el = bubble(`${html}<div class="mt-2 flex flex-wrap gap-2">${buttons.map(([k, l], i) => `<button data-k="${k}" class="text-sm font-semibold rounded-lg px-3 py-1.5 ${i ? 'border hover:bg-slate-50' : 'bg-brand-600 text-white hover:bg-brand-700'}">${l}</button>`).join('')}</div>`, 'ai', loc);
    el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { el.querySelectorAll('button').forEach((x) => x.disabled = true); b.classList.add('ring-2', 'ring-brand-300'); res(b.dataset.k); });
  });
}
function newEdit(sel, fields) {
  const e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: 'Working on it', action: 'replace', item: sel.item || '',
    option: null, options: [], custom: '', world: sel.world, cost: 0, patches: [], on: true, room: sel.roomLabel || '', roomId: sel.roomId || null,
    status: 'understanding', crop: sel.crop, tries: 0, ...fields };
  selFor.set(e.id, sel); edits.push(e); save(); renderPlan(); showJob(e);
  return e;
}
function setStatus(e, s, extra = {}) { Object.assign(e, extra, { status: s }); save(); renderPlan(); showJob(e); }

// Run a change. `finding` (from the guided tour) skips the locate step.
async function command(sel, instruction, label, finding = null) {
  hideMenu(); clearOutline(sel);
  selections = selections.filter((x) => x !== sel); renderSelChips();
  const dup = similarEdit(sel, instruction);
  if (dup) {
    const k = await ask(`You already have <b>${esc(dup.title)}</b> here${dup.option ? ` (${esc(dup.option.name)}, ${money(dup.cost)})` : ''}. What would you like?`,
      [['replace', 'Replace it with this'], ['keep', 'Keep what I have'], ['both', 'Add both']]);
    if (k === 'keep') { flyTo(dup); return dup; }
    if (k === 'replace') removeEdit(dup.id, true);
  }
  const e = newEdit(sel, { title: label || instruction, instruction });
  try {
    let f = finding;
    if (!f) {
      const image = await annotate(sel);
      const plan = await fetch(`/api/home/${H.id}/agent/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views: [{ image, room: sel.roomLabel }], needs: NEEDS, persona: PERSONA, instruction, outlined: !sel.whole,
          existing: stateForAgent().filter((x) => x.change !== e.title), declined: [...declined] }) }).then((r) => r.json());
      if (plan.error) throw new Error(plan.error);
      f = (plan.findings || [])[0];
      if (!f) throw new Error("I couldn't find what you meant in that view. Try circling it again.");
    }
    // the agent's box around the whole object becomes the edit area
    if (f.box_2d) {
      const b = f.box_2d, W = sel.pose.W, Hh = sel.pose.H, m = 0.04;
      const x0 = Math.max(0, (b[1] / 1000 - m) * W), y0 = Math.max(0, (b[0] / 1000 - m) * Hh), x1 = Math.min(W, (b[3] / 1000 + m) * W), y1 = Math.min(Hh, (b[2] / 1000 + m) * Hh);
      if (x1 - x0 > 30 && y1 - y0 > 30) { sel.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; sel.poly = null; }
    }
    const opts = f.options || [], opt = opts[Math.min(1, opts.length - 1)] || null;
    setStatus(e, 'designing', { title: f.title || e.title, action: f.action || 'replace', item: f.item || '', options: opts, option: opt, cost: opt?.total || 0,
      custom: !finding && !/accessible for my needs/.test(instruction) && /replace|add|install|put|make|turn|convert/i.test(instruction) ? instruction : '' });
    if (f.advice) bubble(`<div class="text-sm"><b>${esc(e.title)}</b>${opt ? ` · ${esc(opt.name)} · ${money(opt.total)}` : ''}<div class="text-slate-600 mt-0.5">${f.fits_needs === false ? '⚠️ ' : ''}${esc(f.advice)}</div></div>`);
    await renderAndReview(e, sel);
  } catch (err) {
    setStatus(e, 'failed', { error: err.message });
  }
  return e;
}
async function renderAndReview(e, sel) {
  const r = { x0: sel.rect.x, y0: sel.rect.y, x1: sel.rect.x + sel.rect.w, y1: sel.rect.y + sel.rect.h };
  let fix = null;
  for (e.tries = 0; e.tries < 3; e.tries++) {
    setStatus(e, e.tries ? 'fixing' : 'rendering');
    for (const p of [...e.patches]) dropPatch(e, p);
    const meta = await renderPatch(e, r, sel.pose, sel.frame, sel.poly, fix);
    if (!e.ref) e.ref = meta.id;
    setStatus(e, 'checking');
    const q = await fetch(`/api/home/${H.id}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rid: meta.id, task: taskText(e) }) }).then((x) => x.json()).catch(() => ({ ok: true }));
    e.score = q.score; e.review = q;
    if (q.ok !== false) break;
    fix = [q.fix, ...(q.issues || [])].filter(Boolean).join('; ');
    e.ref = null;
  }
  setStatus(e, 'ready');
  refreshVisibility();
  const p = e.patches[0];
  if (p && !agentBusy) say(`✅ <b>${esc(e.title)}</b> is ready${e.option ? ` · ${esc(e.option.name)} · ${money(e.cost)}` : ''}.`, { sweep: p.sweep, rot: p.rot, rect: p.rectN, label: e.title });
  if (e.review && e.review.ok === false) bubble(`<div class="text-sm">I rendered <b>${esc(e.title)}</b>, but the quality check still flagged: ${esc((e.review.issues || []).join('; '))}. Swap the product in <b>Changes</b> to try another look.</div>`);
}

/* ================= selection: draw / box, frozen view, action menu ================= */
const overlay = $('#overlay');
let drag = null, tool = 'lasso';
function setMode(m) {
  mode = m;
  overlay.style.pointerEvents = m === 'select' ? 'auto' : 'none';
  overlay.style.cursor = m === 'select' ? 'crosshair' : '';
  $('#mode-select').className = 'px-4 py-2 rounded-full ' + (m === 'select' ? 'bg-brand-600 text-white' : '');
  $('#mode-walk').className = 'px-4 py-2 rounded-full ' + (m === 'walk' ? 'bg-ink text-white' : '');
  $('#tool-pick').classList.toggle('hidden', m !== 'select');
  if (m === 'select') { stopAgent(); hint('Circle what you want to change, loosely is fine. Then pick what to do.', 6000); }
  else hideMenu();
}
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool-pick]').forEach((b) => b.className = 'px-3 py-1.5 rounded-full ' + (b.dataset.toolPick === t ? 'bg-ink text-white' : ''));
}
document.querySelectorAll('[data-tool-pick]').forEach((b) => b.onclick = () => setTool(b.dataset.toolPick));
$('#mode-walk').onclick = () => setMode('walk');
$('#mode-select').onclick = () => setMode('select');
let peek = false;
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 's' || e.key === 'S') setMode('select');
  if (e.key === 'w' || e.key === 'W') setMode('walk');
  if ((e.key === 'b' || e.key === 'B') && !e.repeat && view === 'after') { peek = true; setView('orig'); }
  if (e.key === 'Escape') { clearSelections(); closeDrawers(); }
});
document.addEventListener('keyup', (e) => { if ((e.key === 'b' || e.key === 'B') && peek) { peek = false; setView('after'); } });
const svgNS = 'http://www.w3.org/2000/svg';
overlay.addEventListener('pointerdown', (e) => {
  if (mode !== 'select' || !sdk || e.target.closest('#sel-menu')) return;
  const b = overlay.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  hideMenu();
  drag = { x0: x, y0: y, pts: [[x, y]], add: e.shiftKey || e.ctrlKey };
  if (tool === 'box') { drag.el = document.createElement('div'); drag.el.className = 'marquee'; overlay.appendChild(drag.el); }
  else {
    drag.el = document.createElementNS(svgNS, 'svg'); drag.el.setAttribute('class', 'absolute inset-0 w-full h-full pointer-events-none');
    drag.path = document.createElementNS(svgNS, 'path');
    drag.path.setAttribute('fill', 'rgba(124,92,255,.15)'); drag.path.setAttribute('stroke', '#7c5cff'); drag.path.setAttribute('stroke-width', '3');
    drag.el.appendChild(drag.path); overlay.appendChild(drag.el);
  }
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const b = overlay.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  if (tool === 'box') Object.assign(drag.el.style, { left: Math.min(x, drag.x0) + 'px', top: Math.min(y, drag.y0) + 'px', width: Math.abs(x - drag.x0) + 'px', height: Math.abs(y - drag.y0) + 'px' });
  else { drag.pts.push([x, y]); drag.path.setAttribute('d', 'M' + drag.pts.map((p) => p.join(',')).join('L') + 'Z'); }
  drag.x1 = x; drag.y1 = y;
});
overlay.addEventListener('pointerup', async () => {
  if (!drag) return;
  const d = drag; drag = null; d.el.remove();
  let poly = null, r;
  if (tool === 'lasso' && d.pts.length > 6) {
    poly = d.pts;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  } else r = { x: Math.min(d.x0, d.x1 ?? d.x0), y: Math.min(d.y0, d.y1 ?? d.y0), w: Math.abs((d.x1 ?? d.x0) - d.x0), h: Math.abs((d.y1 ?? d.y0) - d.y0) };
  if (r.w < 14 || r.h < 14) { r = { x: d.x0 - 80, y: d.y0 - 80, w: 160, h: 160 }; poly = null; }
  if (!d.add) clearSelections();
  await makeSelection(r, poly);
});
function cropOf(img, r, W, max = 640) {
  const k = img.naturalWidth / W, c = document.createElement('canvas');
  const s = Math.min(1, max / (Math.max(r.w, r.h) * k));
  c.width = Math.max(1, r.w * k * s); c.height = Math.max(1, r.h * k * s);
  c.getContext('2d').drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
async function makeSelection(r, poly = null, opts = {}) {
  const pose = snapPose();
  const outline = opts.silent ? null : screenOutline(r, poly);
  const [frame, world] = await Promise.all([grabFrame(), worldFromRect(r)]);
  const img = new Image(); img.src = frame; await img.decode();
  const sel = { id: 's' + Date.now(), rect: r, poly, frame, pose, world, box: outline, crop: cropOf(img, r, pose.W), whole: !!opts.whole,
    item: opts.item || '', label: opts.label || 'Your selection', roomLabel: currentRoom()?.label || '', roomId: currentRoom()?.id || null };
  if (!opts.silent) { selections.push(sel); renderSelChips(); showMenu(sel); }
  return sel;
}
function screenOutline(r, poly) {
  const el = document.createElement('div');
  el.className = 'sel-box pending';
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  if (poly) {
    el.style.border = 'none'; el.style.background = 'none';
    el.innerHTML = `<svg class="absolute inset-0 overflow-visible" width="${r.w}" height="${r.h}"><path d="M${poly.map(([x, y]) => `${x - r.x},${y - r.y}`).join('L')}Z" fill="rgba(124,92,255,.14)" stroke="#7c5cff" stroke-width="3" stroke-dasharray="8 6"/></svg>`;
  }
  overlay.appendChild(el); return el;
}
function clearOutline(sel) { sel.box?.remove(); sel.box = null; }
function clearSelections() { for (const s of selections) clearOutline(s); selections = []; renderSelChips(); hideMenu(); }
function renderSelChips() {
  $('#sel-chips').innerHTML = selections.map((s) => `<span class="inline-flex items-center gap-1.5 text-xs font-medium bg-brand-50 text-brand-700 rounded-full pl-1 pr-1 py-1">
    <img src="${s.crop}" class="w-6 h-6 rounded-full object-cover">${esc(s.label)}<button data-x="${s.id}" class="w-5 h-5 rounded-full hover:bg-brand-100" aria-label="Remove selection">✕</button></span>`).join('');
  $('#sel-chips').querySelectorAll('[data-x]').forEach((b) => b.onclick = () => {
    const s = selections.find((x) => x.id === b.dataset.x); if (s) clearOutline(s);
    selections = selections.filter((x) => x.id !== b.dataset.x); renderSelChips(); hideMenu();
  });
}
function hideMenu() { $('#sel-menu')?.remove(); }
function showMenu(sel) {
  hideMenu();
  const m = document.createElement('div');
  m.id = 'sel-menu';
  m.className = 'absolute z-40 w-64 bg-white/95 backdrop-blur rounded-2xl shadow-2xl ring-1 ring-black/5 overflow-hidden text-[15px] text-ink';
  Object.assign(m.style, { left: Math.min(overlay.clientWidth - 270, Math.max(8, sel.rect.x + sel.rect.w + 10)) + 'px', top: Math.min(overlay.clientHeight - 320, Math.max(60, sel.rect.y)) + 'px' });
  const row = (k, label, icon) => `<button data-act="${k}" class="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-100 border-t border-slate-100">${label}<span class="text-slate-400">${icon}</span></button>`;
  m.innerHTML = `<div class="flex items-center gap-2 px-3 py-2 bg-slate-50"><img src="${sel.crop}" class="w-8 h-8 rounded-md object-cover"><span class="font-semibold text-sm">What should happen here?</span>
      <button data-act="close" class="ml-auto text-slate-400 hover:text-ink" aria-label="Cancel selection">✕</button></div>
    ${row('suggest', 'Make it accessible for me', '✦')}${row('remove', 'Remove it', '🗑')}${row('replace', 'Replace with…', '⇄')}${row('add', 'Add here…', '＋')}
    <form data-say class="hidden border-t border-slate-100 p-2 flex gap-1.5"><input class="flex-1 min-w-0 text-sm border rounded-lg px-2 py-1.5 outline-none focus:border-brand-500"><button class="text-sm font-semibold bg-brand-600 text-white rounded-lg px-3">Go</button></form>
    <form data-free class="border-t border-slate-100 p-2 flex gap-1.5"><input class="flex-1 min-w-0 text-sm border rounded-lg px-2 py-1.5 outline-none focus:border-brand-500" placeholder="Or describe it…"><button class="text-sm font-semibold bg-ink text-white rounded-lg px-3">↵</button></form>`;
  overlay.appendChild(m);
  let pendingAct = null;
  const say = m.querySelector('[data-say]'), sayIn = say.querySelector('input');
  m.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'close') { clearOutline(sel); selections = selections.filter((x) => x !== sel); renderSelChips(); return hideMenu(); }
    if (a === 'remove') return command(sel, 'Remove this completely', 'Remove it');
    if (a === 'suggest') return command(sel, `Make this accessible for my needs (${NEEDS.join(', ') || 'mobility'})`, 'Make it accessible');
    pendingAct = a; say.classList.remove('hidden');
    sayIn.placeholder = a === 'replace' ? 'e.g. a curbless walk-in shower with a seat' : 'e.g. grab bars by the toilet';
    sayIn.focus();
  });
  say.onsubmit = (ev) => { ev.preventDefault(); const t = sayIn.value.trim(); if (!t) return;
    command(sel, pendingAct === 'replace' ? `Replace this with: ${t}` : `Add here: ${t}`, `${pendingAct === 'replace' ? 'Replace with' : 'Add'} ${t}`); };
  m.querySelector('[data-free]').onsubmit = (ev) => { ev.preventDefault(); const t = ev.currentTarget.querySelector('input').value.trim(); if (t) command(sel, t, t); };
  m.querySelector('[data-free] input').focus();
}

/* ================= chat ================= */
function bubble(html, who = 'ai', loc = null) {
  const el = document.createElement('div');
  el.className = 'msg-in ' + (who === 'user' ? 'flex justify-end' : 'flex');
  el.innerHTML = who === 'user' ? `<div class="max-w-[85%] bg-brand-100 text-brand-900 rounded-2xl rounded-br-md px-3 py-2 text-sm">${html}</div>`
    : `<div class="w-full bg-white border border-slate-100 rounded-xl px-3 py-2 text-sm ${loc ? 'alert' : ''}">${loc ? '<div class="text-[11px] font-semibold text-brand-700 mb-0.5">📍 Click to see it</div>' : ''}${html}</div>`;
  if (loc) {
    const card = el.firstElementChild;
    card.onclick = (ev) => { if (ev.target.closest('button')) return; card.classList.add('seen'); card.firstElementChild.textContent = '📍 Seen. Click to go back'; goTo(loc); };
  }
  const chat = $('#chat'), atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  chat.appendChild(el);
  if (atBottom || who === 'user') chat.scrollTop = 1e9;   // like a live chat: follow new messages unless you scrolled up
  if (document.body.classList.contains('guide-min') && who !== 'user') { unread++; $('#guide-new').textContent = unread; }
  return el;
}
let unread = 0;
const say = (html, loc) => bubble(html, 'ai', loc);
const thinking = (t = 'Thinking') => bubble(`<span class="dots text-slate-500">${t}<span>.</span><span>.</span><span>.</span></span>`);
const CHANGE_RE = /(make|turn|change|replace|remove|add|convert|swap|put|install|get rid|widen|lower|raise|build|design|walk-?in|ramp|grab bar|stairlift|seat|door|shower|accessible)/i;
$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#chat-input').value.trim(); if (!msg) return;
  $('#chat-input').value = ''; stopAgent();
  bubble(esc(msg), 'user'); chatHistory.push({ role: 'user', content: msg });
  if (selections.length) { for (const s of [...selections]) command(s, msg, msg); return; }
  if (CHANGE_RE.test(msg) && sdk) {     // no selection: the agent looks at your current view to find what you mean
    const sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null, { silent: true, whole: true });
    command(sel, msg, msg); return;
  }
  const t = thinking();
  const res = await fetch(`/api/home/${H.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, history: chatHistory, edits: edits.map((e) => `${e.title} (${money(e.cost)})`) }) }).then((r) => r.json());
  t.remove(); bubble(esc(res.reply || '').replace(/\n/g, '<br>')); chatHistory.push({ role: 'assistant', content: res.reply });
});
$('#chat-clear').onclick = () => { $('#chat').innerHTML = ''; chatHistory = []; };

/* ================= guided tour: the agent walks you room by room ================= */
const ROOM_PRIORITY = [/bath/i, /bedroom/i, /stair|hall/i, /kitchen/i, /laundry/i, /entry|foyer/i];
function agentRooms() {
  const picks = [];
  for (const re of ROOM_PRIORITY) for (const r of roomList) if (re.test(r.label) && !picks.includes(r)) picks.push(r);
  return picks.filter((r) => !/closet|pantry|garage/i.test(r.label)).slice(0, 4);
}
function stopAgent() { if (agentBusy) agentAbort = true; }
async function startAgent() {
  if (agentBusy || !roomList.length) return;
  agentBusy = true; agentAbort = false; setMode('walk'); closeDrawers();
  try { await guidedTour(); } catch (err) { console.error(err); bubble(`<span class="text-red-600">Tour stopped: ${esc(err.message)}</span>`); }
  finally { agentBusy = false; renderMissingViews(); }
}
$('#agent-run').onclick = startAgent;
async function guidedTour() {
  for (let i = 0; i < 50 && !poseCache; i++) await sleep(100);
  const rooms = agentRooms();
  say(`<b>Let's walk through it together.</b> I'll take you to ${rooms.map((r) => esc(r.label)).join(', ')}, point out what gets in the way${NEEDS.length ? ' for your needs' : ''}, and show each fix in place. You decide what to keep.${BUDGET ? ` Budget: ${money(BUDGET)}.` : ''}`);
  let accepted = 0;
  for (const room of rooms) {
    if (agentAbort) break;
    const step = thinking(`Walking to ${room.label}`);
    await walkTo(centerSweep(room).id);
    await sleep(500);
    // look around smoothly while capturing what we see
    const views = [];
    const start = { ...poseCache.rotation };
    for (let k = 0; k < 4 && !agentAbort; k++) {
      if (k) await lookAt({ x: -15, y: start.y + k * 90 }, 110); else await lookAt({ x: -15, y: start.y }, 110);
      // same aspect as the tour on screen, so the agent's box coordinates map straight onto the view
      views.push({ image: await soon(sdk.Renderer.takeScreenShot({ width: 960, height: Math.round(960 * iframe.clientHeight / iframe.clientWidth) }, { mattertags: false, sweeps: false }), 8000), room: room.label, rot: { ...poseCache.rotation } });
    }
    step.remove();
    if (agentAbort) break;
    const step2 = thinking(`Checking ${room.label}`);
    const plan = await fetch(`/api/home/${H.id}/agent/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views, needs: NEEDS, persona: PERSONA, existing: stateForAgent(), declined: [...declined] }) }).then((r) => r.json()).catch(() => ({}));
    step2.remove();
    if (agentAbort) break;
    const f = (plan.findings || []).find((x) => x.fits_needs !== false && !declined.has(keyOf(room.label, x.title))) || null;
    if (!f) { say(`<b>${esc(room.label)}</b>: nothing here gets in your way. 👍`); continue; }
    // Turn to it, then re-locate it in exactly what's on screen (the model's view numbering isn't reliable).
    const order = [f.view, f.view - 1, ...views.keys()].filter((v, i, arr) => v >= 0 && v < views.length && arr.indexOf(v) === i);
    let b = null;
    for (const v of order) {
      await lookAt(views[v].rot, 90); await sleep(250);
      const shot = await soon(sdk.Renderer.takeScreenShot({ width: 960, height: Math.round(960 * iframe.clientHeight / iframe.clientWidth) }, { mattertags: false, sweeps: false }), 8000);
      const re = await fetch(`/api/home/${H.id}/agent/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views: [{ image: shot, room: room.label }], needs: NEEDS, instruction: `Locate: ${f.item} (${f.title}). Only return it if it is clearly visible in this photo.` }) }).then((r) => r.json()).catch(() => ({}));
      const g = (re.findings || [])[0];
      if (g?.box_2d) { b = g.box_2d; break; }   // the locate prompt names the exact item, so any box it returns is it
      if (agentAbort) break;
    }
    if (agentAbort) break;
    if (!b) { say(`<b>${esc(room.label)}</b>: I noticed ${esc(f.item)} but couldn't line it up on screen. You can circle it yourself with <b>✎ Change something</b>.`); continue; }
    const loc = { sweep: poseCache.sweep, rot: { ...poseCache.rotation }, rect: [b[1] / 1000, b[0] / 1000, b[3] / 1000, b[2] / 1000], label: f.item };
    spotlight(loc);
    const opt = (f.options || [])[Math.min(1, (f.options || []).length - 1)];
    const k = await ask(`<div class="text-[11px] font-semibold text-slate-500 uppercase">${esc(room.label)}</div>
      <div class="font-semibold">${esc(f.item)}: ${esc(f.issue)}</div>
      <div class="text-sm text-slate-600 mt-0.5">Fix: <b>${esc(f.title)}</b>${opt ? `, e.g. ${esc(opt.name)}, about ${money(opt.total)} (item ${money(opt.material)} + labor ${money(opt.labor)})` : ''}.</div>
      ${f.advice ? `<div class="text-sm text-slate-500 mt-0.5">${esc(f.advice)}</div>` : ''}`,
      [['yes', 'Show me this fix'], ['skip', 'Skip'], ['stop', 'End tour']], loc);
    if (k === 'stop' || agentAbort) { agentAbort = true; clearSpot(); break; }
    if (k === 'skip') { declined.add(keyOf(room.label, f.title)); saveDeclined(); clearSpot(); continue; }
    // stay in this room until the fix is ready, then show it right here
    await walkTo(loc.sweep); await lookAt(loc.rot, 90); await sleep(300);
    const W = iframe.clientWidth, Hh = iframe.clientHeight;
    const rect = { x: loc.rect[0] * W, y: loc.rect[1] * Hh, w: (loc.rect[2] - loc.rect[0]) * W, h: (loc.rect[3] - loc.rect[1]) * Hh };
    clearSpot();
    const sel = await makeSelection(rect, null, { silent: true, item: f.item });
    accepted++;
    say(`Working on <b>${esc(f.title)}</b>. I'll stay here and show you when it's ready (about a minute).`);
    const e = await command(sel, f.title, f.title, { ...f, box_2d: null });
    if (agentAbort) break;
    if (e?.status === 'ready') {
      await walkTo(loc.sweep); await lookAt(loc.rot, 90); setView('after');
      const k2 = await ask(`<b>Here it is: ${esc(e.title)}</b>${e.option ? ` (${esc(e.option.name)}, ${money(e.cost)})` : ''}. Hold <b>B</b> to compare with today.`,
        [['next', 'Keep it, next room'], ['undo', 'Undo it'], ['stop', 'End tour']]);
      if (k2 === 'undo') { removeEdit(e.id); accepted--; }
      if (k2 === 'stop') { agentAbort = true; break; }
    } else if (e) {
      const k2 = await ask(`I couldn't finish <b>${esc(e.title)}</b> (${esc(e.error || 'unknown error')}).`, [['next', 'Next room'], ['stop', 'End tour']]);
      if (k2 === 'stop') { agentAbort = true; break; }
    }
  }
  clearSpot();
  const total = edits.filter((x) => x.on !== false && x.status === 'ready').reduce((s, x) => s + (x.cost || 0), 0);
  say(agentAbort ? 'Tour ended. The home is yours to explore.' :
    `<b>That's the tour.</b> ${accepted ? `${accepted} change${accepted > 1 ? 's' : ''}, ${money(total)} in total${BUDGET ? `; total cost ${money(H.price + total)} is ${H.price + total <= BUDGET ? 'within' : 'over'} your ${money(BUDGET)} budget` : ''}.` : 'No changes needed.'} Circle anything else you'd like to change.`);
}

/* ================= changes drawer, undo, compare ================= */
function save() { try { localStorage.setItem(STORE, JSON.stringify(edits)); } catch {} }
async function restoreEdits() {
  try { edits = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { edits = []; }
  edits = edits.filter((e) => e.status === 'ready' && e.patches.length);   // unfinished work can't resume after a reload
  for (const e of edits) for (const p of e.patches) await mountPatch(e, p);
  save(); refreshVisibility(); renderPlan();
}
function removeEdit(id, quiet = false) {
  const e = edits.find((x) => x.id === id); if (!e) return;
  Object.values(live[id]?.patches || {}).forEach((n) => n.stop()); delete live[id];
  edits = edits.filter((x) => x.id !== id); document.getElementById('job-' + id)?.remove();
  save(); renderPlan();
  if (!quiet) hint(`Removed “${esc(e.title)}”.`, 3000);
}
function undo() { const e = [...edits].reverse().find((x) => x.status === 'ready' || x.status === 'failed'); if (e) removeEdit(e.id); }
$('#undo').onclick = undo;
async function swapOption(id, i) {
  const e = edits.find((x) => x.id === id); if (!e || !e.options[i]) return;
  e.option = e.options[i]; e.cost = e.option.total; e.ref = null; e.custom = '';
  const sel = selFor.get(id);
  if (sel) renderAndReview(e, sel).catch((err) => setStatus(e, 'failed', { error: err.message }));
  else { for (const p of [...e.patches]) dropPatch(e, p); save(); renderPlan(); hint('Walk back to it and it will re-render with the new product.', 4000); }
}
const PILL = {
  understanding: ['Thinking…', 'text-brand-700 bg-brand-50 animate-pulse'], designing: ['Pricing…', 'text-brand-700 bg-brand-50 animate-pulse'],
  rendering: ['Rendering…', 'text-amber-700 bg-amber-50 animate-pulse'], fixing: ['Improving…', 'text-amber-700 bg-amber-50 animate-pulse'],
  checking: ['Checking…', 'text-sky-700 bg-sky-50 animate-pulse'], ready: ['Ready', 'text-emerald-700 bg-emerald-50'], failed: ['Failed', 'text-red-700 bg-red-50'],
};
function renderPlan() {
  const on = edits.filter((e) => e.on !== false && e.status === 'ready');
  const total = on.reduce((s, e) => s + (e.cost || 0), 0), labor = on.reduce((s, e) => s + (e.option?.labor || 0), 0);
  $('#plan-count').textContent = edits.length;
  $('#plan').innerHTML = [...edits].reverse().map((e) => {
    const [pl, pc] = PILL[e.status] || PILL.ready;
    return `<li class="border border-slate-100 rounded-xl p-2.5 ${e.on === false ? 'opacity-60' : ''}">
    <div class="flex items-start gap-2.5">
      <button data-go="${e.id}" class="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-slate-100" title="Show it in the tour">
        <img src="${e.patches[0] ? `/api/home/${H.id}/render/${e.patches[0].rid}/after` : (e.crop || '')}" class="w-full h-full object-cover" alt=""></button>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5"><span class="text-[11px] font-semibold rounded-full px-2 py-0.5 ${pc}">${pl}</span><span class="ml-auto font-semibold text-sm">${e.cost ? money(e.cost) : ''}</span></div>
        <div class="font-medium text-sm leading-tight mt-0.5">${esc(e.title)}</div>
        <div class="text-xs text-slate-500">${esc(e.room)}${e.option ? ` · item ${money(e.option.material)} + labor ${money(e.option.labor)}` : ''}</div>
        ${e.options?.length > 1 && e.status === 'ready' ? `<select data-swap="${e.id}" class="mt-1 max-w-full text-xs border rounded px-1 py-0.5">${e.options.map((o, i) => `<option value="${i}" ${o.name === e.option?.name ? 'selected' : ''}>${esc(o.tier)}: ${esc(o.name)} (${money(o.total)})</option>`).join('')}</select>` : ''}
        <div class="mt-1 flex items-center gap-3 text-xs">
          ${e.status === 'ready' ? `<label class="flex items-center gap-1 text-slate-600"><input type="checkbox" data-on="${e.id}" ${e.on !== false ? 'checked' : ''} class="accent-brand-600">Show</label>
          <button data-go="${e.id}" class="text-brand-700 font-semibold">View</button>` : ''}
          <button data-del="${e.id}" class="text-slate-400 hover:text-red-600 ml-auto">Delete</button></div></div></div></li>`;
  }).join('') || '<li class="text-sm text-slate-500 p-2">Nothing yet. Click <b>✎ Change something</b> and circle anything in the tour, or take the guided tour.</li>';
  $('#plan').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeEdit(b.dataset.del));
  $('#plan').querySelectorAll('[data-go]').forEach((b) => b.onclick = () => flyTo(edits.find((e) => e.id === b.dataset.go)));
  $('#plan').querySelectorAll('[data-on]').forEach((b) => b.onchange = () => { const e = edits.find((x) => x.id === b.dataset.on); e.on = b.checked; save(); refreshVisibility(); renderPlan(); });
  $('#plan').querySelectorAll('[data-swap]').forEach((s) => s.onchange = () => swapOption(s.dataset.swap, +s.value));
  $('#plan-total').textContent = money(total); $('#plan-labor').textContent = money(labor);
  $('#c-mods').textContent = money(total);
  $('#c-price').textContent = money(H.price) + (H.rent ? '/mo' : '');
  $('#c-true').textContent = H.rent ? `${money(H.price)}/mo + ${money(total)}` : money(H.price + total);
  const b = $('#budget');
  if (BUDGET && !H.rent) { const left = BUDGET - H.price - total; b.textContent = left >= 0 ? `· ${money(left)} under budget` : `· ${money(-left)} over budget`; b.className = 'text-xs font-semibold ' + (left >= 0 ? 'text-emerald-600' : 'text-red-600'); }
}
$('#plan-clear').onclick = () => [...edits].forEach((e) => removeEdit(e.id, true));
async function flyTo(e) {
  if (!e?.patches.length) return;
  switchView('tour'); closeDrawers(); setView('after');
  const p = e.patches.find((x) => !x.extra) || e.patches[0];
  await soon(sdk.Sweep.moveTo(p.sweep, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }));
  await lookAt(p.rot || poseCache.rotation);
  hint(`<b>${esc(e.title)}</b>. Hold <b>B</b> or flip <b>Your changes</b> to compare with today.`, 5000);
}
function setView(v) {
  view = v; refreshVisibility();
  const on = v === 'after';
  $('#compare-dot').className = 'w-9 h-6 rounded-full relative transition ' + (on ? 'bg-brand-600' : 'bg-slate-300');
  $('#compare-dot').firstElementChild.className = 'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition ' + (on ? 'right-0.5' : 'left-0.5');
  $('#compare-label').textContent = on ? 'Your changes on' : 'Today (as listed)';
  if (on) renderMissingViews();
}
$('#compare').onclick = () => setView(view === 'after' ? 'orig' : 'after');

/* ================= drawers, tabs, panels ================= */
function closeDrawers() { document.querySelectorAll('[data-drawer-panel]').forEach((d) => d.classList.remove('open')); }
document.querySelectorAll('[data-drawer]').forEach((b) => b.onclick = () => {
  const d = document.querySelector(`[data-drawer-panel="${b.dataset.drawer}"]`), open = d.classList.contains('open');
  closeDrawers();
  if (!open) { d.classList.add('open'); if (b.dataset.drawer === 'outside' && !$('#aerial-thumb').src) $('#aerial-thumb').src = `/api/home/${H.id}/aerial.jpg`; }
});
document.querySelectorAll('[data-drawer-panel] [data-close]').forEach((b) => b.onclick = closeDrawers);
function switchView(v) {
  document.querySelectorAll('.view-tab').forEach((b) => b.className = 'view-tab px-4 py-1.5 rounded-full ' + (b.dataset.view === v ? 'bg-brand-600 text-white' : ''));
  $('#photos').classList.toggle('hidden', v !== 'photos');
}
document.querySelectorAll('.view-tab').forEach((b) => b.onclick = () => switchView(b.dataset.view));
const STATUS = { yes: ['✓', 'Yes'], likely: ['◐', 'Likely'], unknown: ['?', 'Unknown'], no: ['✕', 'No'] };
function renderAccess(d) {
  const wanted = NEEDS.length ? NEEDS : Object.keys(d.evidence);
  const ev = Object.entries(d.evidence).sort(([a], [b]) => wanted.includes(b) - wanted.includes(a));
  $('#evidence').innerHTML = ev.map(([k, v]) => `<li class="border border-slate-100 rounded-xl p-3 ${wanted.includes(k) ? '' : 'opacity-60'}">
    <div class="flex items-center gap-2"><span class="status-${v.status} font-bold">${STATUS[v.status][0]}</span><span class="font-medium">${esc(v.label)}</span>
    <span class="ml-auto text-xs status-${v.status} font-semibold">${STATUS[v.status][1]}</span></div>
    ${v.evidence ? `<div class="text-xs text-slate-500 mt-1">${esc(v.evidence)}</div>` : ''}</li>`).join('')
    + (d.scan?.findings || []).map((f) => `<li class="border border-brand-100 bg-brand-50/50 rounded-xl p-3 text-sm"><b>3D scan:</b> ${esc(f.evidence.replace('3D scan: ', ''))}</li>`).join('');
  const rooms = d.scan?.rooms || [];
  $('#rooms').innerHTML = rooms.map((r) => `<div class="flex justify-between border-t border-slate-100 py-1"><span>${esc(r.type)}</span><span class="text-slate-500">${r.width_ft ? `${r.width_ft.toFixed(1)} × ${(r.depth_ft || 0).toFixed(1)} ft` : ''}</span></div>`).join('');
  $('#score').textContent = d.match;
}
async function loadOutside() {
  const a = await fetch(`/api/home/${H.id}/aerial`).then((r) => r.json());
  const row = (k, v) => `<div class="bg-slate-50 rounded-xl p-2.5"><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold">${esc(v ?? '—')}</dd></div>`;
  $('#outside').innerHTML = a.found ? [row('Home footprint', a.footprint_sqft ? Math.round(a.footprint_sqft).toLocaleString() + ' sq ft' : null),
    row('Lot', H.lot_acres ? H.lot_acres.toFixed(2) + ' acres' : null), row('Shade trees', a.tree_cover_pct != null ? a.tree_cover_pct + '% cover' : null),
    row('Pool', a.pool ? 'Yes (fence it for safety)' : 'No'), row('Deck', a.deck ? 'Yes' : 'No'), row('Roof', a.roof)].join('')
    : '<p class="col-span-2 text-slate-500">No parcel data here.</p>';
}
let hintTimer;
function hint(html, ms) { const h = $('#hint'); h.innerHTML = html; h.style.opacity = 1; clearTimeout(hintTimer); if (ms) hintTimer = setTimeout(() => h.style.opacity = 0, ms); }

function welcome() {
  if (edits.length) { bubble(`Welcome back. Your ${edits.length} change${edits.length > 1 ? 's are' : ' is'} in the tour. Open <b>Changes</b> to turn them on or off.`); return; }
  const needs = NEEDS.map((k) => info?.evidence?.[k]?.label?.toLowerCase()).filter(Boolean);
  const el = bubble(`<div class="font-semibold">Hi! I'm your guide for this home.</div>
    <div class="text-sm text-slate-600 mt-1">${needs.length ? `You told me you need ${needs.join(', ')}. ` : ''}I can walk you room by room and show what this home would look like with the changes you need, with real prices.</div>
    <div class="mt-2 flex flex-wrap gap-2"><button data-go class="text-sm font-semibold bg-brand-600 text-white rounded-lg px-3 py-1.5 hover:bg-brand-700">Walk me through it</button>
    <button data-self class="text-sm border rounded-lg px-3 py-1.5 hover:bg-slate-50">I'll explore myself</button></div>`);
  el.querySelector('[data-go]').onclick = () => { el.querySelectorAll('button').forEach((b) => b.disabled = true); startAgent(); };
  el.querySelector('[data-self]').onclick = () => { el.querySelectorAll('button').forEach((b) => b.disabled = true);
    bubble('Great. Drag to look around; click the floor to move. When something should be different, click <b>✎ Change something</b>, circle it, and tell me what you want.'); };
}

(async () => {
  renderPlan();
  info = await fetch(`/api/home/${H.id}?needs=${NEEDS.join(',')}`).then((r) => r.json());
  renderAccess(info); loadOutside();
})();

/* hooks for the issue reporter (report.js) */
window.FD_SHOT = async () => {
  const W = iframe.clientWidth, Hh = iframe.clientHeight;
  const tour = sdk ? await soon(sdk.Renderer.takeScreenShot({ width: W, height: Hh }, { mattertags: false, sweeps: true }), 6000) : null;
  if (!tour) throw new Error('no tour');
  const img = new Image(); img.src = tour; await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, W, Hh);
  ctx.strokeStyle = '#7c5cff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  overlay.querySelectorAll('.sel-box').forEach((el) => ctx.strokeRect(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight));
  return c.toDataURL('image/png');
};
window.FD_CONTEXT = async () => ({
  home: { id: H.id, address: H.address, matterport: H.matterport_id }, needs: NEEDS, budget: BUDGET, view, mode, agentBusy,
  pose: poseCache && { sweep: poseCache.sweep, position: poseCache.position, rotation: poseCache.rotation, mode: poseCache.mode },
  room: currentRoom()?.label || null,
  selections: selections.map((s) => ({ label: s.label, rect: s.rect, poly: s.poly?.length, pose: s.pose && { sweep: s.pose.sweep, rotation: s.pose.rotation }, world: s.world })),
  edits: edits.map(({ options, crop, ...e }) => e),
  chat: [...document.querySelectorAll('#chat > div')].slice(-30).map((d) => d.innerText.slice(0, 600)),
});

$('#guide-min').onclick = () => { document.body.classList.add('guide-min'); $('#guide').classList.add('hidden'); $('#guide-open').classList.remove('hidden'); unread = 0; $('#guide-new').textContent = ''; };
$('#guide-open').onclick = () => { document.body.classList.remove('guide-min'); $('#guide').classList.remove('hidden'); $('#guide-open').classList.add('hidden'); $('#chat').scrollTop = 1e9; };
