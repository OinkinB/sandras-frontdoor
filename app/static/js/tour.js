/* Sandra's FrontDoor 3D tour: Matterport bundle + drag-select + AI edits rendered in the scan. */
const H = window.HOME;
const $ = (s, r = document) => r.querySelector(s);
const money = (n) => '$' + Math.round(n || 0).toLocaleString();
const needs = new URLSearchParams(location.search).get('needs') || '';
const STORE = `frontdoor-edits-${H.id}`;

let sdk = null, scene = { obj: null }, catalog = {}, info = null;
let mode = 'walk', view = 'after';
let selections = [];          // [{id, rect, world, crop, full, label}]
let edits = [];               // applied changes
const nodes = {};             // editId -> [nodes]
let chatHistory = [];
let lastSweep = null, poseCache = null;

/* ---------------- boot ---------------- */
const iframe = $('#showcase');
iframe.src = `/bundle/showcase.html?m=${H.matterport_id}&play=1&qs=1&brand=0&help=0&mls=2&applicationKey=${encodeURIComponent(window.SDK_KEY)}`;
iframe.addEventListener('load', async () => {
  try {
    sdk = await iframe.contentWindow.MP_SDK.connect(iframe.contentWindow);
    await new Promise((res) => {   // App.state.waitUntil can miss the transition; subscribe instead
      const sub = sdk.App.state.subscribe((s) => { if (s.phase === sdk.App.Phase.PLAYING) { res(); setTimeout(() => sub.cancel()); } });
    });
    window.hmSdk = sdk;   // handy for debugging in the console
    await setupScene();
    await loadRooms();
    sdk.Camera.pose.subscribe((p) => {
      poseCache = p;
      if (p.sweep !== lastSweep) { lastSweep = p.sweep; updateRoomPill(); applyView(); }
      clearScreenBoxes(true);
    });
    restoreEdits();
    hint('Drag in <b>Select</b> mode to pick anything. Shift+drag adds more. Then ask the assistant.', 7000);
  } catch (e) {
    console.error(e); hint('3D tour failed to load: ' + (e.message || e));
  }
});

/* ---------------- rooms: navigator + current room label ---------------- */
let sweepList = [], roomList = [], roomIdx = 0, roomBounds = [];
function insideRoom(p, m = 0.15) {   // is a point inside any scanned room's bounding box?
  return roomBounds.some((b) => p.x > b.min.x + m && p.x < b.max.x - m && p.z > b.min.z + m && p.z < b.max.z - m
    && p.y > b.min.y - 0.4 && p.y < b.max.y);
}
async function collect(obs) {
  const out = [];
  await Promise.race([
    new Promise((r) => { const s = obs.subscribe({ onCollectionUpdated: (c) => { out.push(...Object.values(c)); setTimeout(() => s.cancel()); r(); } }); }),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  return out;
}
async function loadRooms() {
  sweepList = await collect(sdk.Sweep.data);
  const rooms = await collect(sdk.Room.data).catch(() => []);
  roomBounds = rooms.filter((r) => r.bounds).map((r) => r.bounds);
  const bySweep = {};
  for (const s of sweepList) if (s.roomInfo?.id) (bySweep[s.roomInfo.id] ||= []).push(s);
  roomList = rooms.filter((r) => r.label && bySweep[r.id]).map((r) => ({ id: r.id, label: r.label.split(',')[0].trim(), sweeps: bySweep[r.id] }));
  const counts = {};
  roomList.forEach((r) => { counts[r.label] = (counts[r.label] || 0) + 1; r.n = counts[r.label]; });
  roomList.forEach((r) => { if (counts[r.label] > 1) r.label += ' ' + r.n; });
  $('#room-nav').classList.toggle('hidden', !roomList.length);
}
function currentRoom() {
  const s = sweepList.find((x) => x.id === lastSweep);
  return roomList.find((r) => r.id === s?.roomInfo?.id);
}
function floorLevels() {          // floor heights from scan points (camera stands ~1.45 m above the floor)
  const by = {};
  for (const sw of sweepList) { const k = sw.floorInfo?.sequence ?? 0; (by[k] ||= []).push(sw.position.y - 1.45); }
  return Object.values(by).map((a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]).sort((a, b) => a - b);
}
function updateRoomPill() {
  const r = currentRoom();
  if (r) roomIdx = roomList.indexOf(r);
  $('#room-name').textContent = r ? r.label : 'Between rooms';
}
async function goRoom(step) {
  if (!roomList.length) return;
  roomIdx = (roomIdx + step + roomList.length) % roomList.length;
  const r = roomList[roomIdx];
  const cx = r.sweeps.reduce((a, s) => a + s.position.x, 0) / r.sweeps.length;
  const cz = r.sweeps.reduce((a, s) => a + s.position.z, 0) / r.sweeps.length;
  const best = [...r.sweeps].sort((a, b) => Math.hypot(a.position.x - cx, a.position.z - cz) - Math.hypot(b.position.x - cx, b.position.z - cz))[0];
  $('#room-name').textContent = r.label;
  await sdk.Sweep.moveTo(best.id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }).catch(() => {});
}
$('#room-prev').onclick = () => goRoom(-1);
$('#room-next').onclick = () => goRoom(1);
$('#room-name').onclick = () => {
  const menu = $('#room-menu');
  menu.innerHTML = roomList.map((r, i) => `<button data-i="${i}" class="block w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/15">${r.label}</button>`).join('');
  menu.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { menu.classList.add('hidden'); roomIdx = +b.dataset.i - 1; goRoom(1); });
  menu.classList.toggle('hidden');
};

