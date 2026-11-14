/* Sandra's FrontDoor 3D tour.
 *
 * Edits are photoreal: the current view is edited by an image model, and the edited region is
 * projected back into the tour as a "photo patch", a textured quad placed along the camera's
 * own rays from the exact scan point it was rendered at. Looking around from that scan point it
 * lines up pixel-for-pixel with the real photo. When you move to another scan point that can see
 * the edit, the agent re-renders it from there (using the first render as a reference so it is
 * the same product), so the change is there wherever you walk.
 */
const H = window.HOME;
const NEEDS = (new URLSearchParams(location.search).get('needs') || '').split(',').filter(Boolean);
const STORE = `frontdoor-v2-${H.id}`;
const $ = (s, r = document) => r.querySelector(s);
const money = (n) => '$' + Math.round(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SDK camera promises can stall during the tour's intro animation; never let the agent hang on one.
const soon = (p, ms = 4000) => Promise.race([Promise.resolve(p).catch(() => null), sleep(ms)]);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

let sdk = null, info = null;
let mode = 'walk', view = 'after';
let poseCache = null, lastSweep = null;
let selections = [];            // current drag selections
let edits = [];                 // [{id,title,action,option,cost,world,ref,patches:[{sweep,corners,rid}],agent,on}]
const live = {};                // editId -> {box: node, patches: {sweepId: node}}
const pending = new Set();      // `${editId}@${sweep}` renders in flight
let chatHistory = [];
let agentBusy = false;

/* ---------------- boot ---------------- */
const iframe = $('#showcase');
iframe.src = `/bundle/showcase.html?m=${H.matterport_id}&play=1&qs=1&brand=0&help=0&mls=2&applicationKey=${encodeURIComponent(window.SDK_KEY)}`;
iframe.addEventListener('load', async () => {
  try {
    sdk = await iframe.contentWindow.MP_SDK.connect(iframe.contentWindow);
    await new Promise((res) => { const sub = sdk.App.state.subscribe((s) => { if (s.phase === sdk.App.Phase.PLAYING) { res(); setTimeout(() => sub.cancel()); } }); });
    window.hmSdk = sdk;
    await setupScene();
    await loadRooms();
    sdk.Camera.pose.subscribe(onPose);
    await restoreEdits();
    hint('Press <b>S</b> and drag around anything to change it.', 6000);
    if (!edits.length && NEEDS.length) offerAgent();
  } catch (e) { console.error(e); hint('3D tour failed to load: ' + (e.message || e)); }
});

/* ---------------- scene components ---------------- */
function PlanBox() {             // translucent outline of a planned change (Plan view)
  this.inputs = { w: 1, h: 1, d: 1, color: 0x22c55e, visible: true };
  this.onInit = function () {
    const T = this.context.three, g = new T.BoxGeometry(1, 1, 1);
    this.mesh = new T.Mesh(g, new T.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }));
    this.lines = new T.LineSegments(new T.EdgesGeometry(g), new T.LineBasicMaterial());
    const grp = new T.Group(); grp.add(this.mesh, this.lines);
    this.outputs.objectRoot = grp; this.apply();
  };
  this.apply = function () {
    const i = this.inputs;
    for (const o of [this.mesh, this.lines]) { o.scale.set(i.w, i.h, i.d); o.material.color.setHex(i.color); }
    this.outputs.objectRoot.visible = i.visible;
  };
  this.onInputsUpdated = function () { this.apply(); };
}

function PhotoPatch() {          // generated photo projected along the camera rays it was taken with
  this.inputs = { url: '', corners: [], visible: true };
  this.onInit = function () {
    const T = this.context.three;
    const c = this.inputs.corners;       // tl, tr, br, bl in world space
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([c[0], c[1], c[2], c[3]].flatMap((p) => [p.x, p.y, p.z]), 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 3, 1, 1, 3, 2]);
    const tex = new T.TextureLoader().load(this.inputs.url);
    if ('colorSpace' in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
    tex.anisotropy = 8;
    const mat = new T.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, toneMapped: false });
    this.mesh = new T.Mesh(geo, mat); this.mesh.renderOrder = 3000; this.mesh.frustumCulled = false;
    this.outputs.objectRoot = this.mesh; this.apply();
  };
  this.apply = function () { this.outputs.objectRoot.visible = this.inputs.visible; };
  this.onInputsUpdated = function () { this.apply(); };
}

async function setupScene() {
  await sdk.Scene.register('fd.planbox', () => new PlanBox());
  await sdk.Scene.register('fd.photo', () => new PhotoPatch());
}
async function addNode(component, inputs, place) {
  const [obj] = await sdk.Scene.createObjects(1);
  const n = obj.addNode();
  n.addComponent(component, inputs);
  place?.(n);
  obj.start();
  return n;
}
const comp = (n) => [...n.componentIterator()][0];

/* ---------------- camera math ---------------- */
// World-space ray direction through a screen pixel for a camera pose (Euler YXZ: yaw then pitch).
function rayDir(px, py, pose = poseCache) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, P = pose.projection;
  const nx = (px / W) * 2 - 1, ny = -((py / Hh) * 2 - 1);
  const x = (nx + (P ? P[8] : 0)) / (P ? P[0] : 1.2), y = (ny + (P ? P[9] : 0)) / (P ? P[5] : 1.2), z = -1;
  const pitch = pose.rotation.x * Math.PI / 180, yaw = pose.rotation.y * Math.PI / 180;
  const y2 = y * Math.cos(pitch) - z * Math.sin(pitch), z2 = y * Math.sin(pitch) + z * Math.cos(pitch);
  const x3 = x * Math.cos(yaw) + z2 * Math.sin(yaw), z3 = -x * Math.sin(yaw) + z2 * Math.cos(yaw);
  const L = Math.hypot(x3, y2, z3);
  return { x: x3 / L, y: y2 / L, z: z3 / L };
}
function patchCorners(rectN, pose = poseCache, d = 0.6) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, c = pose.position;
  const fwd = rayDir(W / 2, Hh / 2, pose);
  return [[rectN[0], rectN[1]], [rectN[2], rectN[1]], [rectN[2], rectN[3]], [rectN[0], rectN[3]]].map(([u, v]) => {
    const r = rayDir(u * W, v * Hh, pose);
    const k = d / (r.x * fwd.x + r.y * fwd.y + r.z * fwd.z);   // all corners on one plane facing the camera
    return { x: c.x + r.x * k, y: c.y + r.y * k, z: c.z + r.z * k };
  });
}
/* Point the camera at an exact rotation. Camera.setRotation is sometimes ignored by the SDK, so
   fall back to Camera.rotate (yaw changes by -h, pitch by +v) and verify we got there. */