/* A box used three ways:
   - plan view: translucent red/green volume with outlined edges
   - "erase" (After view): only the box's far faces are drawn, always on top of the scan and
     writing their depth, so the old fixture inside disappears behind a wall/floor-colored patch
     while new models placed inside the volume still render in front of it. */
const ERASE_ORDER = 1000, MODEL_ORDER = 2000;
function BoxComponent() {
  this.inputs = { w: 1, h: 1, d: 1, color: 0xef4444, opacity: 0.25, edge: 0xef4444, solid: false,
                  floor: 0xbdb5aa, wall: 0xe8e6e1, visible: true };
  this.onInit = function () {
    const T = this.context.three;
    const g = new T.BoxGeometry(1, 1, 1);
    this.plan = new T.MeshBasicMaterial({ transparent: true, depthWrite: false });
    const er = (c) => new T.MeshBasicMaterial({ color: c, side: T.BackSide, depthFunc: T.AlwaysDepth, depthWrite: true });
    this.wallMat = er(0xe8e6e1); this.floorMat = er(0xbdb5aa);
    // BoxGeometry groups: +x, -x, +y, -y (bottom = floor), +z, -z
    this.eraseMats = [this.wallMat, this.wallMat, this.wallMat, this.floorMat, this.wallMat, this.wallMat];
    this.mesh = new T.Mesh(g, this.plan);
    this.lines = new T.LineSegments(new T.EdgesGeometry(g), new T.LineBasicMaterial({ transparent: true }));
    const grp = new T.Group(); grp.add(this.mesh); grp.add(this.lines);
    this.outputs.objectRoot = grp; this.outputs.collider = this.mesh;
    this.apply();
  };
  this.apply = function () {
    const i = this.inputs;
    this.mesh.scale.set(i.w, i.h, i.d); this.lines.scale.set(i.w, i.h, i.d);
    if (i.solid) {
      this.wallMat.color.setHex(i.wall); this.floorMat.color.setHex(i.floor);
      this.mesh.material = this.eraseMats; this.mesh.renderOrder = ERASE_ORDER; this.lines.visible = false;
    } else {
      this.plan.color.setHex(i.color); this.plan.opacity = i.opacity;
      this.mesh.material = this.plan; this.mesh.renderOrder = 5; this.lines.visible = true;
      this.lines.material.color.setHex(i.edge); this.lines.renderOrder = 6;
    }
    this.outputs.objectRoot.visible = i.visible;
  };
  this.onInputsUpdated = function () { this.apply(); };
}

/* Draw inserted models after erase patches so they sit in front of them. */
function lateRender(comp) {
  let tries = 0;
  const t = setInterval(() => {
    const root = comp.outputs && comp.outputs.objectRoot;
    if (root || ++tries > 80) {
      clearInterval(t);
      if (root && root.traverse) root.traverse((o) => { if (o.isMesh) o.renderOrder = MODEL_ORDER; });
    }
  }, 250);
}

/* ---------- generative geometry: built at runtime to fit what was measured ---------- */
const MATS = (T) => ({
  alu: new T.MeshStandardMaterial({ color: 0xd9dbe0, metalness: 0.5, roughness: 0.4 }),
  plastic: new T.MeshStandardMaterial({ color: 0xeeeeec, metalness: 0, roughness: 0.45 }),
  fabric: new T.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0, roughness: 0.9 }),
});
function rod(T, a, b, r, mat) {     // cylinder from point a to point b
  const A = new T.Vector3(a.x, a.y, a.z), B = new T.Vector3(b.x, b.y, b.z);
  const len = A.distanceTo(B);
  const m = new T.Mesh(new T.CylinderGeometry(r, r, len, 20), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return m;
}
function block(T, size, pos, mat) {
  const m = new T.Mesh(new T.BoxGeometry(size[0], size[1], size[2]), mat);
  m.position.set(pos[0], pos[1], pos[2]); return m;
}

/* Stairlift fitted to the selected staircase: rail follows the measured bottom->top slope and
   length, posts drop to the treads, and the chair parks at the bottom facing out from the wall. */
function StairliftComponent() {
  this.inputs = { path: [], side: { x: 1, z: 0 }, floorY: 0 };
  this.onInit = function () {
    const T = this.context.three, M = MATS(T), g = new T.Group();
    const { path, side } = this.inputs;
    const off = 0.32;   // rail sits this far toward the wall from the stair centerline
    const pts = path.map((p) => ({ x: p.x + side.x * off, y: p.y + 0.2, z: p.z + side.z * off }));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      g.add(rod(T, a, b, 0.045, M.alu));
      if (k > 0) g.add(new T.Mesh(new T.SphereGeometry(0.045, 16, 12), M.alu).translateX(a.x).translateY(a.y).translateZ(a.z)); // bend
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 1.1));
      for (let i = 0; i <= n; i++) {
        const t = i / n, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
        g.add(rod(T, p, { x: p.x, y: p.y - 0.2, z: p.z }, 0.02, M.alu));
      }
    }
    // chair, parked at the bottom of the rail
    const a = pts[0], b = pts[1];
    const dir = new T.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const chair = new T.Group();
    chair.add(block(T, [0.16, 0.3, 0.34], [0, 0.32, 0], M.plastic));            // carriage on the rail
    chair.add(block(T, [0.44, 0.08, 0.46], [-0.3, 0.56, 0], M.fabric));         // seat
    chair.add(block(T, [0.08, 0.52, 0.46], [-0.1, 0.86, 0], M.fabric));         // backrest against the rail side
    chair.add(block(T, [0.34, 0.03, 0.38], [-0.33, 0.1, 0], M.plastic));        // footrest
    chair.add(block(T, [0.06, 0.42, 0.08], [-0.12, 0.3, 0], M.plastic));
    for (const s of [-1, 1]) chair.add(block(T, [0.34, 0.05, 0.06], [-0.3, 0.78, s * 0.25], M.plastic));
    const base = { x: a.x - dir.x * 0.15, y: this.inputs.floorY, z: a.z - dir.z * 0.15 };
    chair.position.set(base.x, base.y, base.z);
    chair.rotation.y = Math.atan2(-side.z, side.x);   // local +X -> wall side, so the seat (-X) faces into the room
    g.add(chair);
    g.traverse((o) => { if (o.isMesh) o.renderOrder = MODEL_ORDER; });
    this.outputs.objectRoot = g;
  };
}