async function lookAt(rot) {
  const off = () => { const c = poseCache.rotation; return { dy: ((rot.y - c.y + 540) % 360) - 180, dx: rot.x - c.x }; };
  for (let k = 0; k < 4; k++) {
    let { dy, dx } = off();
    if (Math.abs(dy) < 0.6 && Math.abs(dx) < 0.6) return true;
    await soon(sdk.Camera.rotate(-dy, dx, { speed: 10000 }), 2500); await sleep(250);
  }
  const { dy, dx } = off(); return Math.abs(dy) < 1.5 && Math.abs(dx) < 1.5;
}
async function hitAt(x, y) {
  try { const d = await sdk.Renderer.getWorldPositionData({ x, y }); return d && d.position ? d.position : null; } catch { return null; }
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

/* Measure what is inside a screen rectangle: raycast a grid, fit a box aligned to the house axes. */
async function worldFromRect(r) {
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
  const box = { x: center.x + lx * c + lz * s, y: floorY + h / 2, z: center.z - lx * s + lz * c };
  return { center: box, w, h, d, yaw, floorY, rise: Math.max(...ys) - Math.min(...ys) };
}

// Screen rectangle of a world box from a pose (null if not usefully visible).
function projectBox(world, pose = poseCache) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight;
  const c = Math.cos(world.yaw), s = Math.sin(world.yaw), xs = [], ys = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    const lx = dx * world.w / 2, lz = dz * world.d / 2;
    const p = { x: world.center.x + lx * c + lz * s, y: world.center.y + dy * world.h / 2, z: world.center.z - lx * s + lz * c };
    const q = sdk.Conversion.worldToScreen(p, pose, { w: W, h: Hh });
    if (!q || q.z > 1 || q.z < -1) return null;          // behind the camera
    xs.push(q.x); ys.push(q.y);
  }
  const full = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  const r = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(W, Math.max(...xs)), y1: Math.min(Hh, Math.max(...ys)) };
  if (r.x1 - r.x0 < 50 || r.y1 - r.y0 < 50 || (r.x1 - r.x0) * (r.y1 - r.y0) < 0.3 * full) return null;
  return r;
}

/* ---------------- rooms ---------------- */
let sweepList = [], roomList = [], roomIdx = 0;
async function collect(obs) {
  const out = [];
  // the first update can arrive empty while the model is still loading; wait for real data
  let sub;
  await Promise.race([new Promise((r) => { sub = obs.subscribe({ onCollectionUpdated: (c) => {
    const v = Object.values(c); if (v.length) { out.splice(0, out.length, ...v); r(); } } }); }), sleep(10000)]);
  setTimeout(() => sub?.cancel?.());
  return out;
}
async function loadRooms() {
  sweepList = await collect(sdk.Sweep.data);
  let rooms = await collect(sdk.Room.data).catch(() => []);
  if (!rooms.filter((r) => r.label).length) {         // SDK room feed is sometimes empty: use the Matterport API rooms (same ids)
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
  await sdk.Sweep.moveTo(centerSweep(roomList[roomIdx]).id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }).catch(() => {});
}
$('#room-prev').onclick = () => { stopAgent(); goRoom(roomIdx - 1); };
$('#room-next').onclick = () => { stopAgent(); goRoom(roomIdx + 1); };
$('#room-name').onclick = () => {
  const m = $('#room-menu');
  m.innerHTML = roomList.map((r, i) => `<button data-i="${i}" class="block w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/15">${r.label}</button>`).join('');
  m.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { m.classList.add('hidden'); goRoom(+b.dataset.i); });
  m.classList.toggle('hidden');
};

/* ---------------- pose: show this scan point's patches, render views that are missing ---------------- */
let settleTimer = null;
function onPose(p) {
  poseCache = p;
  if (p.sweep !== lastSweep) {
    lastSweep = p.sweep;
    const r = currentRoom(); if (r) roomIdx = roomList.indexOf(r);
    $('#room-name').textContent = r ? r.label : 'Between rooms';
    refreshVisibility();
  }
  overlay.querySelectorAll('.sel-box').forEach((e) => e.remove());
  clearTimeout(settleTimer);
  settleTimer = setTimeout(renderMissingViews, 1100);
}
function refreshVisibility() {
  for (const e of edits) {
    const L = live[e.id]; if (!L) continue;
    if (L.box) { comp(L.box).inputs.visible = e.on !== false && (view === 'plan' || (e.status && e.status !== 'done' && e.status !== 'failed')); comp(L.box).onInputsUpdated(); }
    for (const [sw, n] of Object.entries(L.patches)) {
      comp(n).inputs.visible = view === 'after' && sw === lastSweep && e.on !== false;
      comp(n).onInputsUpdated();
    }
  }
}
// Re-render a change from a new scan point only when it is clearly in view: same room (or very
// close), large enough on screen, and not hidden behind a wall. Far, tiny or occluded views
// produce floating, wrong-looking patches, so those are skipped.
async function renderMissingViews() {
  if (!sdk || agentBusy || view !== 'after' || !poseCache) return;
  const pose = poseCache, W = iframe.clientWidth, Hh = iframe.clientHeight;
  for (const e of edits) {
    if (e.on === false || !e.world || (e.status && e.status !== 'done') || e.patches.some((p) => p.sweep === pose.sweep)) continue;
    const key = `${e.id}@${pose.sweep}`;
    const d = dist(pose.position, e.world.center);
    const sameRoom = e.roomId && currentRoom()?.id === e.roomId;
    if (pending.has(key) || d > 4.5 || (!sameRoom && d > 2.5)) continue;
    const r = projectBox(e.world, pose);
    if (!r || (r.x1 - r.x0) < 160 || (r.y1 - r.y0) < 140 || (r.x1 - r.x0) * (r.y1 - r.y0) < 0.06 * W * Hh) continue;
    let clear = 0;                                                          // a wall in between?
    for (const [u, v] of [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.7], [0.7, 0.7]]) {
      const hit = await hitAt(r.x0 + (r.x1 - r.x0) * u, r.y0 + (r.y1 - r.y0) * v);
      if (hit && dist(pose.position, hit) > d - Math.max(e.world.w, e.world.d) * 0.75) clear++;
    }
    if (clear < 4 || pose.sweep !== poseCache.sweep) continue;
    pending.add(key);
    status(`Rendering “${e.title}” from this spot…`);
    try { await renderPatch(e, r, pose); } catch (err) { console.warn(err); }
    pending.delete(key); status('');
  }
}

/* ---------------- photoreal render ----------------
 * A selection captures the exact frame and camera pose the moment you make it. Renders use that
 * captured frame, never "whatever is on screen now", so you can keep walking while they run in the
 * background, and a change can never land on the wrong view. */
async function grabFrame() {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, k = Math.min(2, 1600 / W);
  return sdk.Renderer.takeScreenShot({ width: Math.round(W * k), height: Math.round(Hh * k) }, { mattertags: false, sweeps: false });
}
const snapPose = (p = poseCache) => ({ sweep: p.sweep, position: { ...p.position }, rotation: { ...p.rotation },
  projection: p.projection ? Array.from(p.projection) : null, W: iframe.clientWidth, H: iframe.clientHeight });