/* AI-designed object: a list of primitive parts with real sizes, colors and materials. */
function PartsComponent() {
  this.inputs = { parts: [] };
  this.onInit = function () {
    const T = this.context.three, g = new T.Group();
    for (const p of (this.inputs.parts || []).slice(0, 24)) {
      const sz = (p.size || [0.3, 0.3, 0.3]).map((v) => Math.min(4, Math.max(0.005, +v || 0.1)));
      const geo = p.shape === 'cylinder' ? new T.CylinderGeometry(sz[0] / 2, sz[0] / 2, sz[1], 28) : new T.BoxGeometry(sz[0], sz[1], sz[2]);
      const op = p.opacity == null ? 1 : +p.opacity;
      const mat = new T.MeshStandardMaterial({ color: new T.Color(p.color || '#dddddd'), metalness: +p.metal || 0,
        roughness: p.rough == null ? 0.5 : +p.rough, transparent: op < 1, opacity: op });
      const m = new T.Mesh(geo, mat);
      const o = p.offset || [0, sz[1] / 2, 0];
      m.position.set(+o[0] || 0, +o[1] || 0, +o[2] || 0);
      const r = (p.rotate || [0, 0, 0]).map((d) => (+d || 0) * Math.PI / 180);
      m.rotation.set(r[0], r[1], r[2]);
      m.renderOrder = MODEL_ORDER;
      g.add(m);
    }
    this.outputs.objectRoot = g;
  };
}

async function setupScene() {
  await sdk.Scene.register('hm.box', () => new BoxComponent());
  await sdk.Scene.register('hm.stairlift', () => new StairliftComponent());
  await sdk.Scene.register('hm.parts', () => new PartsComponent());
  const [lights] = await sdk.Scene.createObjects(1);
  // Interior photos are bright and evenly lit, so light the inserted models the same way.
  const ln = lights.addNode();
  ln.addComponent('mp.ambientLight', { intensity: 2.6, color: { r: 1, g: 0.98, b: 0.95 } });
  ln.addComponent('mp.directionalLight', { intensity: 1.6, color: { r: 1, g: 1, b: 1 } });
  lights.start();
}

/* ---------------- geometry helpers ---------------- */
async function hitAt(x, y) {
  try { const d = await sdk.Renderer.getWorldPositionData({ x, y }); return d && d.position ? d.position : null; }
  catch { return null; }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

/* Measure what is inside a screen rectangle in 3D: raycast a grid of points, then fit a
   box aligned to the house axes (Matterport scans are usually axis-aligned to the walls). */
async function worldFromRect(r) {
  const cam = poseCache.position;
  const center = await hitAt(r.x + r.w / 2, r.y + r.h / 2);
  if (!center) return null;
  const N = 7, inset = 0.06, jobs = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    jobs.push(hitAt(r.x + r.w * (inset + (1 - 2 * inset) * i / (N - 1)), r.y + r.h * (inset + (1 - 2 * inset) * j / (N - 1))));
  }
  let pts = (await Promise.all(jobs)).filter(Boolean);
  const dc = dist(cam, center);
  pts = pts.filter((p) => dist(cam, p) < dc + 1.2);           // drop points seen through doorways
  if (pts.length < 4) pts = [center];
  // face the camera, snapped to the nearest house axis
  const raw = Math.atan2(cam.x - center.x, cam.z - center.z);
  const yaw = Math.round(raw / (Math.PI / 2)) * (Math.PI / 2);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const toLocal = (p) => ({ x: (p.x - center.x) * c - (p.z - center.z) * s, z: (p.x - center.x) * s + (p.z - center.z) * c });
  const loc = pts.map(toLocal);
  const xs = loc.map((p) => p.x), zs = loc.map((p) => p.z), ys = pts.map((p) => p.y);
  const x0 = pct(xs, 0.08), x1 = pct(xs, 0.92), z0 = pct(zs, 0.08), z1 = pct(zs, 0.92);
  const camFloor = cam.y - 1.45;                                 // camera sits ~1.4-1.6 m above the floor
  const yMin = Math.min(...ys);
  const floorY = Math.abs(yMin - camFloor) < 0.35 ? yMin : camFloor;
  const yTop = pct(ys, 0.9);
  const w = Math.max(0.2, x1 - x0), d = Math.max(0.2, z1 - z0), h = Math.max(0.2, yTop - floorY);
  const lx = (x0 + x1) / 2, lz = (z0 + z1) / 2;                  // box center back to world
  const bc = { x: center.x + lx * c + lz * s, y: floorY + h / 2, z: center.z - lx * s + lz * c };
  const front = { x: bc.x + s * d / 2, y: floorY, z: bc.z + c * d / 2 };   // local +Z faces the camera
  // stair endpoints: mean of the lowest and highest selected surfaces (ignoring ceiling hits)
  const usable = pts.filter((p) => p.y < floorY + 3.4);
  const lo = pct(usable.map((p) => p.y), 0.15), hiY = pct(usable.map((p) => p.y), 0.85);
  const mean = (arr) => ({ x: arr.reduce((a, p) => a + p.x, 0) / arr.length, y: arr.reduce((a, p) => a + p.y, 0) / arr.length,
                           z: arr.reduce((a, p) => a + p.z, 0) / arr.length });
  const bottom = mean(usable.filter((p) => p.y <= lo + 0.05)), top = mean(usable.filter((p) => p.y >= hiY - 0.05));
  return { center: bc, hit: center, front, w, h, d, yaw, cam, floorY, bottom, top, rise: top.y - bottom.y };
}

/* ---------------- selection (drag marquee) ---------------- */
const overlay = $('#overlay');
let drag = null;

function setMode(m) {
  mode = m;
  overlay.style.pointerEvents = m === 'select' ? 'auto' : 'none';
  overlay.style.cursor = m === 'select' ? 'crosshair' : '';
  $('#mode-select').className = 'px-3.5 py-1.5 rounded-full ' + (m === 'select' ? 'bg-white text-ink' : '');
  $('#mode-walk').className = 'px-3.5 py-1.5 rounded-full ' + (m === 'walk' ? 'bg-white text-ink' : '');
  if (m === 'select') hint('Drag a box around something (Shift+drag to add more). Esc to cancel.', 4000);
}
$('#mode-walk').onclick = () => setMode('walk');
$('#mode-select').onclick = () => setMode('select');
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 's' || e.key === 'S') setMode('select');
  if (e.key === 'w' || e.key === 'W') setMode('walk');
  if (e.key === 'Escape') { selections = []; clearScreenBoxes(); renderSelChips(); }
});

overlay.addEventListener('pointerdown', (e) => {
  if (mode !== 'select' || !sdk) return;
  const b = overlay.getBoundingClientRect();
  drag = { x0: e.clientX - b.left, y0: e.clientY - b.top, add: e.shiftKey || e.ctrlKey, el: document.createElement('div') };
  drag.el.className = 'marquee'; overlay.appendChild(drag.el);
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const b = overlay.getBoundingClientRect();
  const x = e.clientX - b.left, y = e.clientY - b.top;
  Object.assign(drag.el.style, { left: Math.min(x, drag.x0) + 'px', top: Math.min(y, drag.y0) + 'px',
    width: Math.abs(x - drag.x0) + 'px', height: Math.abs(y - drag.y0) + 'px' });
  drag.x1 = x; drag.y1 = y;
});
overlay.addEventListener('pointerup', async () => {
  if (!drag) return;
  const d = drag; drag = null; d.el.remove();
  let r = { x: Math.min(d.x0, d.x1 ?? d.x0), y: Math.min(d.y0, d.y1 ?? d.y0), w: Math.abs((d.x1 ?? d.x0) - d.x0), h: Math.abs((d.y1 ?? d.y0) - d.y0) };
  if (r.w < 10 || r.h < 10) r = { x: d.x0 - 60, y: d.y0 - 60, w: 120, h: 120 };   // click = small box
  if (!d.add) { selections = []; clearScreenBoxes(); }
  await addSelection(r);
});

async function grabFrame() {
  const W = iframe.clientWidth, Hh = iframe.clientHeight;
  const uri = await sdk.Renderer.takeScreenShot({ width: W, height: Hh }, { mattertags: false, sweeps: false });
  const img = new Image(); img.src = uri; await img.decode();
  return { img, W, H: Hh };
}

function cropTo(img, r, scaleTo = 640) {
  const c = document.createElement('canvas');
  const s = Math.min(1, scaleTo / Math.max(r.w, r.h)) * (img.naturalWidth / iframe.clientWidth);
  c.width = Math.max(1, r.w * s / (img.naturalWidth / iframe.clientWidth));
  c.height = Math.max(1, r.h * s / (img.naturalWidth / iframe.clientWidth));
  const k = img.naturalWidth / iframe.clientWidth;
  c.getContext('2d').drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

function ringColor(img, r) {   // floor color just below the selection, wall color just above it
  const c = document.createElement('canvas'); const k = img.naturalWidth / iframe.clientWidth;
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const avg = (ys) => {
    let R = 0, G = 0, B = 0, n = 0;
    for (const y of ys) for (let t = 0.1; t <= 0.9; t += 0.1) {
      const px = Math.round((r.x + r.w * t) * k), py = Math.round(y * k);
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
      const d = ctx.getImageData(px, py, 1, 1).data; R += d[0]; G += d[1]; B += d[2]; n++;
    }
    return n ? (Math.round(R / n) << 16) | (Math.round(G / n) << 8) | Math.round(B / n) : null;
  };
  return { floor: avg([r.y + r.h + 10, r.y + r.h + 22]) ?? 0xbdb5aa, wall: avg([r.y - 10, r.y - 22]) ?? 0xe8e6e1 };
}

async function addSelection(r) {
  const id = 's' + Date.now().toString(36);
  const box = screenBox(r, 'pending', 'Analyzing…');
  const [frame, world] = await Promise.all([grabFrame(), worldFromRect(r)]);
  if (!world) { box.remove(); hint('Nothing solid there. Try selecting part of the room.', 2500); return; }
  const sel = { id, rect: r, world, crop: cropTo(frame.img, r), full: cropTo(frame.img, { x: 0, y: 0, w: frame.W, h: frame.H }, 900),
                fill: ringColor(frame.img, r), label: 'Selection ' + (selections.length + 1), box,
                room: currentRoom()?.label || '', roomId: currentRoom()?.id || null };
  selections.push(sel);
  renderSelChips();
  analyze(sel);
}

function screenBox(r, cls, label) {
  const el = document.createElement('div');
  el.className = 'sel-box ' + cls;
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  el.innerHTML = `<span class="sel-label">${label}</span>`;
  overlay.appendChild(el);
  return el;
}
function clearScreenBoxes(onlyIfMoved) {
  if (onlyIfMoved && !selections.length) return;
  overlay.querySelectorAll('.sel-box').forEach((e) => e.remove());
}

function renderSelChips() {
  const box = $('#sel-chips');
  box.innerHTML = selections.map((s) => `<span class="inline-flex items-center gap-1.5 text-xs font-medium bg-brand-50 text-brand-700 rounded-full pl-2 pr-1 py-1">
    <img src="${s.crop}" class="w-6 h-6 rounded-md object-cover">${s.label}
    <button data-x="${s.id}" class="w-5 h-5 rounded-full hover:bg-brand-100" aria-label="Remove selection">✕</button></span>`).join('');
  box.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => {
    const s = selections.find((x) => x.id === b.dataset.x); s?.box?.remove();
    selections = selections.filter((x) => x.id !== b.dataset.x); renderSelChips();
  });
}