function taskText(e) {
  const what = e.custom || (e.option ? `${e.option.name} (${e.option.spec})` : e.title);
  if (e.action === 'remove') return `Remove ${e.item || 'the selected item'} completely and fill the space with the surrounding floor and wall. ${e.custom || ''}`;
  if (e.action === 'add') return `Install ${what} here. Purpose: ${e.title}.`;
  return `Replace ${e.item || 'what is in the masked area'} with ${what}. Purpose: ${e.title}.`;
}
// r: {x0,y0,x1,y1} in css px of the view `pose` was taken at; poly: optional lasso points (css px)
async function renderPatch(e, r, pose, image, poly) {
  pose = pose || snapPose();
  const W = pose.W || iframe.clientWidth, Hh = pose.H || iframe.clientHeight;
  image = image || await grabFrame();
  const meta = await fetch(`/api/home/${H.id}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, rect: [r.x0 / W, r.y0 / Hh, r.x1 / W, r.y1 / Hh], task: taskText(e), ref: e.ref || null,
      poly: poly ? poly.map(([x, y]) => [x / W, y / Hh]) : null }) }).then((x) => x.json());
  if (meta.error) throw new Error(meta.error);
  if (!e.ref) e.ref = meta.id;
  const p = { sweep: pose.sweep, rid: meta.id, corners: patchCorners(meta.rect, pose), rot: { ...pose.rotation } };
  e.patches.push(p); e.thumb = meta.id; save();
  await mountPatch(e, p);
  refreshVisibility();
  return meta;
}
async function mountPatch(e, p) {
  const n = await addNode('fd.photo', { url: `/api/home/${H.id}/render/${p.rid}/patch`, corners: p.corners, visible: false });
  (live[e.id] ||= { patches: {} }).patches[p.sweep] = n;
}
const BOX_COLOR = { pending: 0x7c5cff, add: 0x22c55e, remove: 0xef4444, replace: 0xf59e0b };
async function mountBox(e) {
  const w = e.world; if (!w) return;
  const n = await addNode('fd.planbox', { w: w.w, h: w.h, d: w.d, color: BOX_COLOR[e.status === 'done' ? e.action : 'pending'] || BOX_COLOR.replace, visible: true }, (n) => {
    n.position.set(w.center.x, w.center.y, w.center.z);
    n.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, w.yaw);
  });
  (live[e.id] ||= { patches: {} }).box = n;
}
function boxColor(e) {
  const n = live[e.id]?.box; if (!n) return;
  const c = comp(n); c.inputs.color = e.status === 'done' ? (BOX_COLOR[e.action] || BOX_COLOR.replace) : BOX_COLOR.pending; c.onInputsUpdated();
}

/* ---------------- jobs: several changes can be in flight while you keep touring ---------------- */
let jobsRunning = 0;
const selFor = new Map();   // editId -> selection (keeps the captured frame in memory for re-renders)
const applying = false;    // kept for the issue reporter's context
function jobStatus() {
  const n = edits.filter((e) => e.status === 'analyzing' || e.status === 'rendering').length;
  status(n ? `${n} change${n > 1 ? 's' : ''} in progress. Keep exploring, they'll appear when ready.` : '');
}
function newEdit(sel, fields) {
  const e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: 'Working on it…', action: 'replace',
    item: sel.item || '', option: null, custom: '', options: [], world: sel.world, cost: 0, patches: [], agent: false, on: true,
    room: sel.roomLabel || '', roomId: sel.roomId || null, status: 'analyzing', crop: sel.crop, ...fields };
  selFor.set(e.id, sel);
  edits.push(e); save(); renderPlan(); jobStatus();
  if (sel.marker) { (live[e.id] ||= { patches: {} }).box = sel.marker; sel.marker = null; } else mountBox(e);
  return e;
}
// Render an edit from the selection's captured frame (no camera movement needed).
async function runRender(e, sel) {
  e.status = 'rendering'; boxColor(e); save(); renderPlan(); jobStatus();
  jobsRunning++;
  try {
    const r = { x0: sel.rect.x, y0: sel.rect.y, x1: sel.rect.x + sel.rect.w, y1: sel.rect.y + sel.rect.h };
    const meta = await renderPatch(e, r, sel.pose, sel.frame, sel.poly);
    e.status = 'done'; boxColor(e); save(); refreshVisibility();
    return meta;
  } catch (err) {
    e.status = 'failed'; e.error = err.message; save();
    return null;
  } finally { jobsRunning--; renderPlan(); jobStatus(); }
}
// Used by option cards and the agent: create + render in one go.
async function applyChange(sel, change, option, custom, agent = false) {
  const e = newEdit(sel, { title: change.title, action: change.action, item: sel.item || change.item || '', option: option || null,
    custom: custom || '', options: change.options || [], cost: option ? option.total : 0, agent, status: 'rendering' });
  const meta = await runRender(e, sel);
  sel.box?.remove();
  return { e, meta };
}
// A direct command on a selection ("remove it", "replace with ..."): analyze, pick the standard option, render. No extra clicks.
async function command(sel, instruction, label) {
  hideMenu();
  sel.box?.remove(); selections = selections.filter((x) => x !== sel); renderSelChips();   // it's a change now, tracked in Changes
  const e = newEdit(sel, { title: label || instruction });
  bubble(`<div class="flex gap-3 items-center"><img src="${sel.crop}" class="w-10 h-10 rounded-lg object-cover shrink-0">
    <div class="text-sm"><b>${label || instruction}</b><div class="text-slate-500">Working on it in the background. Keep exploring; it shows up in <b>Changes</b> and in the tour when ready.</div></div></div>`);
  try {
    const res = await fetch(`/api/home/${H.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crop: sel.crop, full: sel.full, instruction, room: sel.roomLabel, needs: NEEDS,
        size: sel.world && { w: sel.world.w, h: sel.world.h, d: sel.world.d, rise: sel.world.rise } }) }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    const c = (res.changes || [])[0];
    if (!c) throw new Error('no change proposed');
    const opt = (c.options || [])[Math.min(1, (c.options || []).length - 1)] || null;
    Object.assign(e, { title: c.title, action: c.action, item: res.items?.[0]?.name || sel.item || '', options: c.options || [], option: opt,
      cost: opt?.total || 0, custom: /replace|add|install|put/i.test(instruction) ? instruction : '' });
    sel.item = e.item;
    await runRender(e, sel);
  } catch (err) {
    e.status = 'failed'; e.error = err.message; save(); renderPlan(); jobStatus();
  }
}

/* ---------------- selection: box or lasso, kept pinned in 3D, with an action menu ---------------- */
const overlay = $('#overlay');
let drag = null, tool = 'lasso';
function setMode(m) {
  mode = m;
  overlay.style.pointerEvents = m === 'select' ? 'auto' : 'none';
  overlay.style.cursor = m === 'select' ? 'crosshair' : '';
  $('#mode-select').className = 'px-4 py-2 rounded-full ' + (m === 'select' ? 'bg-brand-600 text-white' : '');
  $('#mode-walk').className = 'px-4 py-2 rounded-full ' + (m === 'walk' ? 'bg-ink text-white' : '');
  $('#tool-pick').classList.toggle('hidden', m !== 'select');
  if (m === 'select') { stopAgent(); hint(tool === 'lasso' ? 'Draw around what you want to change. <b>Shift</b> adds more.' : 'Drag a box around what you want to change. <b>Shift</b> adds more.', 5000); }
  else hideMenu();
}
function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll('[data-tool-pick]')) b.className = 'px-3 py-1.5 rounded-full ' + (b.dataset.toolPick === t ? 'bg-white text-ink' : 'text-white');
}
document.querySelectorAll('[data-tool-pick]').forEach((b) => b.onclick = () => setTool(b.dataset.toolPick));
$('#mode-walk').onclick = () => setMode('walk');
$('#mode-select').onclick = () => setMode('select');
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === 's' || e.key === 'S') setMode('select');
  if (e.key === 'w' || e.key === 'W') setMode('walk');
  if (e.key === 'Escape') clearSelections();
});
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
    drag.path.setAttribute('fill', 'rgba(124,92,255,.18)'); drag.path.setAttribute('stroke', '#7c5cff'); drag.path.setAttribute('stroke-width', '2.5');
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
  if (r.w < 14 || r.h < 14) { r = { x: d.x0 - 70, y: d.y0 - 70, w: 140, h: 140 }; poly = null; }
  if (!d.add) clearSelections(true);
  await makeSelection(r, poly);
});
function cropOf(img, r, max = 640) {
  const k = img.naturalWidth / iframe.clientWidth, c = document.createElement('canvas');
  const s = Math.min(1, max / (Math.max(r.w, r.h) * k));
  c.width = Math.max(1, r.w * k * s); c.height = Math.max(1, r.h * k * s);
  c.getContext('2d').drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
// Freeze everything a later render needs: frame, pose, 3D box, crop. Then pin a highlight in 3D and open the menu.
async function makeSelection(r, poly = null, opts = {}) {
  const pose = snapPose();
  const outline = screenOutline(r, poly, opts.label || 'Selected');
  const [frame, world] = await Promise.all([grabFrame(), worldFromRect(r)]);
  const img = new Image(); img.src = frame; await img.decode();
  const sel = { id: 's' + Date.now(), rect: r, poly, frame, pose, world, box: outline, crop: cropOf(img, r),
    full: cropOf(img, { x: 0, y: 0, w: pose.W, h: pose.H }, 1000), item: opts.item || '', label: opts.label || 'Selection',
    roomLabel: currentRoom()?.label || '', roomId: currentRoom()?.id || null };
  if (world) sel.marker = await addNode('fd.planbox', { w: world.w, h: world.h, d: world.d, color: BOX_COLOR.pending, visible: true }, (n) => {
    n.position.set(world.center.x, world.center.y, world.center.z); n.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, world.yaw);
  });
  selections.push(sel); renderSelChips();
  if (!opts.silent) showMenu(sel);
  return sel;
}
function screenOutline(r, poly, label) {
  const el = document.createElement('div');
  el.className = 'sel-box pending';
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  if (poly) {
    el.style.border = 'none'; el.style.background = 'none';
    el.innerHTML = `<svg class="absolute inset-0 overflow-visible" width="${r.w}" height="${r.h}"><path d="M${poly.map(([x, y]) => `${x - r.x},${y - r.y}`).join('L')}Z" fill="rgba(124,92,255,.16)" stroke="#7c5cff" stroke-width="2.5" stroke-dasharray="7 5"/></svg>`;
  }
  el.insertAdjacentHTML('beforeend', `<span class="sel-label">${label}</span>`);
  overlay.appendChild(el); return el;
}
function clearSelections(keepMarkers = false) {
  for (const s of selections) { s.box?.remove(); if (!keepMarkers && s.marker) { s.marker.stop(); s.marker = null; } }
  if (keepMarkers) for (const s of selections) if (s.marker) { s.marker.stop(); s.marker = null; }
  selections = []; renderSelChips(); hideMenu();
}
function renderSelChips() {
  $('#sel-chips').innerHTML = selections.map((s) => `<span class="inline-flex items-center gap-1.5 text-xs font-medium bg-brand-50 text-brand-700 rounded-full pl-1 pr-1 py-1">
    <img src="${s.crop}" class="w-6 h-6 rounded-full object-cover">${s.label}<button data-x="${s.id}" class="w-5 h-5 rounded-full hover:bg-brand-100" aria-label="Remove selection">✕</button></span>`).join('');
  $('#sel-chips').querySelectorAll('[data-x]').forEach((b) => b.onclick = () => {
    const s = selections.find((x) => x.id === b.dataset.x); s?.box?.remove(); s?.marker?.stop();
    selections = selections.filter((x) => x.id !== b.dataset.x); renderSelChips(); hideMenu();
  });
}

/* the floating action menu next to a selection (tap-and-hold style) */
function hideMenu() { $('#sel-menu')?.remove(); }
function showMenu(sel) {
  hideMenu();
  const m = document.createElement('div');
  m.id = 'sel-menu';
  m.className = 'absolute z-40 w-64 bg-white/95 backdrop-blur rounded-2xl shadow-2xl ring-1 ring-black/5 overflow-hidden text-[15px] text-ink';
  const left = Math.min(overlay.clientWidth - 270, Math.max(8, sel.rect.x + sel.rect.w + 10));
  const top = Math.min(overlay.clientHeight - 300, Math.max(8, sel.rect.y));
  Object.assign(m.style, { left: left + 'px', top: top + 'px' });
  const row = (k, label, icon) => `<button data-act="${k}" class="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-100 border-t border-slate-100">${label}<span class="text-slate-400">${icon}</span></button>`;
  m.innerHTML = `<div class="flex items-center gap-2 px-3 py-2 bg-slate-50"><img src="${sel.crop}" class="w-8 h-8 rounded-md object-cover"><span class="font-semibold text-sm truncate" data-label>${sel.label}</span>
      <button data-act="close" class="ml-auto text-slate-400 hover:text-ink" aria-label="Close menu">✕</button></div>
    ${row('remove', 'Remove it', '🗑')}${row('replace', 'Replace with…', '⇄')}${row('add', 'Add here…', '＋')}${row('suggest', 'What would help here?', '✦')}
    <form data-say class="hidden border-t border-slate-100 p-2 flex gap-1.5"><input class="flex-1 min-w-0 text-sm border rounded-lg px-2 py-1.5 outline-none focus:border-brand-500"><button class="text-sm font-semibold bg-brand-600 text-white rounded-lg px-3">Go</button></form>
    <form data-free class="border-t border-slate-100 p-2 flex gap-1.5"><input class="flex-1 min-w-0 text-sm border rounded-lg px-2 py-1.5 outline-none focus:border-brand-500" placeholder="Or tell the agent…"><button class="text-sm font-semibold bg-ink text-white rounded-lg px-3">↵</button></form>`;
  overlay.appendChild(m);
  let pending = null;
  const say = m.querySelector('[data-say]'), sayIn = say.querySelector('input');
  m.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'close') return hideMenu();
    if (a === 'remove') return command(sel, 'Remove this completely', `Remove ${sel.item || 'it'}`);
    if (a === 'suggest') { hideMenu(); return analyze(sel); }
    pending = a; say.classList.remove('hidden');
    sayIn.placeholder = a === 'replace' ? 'e.g. a curbless walk-in shower with a seat' : 'e.g. grab bars, a ramp, a bench';
    sayIn.focus();
  });
  say.onsubmit = (ev) => { ev.preventDefault(); const t = sayIn.value.trim(); if (!t) return;
    command(sel, pending === 'replace' ? `Replace this with: ${t}` : `Add here: ${t}`, `${pending === 'replace' ? 'Replace with' : 'Add'} ${t}`); };
  m.querySelector('[data-free]').onsubmit = (ev) => { ev.preventDefault(); const t = ev.currentTarget.querySelector('input').value.trim(); if (t) command(sel, t, t); };
  // label the selection once the agent knows what it is (cheap: reuse the analyze endpoint lazily only on demand)
}

/* ---------------- chat + change cards with priced product options ---------------- */
function bubble(html, who = 'ai') {
  const el = document.createElement('div');
  el.className = who === 'user' ? 'flex justify-end' : 'flex';
  el.innerHTML = who === 'user' ? `<div class="max-w-[85%] bg-brand-100 text-brand-900 rounded-2xl rounded-br-md px-4 py-2.5">${html}</div>`
    : `<div class="w-full bg-slate-50 border border-slate-100 rounded-2xl rounded-bl-md px-4 py-3 text-[15px]">${html}</div>`;
  $('#chat').appendChild(el); $('#chat').scrollTop = 1e9; return el;
}
const thinking = (t = 'Thinking') => bubble(`<span class="dots text-slate-500">${t}<span>.</span><span>.</span><span>.</span></span>`);
const compareHtml = (rid) => `<div class="mt-2 grid grid-cols-2 gap-1.5 text-[11px] text-slate-500">
  <figure><img src="/api/home/${H.id}/render/${rid}/before" class="rounded-lg"><figcaption>Before</figcaption></figure>
  <figure><img src="/api/home/${H.id}/render/${rid}/after" class="rounded-lg"><figcaption>After</figcaption></figure></div>`;

function changeCard(sel, c) {
  const id = 'c' + Math.random().toString(36).slice(2, 8), opts = c.options || [];
  let pick = Math.min(1, Math.max(0, opts.length - 1));
  const detail = (o) => o ? `<div class="font-medium text-slate-800">${o.name}</div>
      <div class="text-xs text-slate-500">Item ${money(o.material)} · Labor ${money(o.labor)} (${o.labor_hours} h × ${money(o.labor_rate)}/h)</div>
      ${o.notes ? `<div class="text-xs text-slate-400 mt-0.5">${o.notes}</div>` : ''}` : '';
  setTimeout(() => {
    const root = document.getElementById(id); if (!root) return;
    root.querySelectorAll('[data-tier]').forEach((b) => b.onclick = () => {
      pick = +b.dataset.tier;
      root.querySelectorAll('[data-tier]').forEach((x) => x.className = tierCls(+x.dataset.tier === pick));
      root.querySelector('[data-detail]').innerHTML = detail(opts[pick]);
    });
    root.querySelector('[data-own]').onclick = (ev) => { ev.currentTarget.remove(); root.querySelector('[data-custom]').classList.remove('hidden'); root.querySelector('[data-custom]').focus(); };
    root.querySelector('[data-apply]').onclick = async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.innerHTML = '<span class="dots">Rendering into the home<span>.</span><span>.</span><span>.</span></span>';
      const { meta } = await applyChange(sel, c, opts[pick], root.querySelector('[data-custom]').value.trim());
      b.textContent = meta ? '✓ In your plan, shown in the tour' : 'Try again'; b.disabled = !!meta;
      if (meta) { b.className = 'mt-2 w-full text-sm font-semibold bg-emerald-50 text-emerald-700 rounded-lg px-3 py-2'; root.insertAdjacentHTML('beforeend', compareHtml(meta.id)); }
    };
  });
  const tierCls = (on) => 'rounded-lg border px-2 py-1.5 text-left transition ' + (on ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-brand-300');
  const tag = { remove: 'Remove', add: 'Add', replace: 'Replace' }[c.action] || c.action;
  return `<div id="${id}" class="mt-3 border border-slate-200 bg-white rounded-xl p-3">
    <div class="flex items-center gap-2"><span class="text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">${tag}</span>
      <span class="font-semibold leading-tight">${c.title || ''}</span></div>
    ${c.reason ? `<div class="text-xs text-slate-500 mt-1 line-clamp-2">${c.reason}</div>` : ''}
    ${opts.length ? `<div class="mt-2 grid grid-cols-${Math.min(3, opts.length)} gap-1.5">${opts.map((o, i) => `<button type="button" data-tier="${i}" class="${tierCls(i === pick)}">
        <div class="text-[11px] text-slate-500">${o.tier}</div><div class="font-bold text-sm">${money(o.total)}</div></button>`).join('')}</div>
      <div data-detail class="mt-2 text-sm">${detail(opts[pick])}</div>` : ''}
    <button data-own class="mt-1 text-xs text-brand-700 hover:underline">Describe your own instead</button>
    <input data-custom class="hidden mt-2 w-full text-sm border rounded-lg px-2.5 py-1.5" placeholder="e.g. white wall-hung sink, 34 in high">
    <button data-apply class="mt-2 w-full text-sm font-semibold bg-ink text-white rounded-lg px-3 py-2 hover:bg-brand-700">Preview in this home</button></div>`;
}
async function analyze(sel, instruction) {
  const t = thinking('Looking at your selection');
  try {
    const res = await fetch(`/api/home/${H.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crop: sel.crop, full: sel.full, instruction, room: sel.roomLabel, needs: NEEDS,
        size: sel.world && { w: sel.world.w, h: sel.world.h, d: sel.world.d, rise: sel.world.rise } }) }).then((r) => r.json());
    t.remove();
    if (res.error) { bubble(`<span class="text-red-600">${res.error}</span>`); return; }
    sel.item = res.items?.[0]?.name || ''; sel.label = sel.item || 'Selection';
    const lbl = sel.box?.querySelector('.sel-label'); if (lbl) lbl.textContent = sel.label;
    renderSelChips();
    bubble(`<div class="flex gap-3 items-start"><img src="${sel.crop}" class="w-12 h-12 rounded-lg object-cover shrink-0">
      <div class="text-sm"><div class="font-semibold">${sel.label}</div><div class="text-slate-600">${res.summary || ''}</div>
      ${(res.items || []).length ? `<details class="mt-1 text-xs text-slate-500"><summary class="cursor-pointer">What I see</summary><ul class="mt-1 list-disc pl-4">${res.items.map((i) => `<li><b>${i.name}</b>: ${i.observation}</li>`).join('')}</ul></details>` : ''}</div></div>
      ${(res.changes || []).map((c) => changeCard(sel, c)).join('')}`);
    chatHistory.push({ role: 'assistant', content: `Selection "${sel.label}": ${res.summary}` });
  } catch { t.remove(); bubble('<span class="text-red-600">Could not analyze that selection.</span>'); }
}
$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#chat-input').value.trim(); if (!msg) return;
  $('#chat-input').value = ''; stopAgent();
  bubble(msg, 'user'); chatHistory.push({ role: 'user', content: msg });
  if (selections.length) { for (const s of selections) await analyze(s, msg); return; }
  if (CHANGE_RE.test(msg)) { await findInView(msg); return; }   // no selection: find what they mean in the current view
  const t = thinking();
  const res = await fetch(`/api/home/${H.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, history: chatHistory, edits: edits.map((e) => `${e.title} (${money(e.cost)})`) }) }).then((r) => r.json());
  t.remove(); bubble((res.reply || '').replace(/\n/g, '<br>')); chatHistory.push({ role: 'assistant', content: res.reply });
});

const CHANGE_RE = /(make|turn|change|replace|remove|add|convert|swap|put|install|get rid|widen|lower|raise|build|design|walk-?in|ramp|grab bar|stairlift|seat|door)/i;
async function findInView(msg) {
  const t = thinking('Finding that in your view');
  const image = await grabFrame();
  const plan = await fetch(`/api/home/${H.id}/agent/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ views: [{ image, room: currentRoom()?.label || '' }], needs: NEEDS, instruction: msg,
      persona: sessionStorage.getItem('fd-persona') || '' }) }).then((r) => r.json()).catch(() => ({}));
  t.remove();
  const f = (plan.findings || [])[0];
  if (!f?.box_2d) { bubble(`I couldn't spot that in this view. Turn toward it, or click <b>Select to change</b> and drag a box around it.`); return; }
  const W = iframe.clientWidth, Hh = iframe.clientHeight, b = f.box_2d;
  const rect = { x: b[1] / 1000 * W, y: b[0] / 1000 * Hh, w: (b[3] - b[1]) / 1000 * W, h: (b[2] - b[0]) / 1000 * Hh };
  clearSelections();
  const sel = await makeSelection(rect, null, { item: f.item, label: f.item || 'Found', silent: true });
  bubble(`<div class="flex gap-3 items-start"><img src="${sel.crop}" class="w-12 h-12 rounded-lg object-cover shrink-0">
    <div class="text-sm"><div class="font-semibold">${f.item || ''}</div><div class="text-slate-600">${f.issue || ''}</div></div></div>${changeCard(sel, f)}`);
}

/* ---------------- agent first pass (only when you ask; stops as soon as you take over) ---------------- */
const ROOM_PRIORITY = [/bath/i, /stair|hall/i, /bedroom/i, /kitchen/i, /laundry/i, /garage|entry|foyer/i];
let agentAbort = false;
function agentRooms() {
  const picks = [];
  for (const re of ROOM_PRIORITY) for (const r of roomList) if (re.test(r.label) && !picks.includes(r)) picks.push(r);
  return picks.filter((r) => !/closet|pantry/i.test(r.label)).slice(0, 3);
}
function offerAgent() {
  const el = bubble(`<div class="font-semibold">Want me to check this home for you?</div>
    <div class="text-sm text-slate-600 mt-0.5">I'll walk the bathrooms and bedrooms, find what doesn't fit your needs and show the fixes with prices. It takes about a minute and moves the tour while it works.</div>
    <div class="mt-2 flex gap-2"><button data-go class="text-sm font-semibold bg-brand-600 text-white rounded-lg px-3 py-1.5 hover:bg-brand-700">Check this home</button>
    <button data-no class="text-sm text-slate-600 rounded-lg px-3 py-1.5 hover:bg-slate-100">I'll look myself</button></div>`);
  el.querySelector('[data-go]').onclick = () => { el.remove(); startAgent(); };
  el.querySelector('[data-no]').onclick = () => el.remove();
}
function stopAgent() { if (agentBusy) agentAbort = true; }
async function startAgent() {
  if (agentBusy || !roomList.length) return;
  agentBusy = true; agentAbort = false; setMode('walk');
  try { await runAgent(); } catch (err) { console.error(err); bubble(`<span class="text-red-600">Agent stopped: ${err.message}</span>`); }
  finally { agentBusy = false; renderMissingViews(); }
}
async function runAgent() {
  for (let i = 0; i < 50 && !poseCache; i++) await sleep(100);
  await sleep(1200);
  const startSweep = lastSweep, startRot = { ...poseCache.rotation };
  const rooms = agentRooms();
  const log = bubble(`<div class="flex items-center"><div class="font-semibold">Checking ${rooms.map((r) => r.label).join(', ')}</div>
    <button data-stop class="ml-auto text-xs text-slate-500 hover:text-red-600 border rounded-md px-2 py-0.5">Stop</button></div><ul class="mt-2 text-sm space-y-2" data-steps></ul>`);
  log.querySelector('[data-stop]').onclick = () => { agentAbort = true; };
  const step = (t) => { const li = document.createElement('li'); li.innerHTML = t; log.querySelector('[data-steps]').appendChild(li); $('#chat').scrollTop = 1e9; return li; };
  let found = 0;
  for (const room of rooms) {
    if (agentAbort) break;
    const li = step(`<span class="dots">${room.label}: looking around<span>.</span><span>.</span><span>.</span></span>`);
    await soon(sdk.Sweep.moveTo(centerSweep(room).id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 600 }));
    await sleep(900);
    const views = [];
    for (let k = 0; k < 4 && !agentAbort; k++) {
      await lookAt({ x: -18, y: k * 90 }); await sleep(450);
      views.push({ image: await soon(sdk.Renderer.takeScreenShot({ width: 768, height: 576 }, { mattertags: false, sweeps: false }), 8000), room: room.label, rot: { x: -18, y: k * 90 } });
    }
    if (agentAbort) { li.remove(); break; }
    const plan = await fetch(`/api/home/${H.id}/agent/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views, needs: NEEDS, persona: sessionStorage.getItem('fd-persona') || '' }) }).then((r) => r.json()).catch(() => ({}));
    if (agentAbort) { li.remove(); break; }
    const f = (plan.findings || [])[0];
    if (!f) { li.innerHTML = `✓ ${room.label}: fine as is`; continue; }
    li.innerHTML = `<span class="dots">${room.label}: ${f.item}. Rendering <b>${f.title}</b><span>.</span><span>.</span><span>.</span></span>`;
    await lookAt(views[f.view]?.rot || views[0].rot); await sleep(700);
    const W = iframe.clientWidth, Hh = iframe.clientHeight, b = f.box_2d || [300, 300, 700, 700];
    const rect = { x: b[1] / 1000 * W, y: b[0] / 1000 * Hh, w: (b[3] - b[1]) / 1000 * W, h: (b[2] - b[0]) / 1000 * Hh };
    const sel = await makeSelection(rect, null, { item: f.item, label: f.item, silent: true });
    selections = selections.filter((x) => x !== sel); renderSelChips();
    const opt = (f.options || [])[1] || (f.options || [])[0];
    const { meta } = await applyChange(sel, f, opt, '', true);
    found += meta ? 1 : 0;
    li.innerHTML = meta ? `✅ ${room.label}: <b>${f.title}</b>, ${opt?.name || ''} (${money(opt?.total)})${compareHtml(meta.id)}` : `⚠️ ${room.label}: couldn't render ${f.title}`;
  }
  if (agentAbort) { step('Stopped. The tour is yours.'); return; }
  step(found ? `<b>${found} change${found > 1 ? 's' : ''}</b> added. Walk around to see them; swap products or switch them off in <b>Plan</b>.` : 'Nothing to change for your needs.');
  await soon(sdk.Sweep.moveTo(startSweep, { transition: sdk.Sweep.Transition.FLY, transitionTime: 600 }));
  await lookAt(startRot);
}
$('#agent-run').onclick = () => startAgent();