/* ---------------- AI: analyze selection + chat ---------------- */
function bubble(html, who = 'ai') {
  const el = document.createElement('div');
  el.className = who === 'user' ? 'flex justify-end' : 'flex';
  el.innerHTML = who === 'user'
    ? `<div class="max-w-[85%] bg-brand-100 text-brand-900 rounded-2xl rounded-br-md px-4 py-2.5">${html}</div>`
    : `<div class="max-w-[95%] bg-slate-50 border border-slate-100 rounded-2xl rounded-bl-md px-4 py-3 text-[15px]">${html}</div>`;
  $('#chat').appendChild(el); $('#chat').scrollTop = 1e9;
  return el;
}
const thinking = () => bubble('<span class="dots text-slate-500">Thinking<span>.</span><span>.</span><span>.</span></span>');

function changeCard(sel, c) {
  const tone = c.action === 'remove' ? 'border-red-200 bg-red-50' : c.action === 'add' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50';
  const tag = { remove: '− Remove', add: '+ Add', replace: '⇄ Replace' }[c.action] || c.action;
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => { applyChange(sel, c); b.textContent = 'Applied ✓'; b.disabled = true; b.classList.add('opacity-60'); };
  });
  return `<div class="mt-2 border ${tone} rounded-xl p-3">
    <div class="flex items-start gap-2"><span class="text-[11px] font-bold uppercase tracking-wide">${tag}</span>
      <span class="ml-auto text-sm font-semibold">${money(c.cost_low)}–${money(c.cost_high)}</span></div>
    <div class="font-semibold mt-0.5">${c.title || ''}</div>
    <div class="text-sm text-slate-600">${c.reason || ''}</div>
    <button id="${id}" class="mt-2 text-sm font-semibold bg-ink text-white rounded-lg px-3 py-1.5 hover:bg-brand-700">Apply in 3D</button></div>`;
}

async function analyze(sel, instruction) {
  const t = thinking();
  try {
    const res = await fetch(`/api/home/${H.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crop: sel.crop, full: sel.full, instruction, room: sel.room,
        size: sel.world && { w: sel.world.w, h: sel.world.h, d: sel.world.d, rise: sel.world.rise } }) }).then((r) => r.json());
    t.remove();
    if (res.error) { bubble(`<span class="text-red-600">${res.error}</span>`); return; }
    sel.items = res.items || [];
    sel.label = sel.items[0]?.name || sel.label;
    sel.box?.querySelector('.sel-label') && (sel.box.querySelector('.sel-label').textContent = sel.label);
    renderSelChips();
    const items = sel.items.map((i) => `<li><b>${i.name}</b>: ${i.observation}</li>`).join('');
    bubble(`<div class="flex gap-3"><img src="${sel.crop}" class="w-16 h-16 rounded-lg object-cover shrink-0">
      <div><div>${res.summary || ''}</div><ul class="mt-1 text-sm text-slate-600 list-disc pl-4">${items}</ul></div></div>
      ${(res.changes || []).map((c) => changeCard(sel, c)).join('')}`);
    chatHistory.push({ role: 'assistant', content: `Selection "${sel.label}": ${res.summary}` });
  } catch (e) { t.remove(); bubble('<span class="text-red-600">Could not analyze that selection.</span>'); }
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#chat-input').value.trim(); if (!msg) return;
  $('#chat-input').value = '';
  bubble(msg, 'user'); chatHistory.push({ role: 'user', content: msg });
  const sel = selections[selections.length - 1];
  // A change request about selected things goes through the vision model for precise placement.
  if (sel && /\b(make|turn|change|replace|remove|add|convert|swap|put|install|get rid|widen|design|build|lower|raise|fit|create)\b/i.test(msg)) {
    for (const s of selections) await analyze(s, msg);
    return;
  }
  const t = thinking();
  const res = await fetch(`/api/home/${H.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, history: chatHistory, edits: edits.map((x) => x.title),
      selection: selections.length ? selections.map((s) => ({ label: s.label, items: s.items })) : null }) }).then((r) => r.json());
  t.remove();
  bubble(`${(res.reply || '').replace(/\n/g, '<br>')}${(res.actions || []).map((a) => sel ? changeCard(sel, a) : '').join('')}`);
  chatHistory.push({ role: 'assistant', content: res.reply });
});