/* ---------------- plan / persistence ---------------- */
function save() { try { localStorage.setItem(STORE, JSON.stringify(edits)); } catch {} }
async function restoreEdits() {
  try { edits = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { edits = []; }
  for (const e of edits) {
    if (e.status === 'analyzing' || e.status === 'rendering') { e.status = e.patches.length ? 'done' : 'failed'; e.error = e.error || 'interrupted by a page reload'; }
    await mountBox(e); for (const p of e.patches) await mountPatch(e, p);
  }
  refreshVisibility(); renderPlan();
}
function removeEdit(id) {
  const L = live[id];
  if (L) { L.box?.stop(); Object.values(L.patches).forEach((n) => n.stop()); delete live[id]; }
  edits = edits.filter((e) => e.id !== id); save(); renderPlan();
}
function swapOption(id, i) {     // a different product: drop old renders, re-render where you stand
  const e = edits.find((x) => x.id === id); if (!e || !e.options[i]) return;
  e.option = e.options[i]; e.cost = e.option.total; e.ref = null;
  const L = live[id]; Object.values(L?.patches || {}).forEach((n) => n.stop()); if (L) L.patches = {};
  e.patches = []; save(); renderPlan();
  const sel = selFor.get(id);
  if (sel) runRender(e, sel); else renderMissingViews();   // re-render from the original view if we still have it
}
function renderPlan() {
  const on = edits.filter((e) => e.on !== false);
  const total = on.reduce((s, e) => s + (e.cost || 0), 0), labor = on.reduce((s, e) => s + (e.option?.labor || 0), 0);
  $('#plan-count').textContent = edits.length;
  const pill = (e) => ({ analyzing: '<span class="text-[11px] font-semibold text-brand-700 bg-brand-50 rounded-full px-2 py-0.5 animate-pulse">Thinking…</span>',
    rendering: '<span class="text-[11px] font-semibold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5 animate-pulse">Rendering…</span>',
    failed: `<span class="text-[11px] font-semibold text-red-700 bg-red-50 rounded-full px-2 py-0.5" title="${(e.error || '').replace(/"/g, '')}">Failed</span>`,
  })[e.status] || '<span class="text-[11px] font-semibold text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">Ready</span>';
  $('#plan').innerHTML = [...edits].reverse().map((e) => `<li class="border border-slate-100 rounded-xl p-2.5 ${e.on === false ? 'opacity-50' : ''}">
    <div class="flex items-start gap-2.5">
      <button data-go="${e.id}" class="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-slate-100" title="Show it in the tour">
        <img src="${e.thumb ? `/api/home/${H.id}/render/${e.thumb}/patch` : (e.crop || '')}" class="w-full h-full object-cover" alt=""></button>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">${pill(e)}${e.agent ? '<span class="text-[10px] bg-brand-100 text-brand-700 rounded px-1">agent</span>' : ''}<span class="ml-auto font-semibold text-sm">${e.cost ? money(e.cost) : ''}</span></div>
        <div class="font-medium text-sm leading-tight mt-0.5">${e.title}</div>
        <div class="text-xs text-slate-500">${e.room || ''}${e.option ? ` · item ${money(e.option.material)} + labor ${money(e.option.labor)}` : ''}</div>
        ${e.options?.length > 1 && e.status === 'done' ? `<select data-swap="${e.id}" class="mt-1 max-w-full text-xs border rounded px-1 py-0.5">${e.options.map((o, i) => `<option value="${i}" ${o.name === e.option?.name ? 'selected' : ''}>${o.tier}: ${o.name} (${money(o.total)})</option>`).join('')}</select>` : ''}
        <div class="mt-1 flex items-center gap-3 text-xs">
          <label class="flex items-center gap-1 text-slate-500"><input type="checkbox" data-on="${e.id}" ${e.on !== false ? 'checked' : ''} class="accent-brand-600">Include</label>
          <button data-go="${e.id}" class="text-brand-700 font-semibold">View</button>
          <button data-del="${e.id}" class="text-slate-400 hover:text-red-600 ml-auto">Delete</button></div></div></div></li>`).join('')
    || '<li class="text-sm text-slate-500">No changes yet.</li>';
  $('#plan').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeEdit(b.dataset.del));
  $('#plan').querySelectorAll('[data-go]').forEach((b) => b.onclick = () => flyTo(edits.find((e) => e.id === b.dataset.go)));
  $('#plan').querySelectorAll('[data-on]').forEach((b) => b.onchange = () => { const e = edits.find((x) => x.id === b.dataset.on); e.on = b.checked; save(); refreshVisibility(); renderPlan(); });
  $('#plan').querySelectorAll('[data-swap]').forEach((s) => s.onchange = () => swapOption(s.dataset.swap, +s.value));
  $('#plan-total').textContent = money(total); $('#plan-labor').textContent = money(labor);
  $('#c-mods').textContent = money(total);
  $('#c-price').textContent = money(H.price) + (H.rent ? '/mo' : '');
  $('#c-true').textContent = H.rent ? `${money(H.price)}/mo + ${money(total)}` : money(H.price + total);
}
$('#plan-clear').onclick = () => [...edits].forEach((e) => removeEdit(e.id));
async function flyTo(e) {
  if (!e?.patches.length) return;
  switchView('tour');
  await sdk.Sweep.moveTo(e.patches[0].sweep, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }).catch(() => {});
  await lookAt(e.patches[0].rot || poseCache.rotation);   // the exact angle it was rendered from
}
function setView(v) {
  view = v; refreshVisibility();
  for (const [id, k] of [['#ba-orig', 'orig'], ['#ba-before', 'plan'], ['#ba-after', 'after']]) $(id).className = 'px-3.5 py-1.5 rounded-full ' + (v === k ? 'bg-white text-ink' : '');
  if (v === 'after') renderMissingViews();
}
$('#ba-orig').onclick = () => setView('orig');
$('#ba-before').onclick = () => setView('plan');
$('#ba-after').onclick = () => setView('after');