/* ---------------- apply changes into the 3D scene ---------------- */
async function applyChange(sel, c, restoring = false) {
  const w = sel.world;
  const edit = restoring ? c : {
    id: 'e' + Date.now().toString(36), action: c.action, mod: c.mod, model: c.model || catalog[c.mod]?.model || null,
    title: c.title || catalog[c.mod]?.label, cost_low: c.cost_low, cost_high: c.cost_high,
    world: w, fill: sel.fill, crop: sel.crop, room: sel.roomId || currentRoom()?.id || null, parts: c.parts || null,
  };
  const [obj] = await sdk.Scene.createObjects(1);
  const made = [];
  if (edit.action === 'remove' || edit.action === 'replace') {
    const n = obj.addNode();
    n.addComponent('hm.box', { w: w.w * 1.04, h: w.h * 1.02, d: w.d * 1.04, color: 0xef4444, edge: 0xef4444, opacity: 0.28 });
    n.position.set(w.center.x, w.center.y, w.center.z);
    n.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, w.yaw);
    made.push({ node: n, kind: 'remove', fill: edit.fill, room: edit.room });
  }
  if (edit.mod === 'stairlift' && edit.action !== 'remove' && w.bottom && w.rise > 0.5) {
    // fitted to the measured staircase instead of a fixed model
    const dx = w.top.x - w.bottom.x, dz = w.top.z - w.bottom.z, L = Math.hypot(dx, dz) || 1;
    let side = { x: -dz / L, z: dx / L };                    // perpendicular to the stair run
    if ((w.cam.x - w.bottom.x) * side.x + (w.cam.z - w.bottom.z) * side.z > 0) side = { x: -side.x, z: -side.z };  // wall side, away from viewer
    // Extend the measured slope to the real floor levels at each end, so the rail spans the whole flight
    // even if only part of the stairs was visible in the selection.
    // Residential stairs run ~33-40 deg; clamp the measured slope so a partial view can't skew the fit.
    const ang = Math.min(40, Math.max(33, Math.atan2(w.top.y - w.bottom.y, L) * 180 / Math.PI)) * Math.PI / 180;
    const slope = Math.tan(ang), ux = dx / L, uz = dz / L;
    const levels = floorLevels();
    const below = levels.filter((y) => y <= w.bottom.y + 0.05 && w.bottom.y - y < 3.6).pop();
    const above = levels.filter((y) => y >= w.top.y - 0.15 && y - w.top.y < 3.6)[0];
    const at = (p, y) => { const t = (y - p.y) / slope; return { x: p.x + ux * t, y, z: p.z + uz * t }; };
    // pull an extended end back toward the measured stairs until it sits inside a scanned room
    const keepInside = (from, to) => {
      for (let t = 1; t >= 0; t -= 0.05) {
        const q = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
        if (insideRoom(q)) return q;
      }
      return from;
    };
    const p0 = below != null ? keepInside(w.bottom, at(w.bottom, below)) : w.bottom;
    const p1 = above != null ? keepInside(w.top, at(w.top, above)) : w.top;
    // If the straight run stops above the floor, the stairs turn (winder or landing): follow the turn
    // down to the floor in whichever direction stays inside the house. That makes it a curved stairlift.
    const path = [p0, p1];
    if (below != null && p0.y - below > 0.3) {
      const drop = p0.y - below, horiz = drop / slope;
      for (const sgn of [1, -1]) {
        const q = { x: p0.x + side.x * sgn * horiz, y: below, z: p0.z + side.z * sgn * horiz };
        const mid = { x: (p0.x + q.x) / 2, y: (p0.y + q.y) / 2, z: (p0.z + q.z) / 2 };
        if (insideRoom(q) && insideRoom(mid)) { path.unshift(q); break; }
      }
    }
    const n = obj.addNode();
    n.addComponent('hm.stairlift', { path, side, floorY: path[0].y });
    made.push({ node: n, kind: 'model' });
    let rise = 0, run = 0;
    for (let k = 0; k < path.length - 1; k++) { rise += path[k + 1].y - path[k].y; run += Math.hypot(path[k + 1].x - path[k].x, path[k + 1].z - path[k].z); }
    edit.fitted = `${(rise * 39.37).toFixed(0)} in rise over ${(run * 3.281).toFixed(1)} ft, ${path.length > 2 ? 'curved at the turn' : 'straight'}`;
  } else if (edit.mod === 'custom' && edit.parts?.length && edit.action !== 'remove') {
    const n = obj.addNode();
    n.addComponent('hm.parts', { parts: edit.parts });
    n.position.set(w.center.x, w.floorY, w.center.z);
    n.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, w.yaw);
    made.push({ node: n, kind: 'model' });
  } else if ((edit.action === 'add' || edit.action === 'replace') && edit.model) {
    const n = obj.addNode();
    const m = edit.model;
    // Scale the walk-in shower to the alcove it replaces (model is a 60 in x 36 in pan).
    const k = m === 'walk_in_shower' ? Math.min(1.3, Math.max(0.8, w.w / 1.524)) : 1;
    lateRender(n.addComponent('mp.gltfLoader', { url: `${location.origin}/static/models/${m}.glb`, localScale: { x: k, y: 1, z: k } }));
    const hit = w.hit || w.center;
    if (['grab_bar', 'lever_handle'].includes(m)) {          // wall-mounted: on the wall point, nudged toward the viewer
      const t = 0.015 / Math.max(0.01, Math.hypot(w.cam.x - hit.x, w.cam.z - hit.z));
      n.position.set(hit.x + (w.cam.x - hit.x) * t, m === 'grab_bar' ? Math.max(hit.y, w.floorY + 0.85) : w.floorY + 0.92, hit.z + (w.cam.z - hit.z) * t);
    } else if (['walk_in_shower', 'ramp'].includes(m)) {    // origin is the front edge
      n.position.set(w.front.x, w.floorY, w.front.z);
    } else {
      n.position.set(w.center.x, w.floorY, w.center.z);
    }
    n.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, w.yaw);
    made.push({ node: n, kind: 'model' });
    const g = obj.addNode();
    g.addComponent('hm.box', { w: Math.max(w.w, 0.4), h: 0.02, d: Math.max(w.d, 0.4), color: 0x22c55e, edge: 0x16a34a, opacity: 0.22 });
    g.position.set(w.center.x, w.floorY + 0.01, w.center.z);
    g.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, w.yaw);
    made.push({ node: g, kind: 'add-marker' });
  }
  obj.start();
  nodes[edit.id] = made;
  if (!restoring) { edits.push(edit); saveEdits(); }
  applyView();
  renderPlan();
  sel.box?.remove();
  if (!restoring) hint(`${edit.title} applied${edit.fitted ? ' (fitted to ' + edit.fitted + ')' : ''}. Walk around: it stays in place.`, 4500);
}