/* ---------------- side panels ---------------- */
const STATUS = { yes: ['✓', 'Yes'], likely: ['◐', 'Likely'], unknown: ['?', 'Unknown'], no: ['✕', 'No'] };
function renderAccess(d) {
  const wanted = NEEDS.length ? NEEDS : Object.keys(d.evidence);
  const ev = Object.entries(d.evidence).sort(([a], [b]) => wanted.includes(b) - wanted.includes(a));
  $('#evidence').innerHTML = ev.map(([k, v]) => `<li class="border border-slate-100 rounded-xl p-3 ${wanted.includes(k) ? '' : 'opacity-60'}">
    <div class="flex items-center gap-2"><span class="status-${v.status} font-bold">${STATUS[v.status][0]}</span><span class="font-medium">${v.label}</span>
    <span class="ml-auto text-xs status-${v.status} font-semibold">${STATUS[v.status][1]}</span></div>
    ${v.evidence ? `<div class="text-xs text-slate-500 mt-1">${v.evidence}</div>` : ''}</li>`).join('')
    + (d.scan?.findings || []).map((f) => `<li class="border border-brand-100 bg-brand-50/50 rounded-xl p-3 text-sm"><b>3D scan:</b> ${f.evidence.replace('3D scan: ', '')}</li>`).join('');
  const rooms = d.scan?.rooms || [];
  $('#rooms').innerHTML = rooms.length ? `<table class="w-full"><tbody>${rooms.map((r) => `<tr class="border-t border-slate-100"><td class="py-1.5">${r.type}</td><td>${r.floor || ''}</td><td class="text-right">${r.width_ft ? `${r.width_ft.toFixed(1)} × ${(r.depth_ft || 0).toFixed(1)} ft` : '—'}</td></tr>`).join('')}</tbody></table>` : '';
}
async function loadOutside() {
  const a = await fetch(`/api/home/${H.id}/aerial`).then((r) => r.json());
  const row = (k, v) => `<div class="bg-slate-50 rounded-xl p-3"><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold">${v ?? '—'}</dd></div>`;
  $('#outside').innerHTML = a.found ? [row('Footprint', a.footprint_sqft ? Math.round(a.footprint_sqft).toLocaleString() + ' sq ft' : null),
    row('Tree cover', a.tree_cover_pct != null ? a.tree_cover_pct + '%' : null), row('Pool', a.pool ? 'Yes' : 'No'), row('Deck', a.deck ? 'Yes' : 'No'),
    row('Roof', a.roof), row('Lot', H.lot_acres ? H.lot_acres.toFixed(2) + ' acres' : null)].join('') : '<p class="col-span-2 text-slate-500">No parcel data here.</p>';
}
function switchView(v) {
  document.querySelectorAll('.view-tab').forEach((b) => b.className = 'view-tab px-4 py-1.5 rounded-full ' + (b.dataset.view === v ? 'bg-white text-ink' : ''));
  $('#aerial').classList.toggle('hidden', v !== 'aerial'); $('#photos').classList.toggle('hidden', v !== 'photos');
  $('#tour-tools').style.visibility = v === 'tour' ? 'visible' : 'hidden';
  if (v === 'aerial' && !$('#aerial').src) $('#aerial').src = `/api/home/${H.id}/aerial.jpg`;
}
document.querySelectorAll('.view-tab').forEach((b) => b.onclick = () => switchView(b.dataset.view));
$('#aerial-thumb').onclick = () => switchView('aerial');
document.querySelectorAll('#panel-tabs .tab-btn').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#panel-tabs .tab-btn').forEach((x) => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
});
let hintTimer;
function hint(html, ms) { const h = $('#hint'); h.innerHTML = html; h.style.opacity = 1; clearTimeout(hintTimer); if (ms) hintTimer = setTimeout(() => h.style.opacity = 0, ms); }
function status(t) { const s = $('#render-status'); s.textContent = t; s.classList.toggle('hidden', !t); }

(async () => {
  renderPlan();
  info = await fetch(`/api/home/${H.id}?needs=${NEEDS.join(',')}`).then((r) => r.json());
  renderAccess(info); loadOutside();
  const v = info.evidence;
  const lines = NEEDS.map((k) => v[k]).filter(Boolean);
  bubble(`<div class="flex items-baseline gap-2"><div class="text-2xl font-extrabold text-brand-700">${info.match}%</div><div class="font-semibold">match for your needs</div></div>
    ${lines.length ? `<ul class="mt-1 text-sm grid grid-cols-2 gap-x-3">${lines.map((x) => `<li><span class="status-${x.status} font-bold">${STATUS[x.status][0]}</span> ${x.label}</li>`).join('')}</ul>` : ''}
    <ol class="mt-3 text-sm text-slate-600 space-y-1 list-decimal pl-5">
      <li>Walk around the tour (drag to look, click the floor to move).</li>
      <li>Click <b>Select to change</b> and drag a box around anything.</li>
      <li>Pick an option and press <b>Preview in this home</b>.</li></ol>`);
})();

/* hooks for the issue reporter (report.js): capture the 3D view and the app state */
window.FD_SHOT = async () => {
  const W = iframe.clientWidth, Hh = iframe.clientHeight;
  const tour = sdk ? await soon(sdk.Renderer.takeScreenShot({ width: W, height: Hh }, { mattertags: false, sweeps: true }), 6000) : null;
  if (!tour) throw new Error('no tour');
  // draw the visible selection boxes on top so the report shows what was selected
  const img = new Image(); img.src = tour; await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, W, Hh);
  ctx.strokeStyle = '#7c5cff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  overlay.querySelectorAll('.sel-box').forEach((el) => ctx.strokeRect(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight));
  return c.toDataURL('image/png');
};
window.FD_CONTEXT = async () => ({
  home: { id: H.id, address: H.address, matterport: H.matterport_id }, needs: NEEDS, view, mode, agentBusy, applying,
  pose: poseCache && { sweep: poseCache.sweep, position: poseCache.position, rotation: poseCache.rotation, mode: poseCache.mode },
  room: currentRoom()?.label || null,
  selections: selections.map((s) => ({ label: s.label, rect: s.rect, pose: s.pose, world: s.world })),
  edits: edits.map(({ options, ...e }) => e),
  chat: [...document.querySelectorAll('#chat > div')].slice(-30).map((d) => d.innerText.slice(0, 600)),
});