function applyView() {
  for (const list of Object.values(nodes)) for (const m of list) {
    const comp = [...m.node.componentIterator()][0];
    if (m.kind === 'remove') {
      Object.assign(comp.inputs, view === 'after'
        ? { solid: true, floor: m.fill?.floor ?? 0xbdb5aa, wall: m.fill?.wall ?? 0xe8e6e1,
            visible: !m.room || m.room === currentRoom()?.id }   // erase patches only show in their own room
        : { solid: false, color: 0xef4444, edge: 0xef4444, opacity: 0.28, visible: true });
      comp.onInputsUpdated?.();
    }
    if (m.kind === 'add-marker') { comp.inputs.visible = view !== 'after'; comp.onInputsUpdated?.(); }
  }
}
function setView(v) {
  view = v; applyView();
  $('#ba-before').className = 'px-3.5 py-1.5 rounded-full ' + (v === 'before' ? 'bg-white text-ink' : '');
  $('#ba-after').className = 'px-3.5 py-1.5 rounded-full ' + (v === 'after' ? 'bg-white text-ink' : '');
}
$('#ba-before').onclick = () => setView('before');
$('#ba-after').onclick = () => setView('after');

function removeEdit(id) {
  (nodes[id] || []).forEach((m) => m.node.stop());
  delete nodes[id];
  edits = edits.filter((e) => e.id !== id); saveEdits(); renderPlan();
}
function saveEdits() { try { localStorage.setItem(STORE, JSON.stringify(edits.map(({ crop, ...e }) => e))); } catch {} }
async function restoreEdits() {
  let saved = []; try { saved = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch {}
  edits = saved;
  for (const e of saved) await applyChange({ world: e.world, fill: e.fill }, e, true);
  renderPlan();
}

/* ---------------- panels ---------------- */
function renderPlan() {
  const total = edits.reduce((s, e) => s + (e.cost_low + e.cost_high) / 2, 0);
  $('#plan-count').textContent = edits.length;
  $('#plan').innerHTML = edits.map((e) => `<li class="flex items-center gap-3 border border-slate-100 rounded-xl p-3">
    <span class="w-2.5 h-2.5 rounded-full ${e.action === 'remove' ? 'bg-red-500' : e.action === 'add' ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
    <div class="flex-1"><div class="font-medium">${e.title}</div><div class="text-xs text-slate-500">${e.action} · ${money(e.cost_low)}–${money(e.cost_high)}${e.fitted ? ' · fitted to ' + e.fitted : ''}${e.parts ? ' · AI-designed' : ''}</div></div>
    <button data-go="${e.id}" class="text-xs text-brand-700 font-semibold">View</button>
    <button data-del="${e.id}" class="text-xs text-slate-400 hover:text-red-600" aria-label="Remove change">✕</button></li>`).join('')
    || '<li class="text-sm text-slate-500">No changes yet. Switch to <b>Select</b>, drag around something in the tour, and apply a suggestion.</li>';
  $('#plan').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeEdit(b.dataset.del));
  $('#plan').querySelectorAll('[data-go]').forEach((b) => b.onclick = () => flyTo(edits.find((e) => e.id === b.dataset.go)));
  $('#plan-total').textContent = money(total);
  $('#c-mods').textContent = money(total);
  $('#c-price').textContent = money(H.price) + (H.rent ? '/mo' : '');
  $('#c-true').textContent = H.rent ? `${money(H.price)}/mo + ${money(total)}` : money(H.price + total);
}
$('#plan-clear').onclick = () => [...edits].forEach((e) => removeEdit(e.id));

async function flyTo(e) {
  if (!e || !sdk) return;
  const sweeps = []; await new Promise((r) => { const s = sdk.Sweep.data.subscribe({ onCollectionUpdated: (c) => { sweeps.push(...Object.values(c)); setTimeout(() => s.cancel()); r(); } }); });
  const best = sweeps.sort((a, b) => dist(a.position, e.world.cam) - dist(b.position, e.world.cam))[0];
  if (best) await sdk.Sweep.moveTo(best.id, { transition: sdk.Sweep.Transition.FLY, transitionTime: 800 }).catch(() => {});
  switchView('tour');
}

const STATUS = { yes: ['✓', 'Yes'], likely: ['◐', 'Likely'], unknown: ['?', 'Unknown'], no: ['✕', 'No'] };
function renderAccess(d) {
  const wanted = needs ? needs.split(',') : Object.keys(d.evidence);
  const ev = Object.entries(d.evidence).sort(([a], [b]) => wanted.includes(b) - wanted.includes(a));
  $('#evidence').innerHTML = ev.map(([k, v]) => `<li class="border border-slate-100 rounded-xl p-3 ${wanted.includes(k) ? '' : 'opacity-60'}">
    <div class="flex items-center gap-2"><span class="status-${v.status} font-bold">${STATUS[v.status][0]}</span>
      <span class="font-medium">${v.label}</span><span class="ml-auto text-xs status-${v.status} font-semibold">${STATUS[v.status][1]}</span></div>
    ${v.evidence ? `<div class="text-xs text-slate-500 mt-1">${v.evidence}</div>` : ''}</li>`).join('')
    + (d.scan?.findings || []).map((f) => `<li class="border border-brand-100 bg-brand-50/50 rounded-xl p-3 text-sm"><b>3D scan:</b> ${f.evidence.replace('3D scan: ', '')}</li>`).join('');
  const rooms = d.scan?.rooms || [];
  $('#rooms').innerHTML = rooms.length ? `<table class="w-full"><thead class="text-left text-xs text-slate-500"><tr><th class="py-1">Room</th><th>Floor</th><th class="text-right">Size</th></tr></thead><tbody>
    ${rooms.map((r) => `<tr class="border-t border-slate-100"><td class="py-1.5">${r.type}</td><td>${r.floor || ''}</td><td class="text-right">${r.width_ft ? `${r.width_ft.toFixed(1)} × ${(r.depth_ft || 0).toFixed(1)} ft` : '—'}</td></tr>`).join('')}</tbody></table>`
    : '<p class="text-slate-500">Room data unavailable for this scan.</p>';
}

function intro(d) {
  const wanted = needs ? needs.split(',') : ['no_stairs', 'step_free_entry', 'walk_in_shower', 'wide_doorways'];
  const lines = wanted.map((k) => d.evidence[k]).filter(Boolean)
    .map((v) => `<li class="flex gap-2"><span class="status-${v.status} font-bold w-4">${STATUS[v.status][0]}</span><span>${v.label}: <span class="text-slate-500">${STATUS[v.status][1].toLowerCase()}</span></span></li>`).join('');
  const verdict = d.match >= 85 ? 'This home is a strong fit for your needs.' : d.match >= 65 ? 'This home is a reasonable fit with a few changes.' : 'This home would need some work for your needs.';
  bubble(`<div class="font-semibold">${verdict} <span class="text-brand-700">${d.match}% match</span></div>
    <ul class="mt-2 space-y-1 text-sm">${lines}</ul>
    ${d.mods.length ? `<div class="mt-2 text-sm">Estimated changes: <b>${d.mods.map((m) => m.label).join(', ')}</b> (~${money(d.mod_total)}).</div>` : ''}
    <div class="mt-2 text-sm text-slate-500">Tip: press <b>S</b> (or click ⬚ Select) and drag around the bathtub, a step or a doorway. I'll tell you what it is and show the fix in 3D.</div>`);
}

async function loadOutside() {
  const a = await fetch(`/api/home/${H.id}/aerial`).then((r) => r.json());
  const row = (k, v) => `<div class="bg-slate-50 rounded-xl p-3"><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold">${v ?? '—'}</dd></div>`;
  $('#outside').innerHTML = a.found ? [
    row('Structures on lot', a.structures), row('Footprint', a.footprint_sqft ? Math.round(a.footprint_sqft).toLocaleString() + ' sq ft' : null),
    row('Tree cover', a.tree_cover_pct != null ? a.tree_cover_pct + '%' : null), row('Pool', a.pool ? 'Yes' : 'No'),
    row('Deck', a.deck ? 'Yes' : 'No'), row('Roof', a.roof), row('Lot size', H.lot_acres ? H.lot_acres.toFixed(2) + ' acres' : null),
    row('Imagery', a.collection)].join('') : `<p class="col-span-2 text-slate-500">No parcel data at this point${a.error ? ' (' + a.error + ')' : ''}.</p>`;
}

/* ---------------- tabs / view switching ---------------- */
function switchView(v) {
  document.querySelectorAll('.view-tab').forEach((b) => b.className = 'view-tab px-4 py-1.5 rounded-full ' + (b.dataset.view === v ? 'bg-white text-ink' : ''));
  $('#aerial').classList.toggle('hidden', v !== 'aerial');
  $('#photos').classList.toggle('hidden', v !== 'photos');
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
function hint(html, ms) {
  const h = $('#hint'); h.innerHTML = html; h.style.opacity = 1;
  clearTimeout(hintTimer); if (ms) hintTimer = setTimeout(() => h.style.opacity = 0, ms);
}

/* ---------------- data ---------------- */
(async () => {
  renderPlan();
  info = await fetch(`/api/home/${H.id}?needs=${needs}`).then((r) => r.json());
  catalog = info.catalog;
  renderAccess(info); intro(info); loadOutside();
})();
