/* Sandra's FrontDoor: guided, photoreal remodel preview inside a Matterport tour.
 *
 * How a change works
 *  1. You circle something (loosely is fine) and say what you want, or the guided tour proposes it.
 *  2. The view and camera pose are frozen at that moment, so you can keep walking while it works.
 *  3. The agent finds the WHOLE object you meant in that frozen view, picks a product and prices it.
 *  4. Gemini edits the photo; the edit is projected back into the tour from that exact scan point.
 *  5. An independent reviewer (OpenAI, Gemini fallback) checks before/after; if it's not a clear, finished,
 *     believable result it is re-rendered with the reviewer's fix (up to 2 retries).
 *  6. A second viewer pre-renders verified edits for neighboring scan points from their original photos.
 */
const H = window.HOME;
const NEEDS = (new URLSearchParams(location.search).get('needs') || '').split(',').filter(Boolean);
const STORE = `frontdoor-v3-${H.id}`;
const BUDGET = (() => { try { return +sessionStorage.getItem('fd-budget') || 0; } catch { return 0; } })();
let PERSONA = (() => { try { return sessionStorage.getItem('fd-persona') || ''; } catch { return ''; } })();
const $ = (s, r = document) => r.querySelector(s);
const money = (n) => '$' + Math.round(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const soon = (p, ms = 4000) => Promise.race([Promise.resolve(p).catch(() => null), sleep(ms)]);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let sdk = null, info = null;
let mode = 'walk', view = 'after';
let poseCache = null, lastSweep = null, stationedSweep = '';
let selections = [];
let edits = [];
const live = {};                 // editId -> {patches: {sweepId: node}}
const selFor = new Map();        // editId -> selection (frozen frame, kept in memory)
let chatHistory = [];
let agentBusy = false, agentAbort = false;
const keyOf = (room, title) => `${room}|${String(title).toLowerCase()}`;
const declined = new Set((() => { try { return JSON.parse(localStorage.getItem(`frontdoor-declined-${window.HOME.id}`) || '[]'); } catch { return []; } })());
const saveDeclined = () => { try { localStorage.setItem(`frontdoor-declined-${H.id}`, JSON.stringify([...declined])); } catch {} };
// Everything the agent should know about what's already been done in this home
const stateForAgent = (roomId) => edits.filter((x) => x.status === 'ready').map((x) => ({
  room: x.room, same_room: x.roomId === roomId, object_id: x.objectId, kind: x.kind,
  change: x.title, replaced: x.item, product: x.option?.name, shown: x.on !== false,
}));

/* ================= boot ================= */
const iframe = $('#showcase');
const showcaseUrl = `/bundle/showcase.html?m=${H.matterport_id}&play=1&qs=1&brand=0&help=0&mls=2&applicationKey=${encodeURIComponent(window.SDK_KEY)}`;
iframe.src = showcaseUrl;
iframe.addEventListener('load', async () => {
  try {
    sdk = await iframe.contentWindow.MP_SDK.connect(iframe.contentWindow);
    let stateSub;
    const ready = await soon(new Promise((resolve) => {
      stateSub = sdk.App.state.subscribe((s) => { if (s.phase === sdk.App.Phase.PLAYING) resolve(true); });
    }), 25000);
    stateSub?.cancel();
    if (!ready) throw new Error('The property scan did not finish loading.');
    window.hmSdk = sdk;
    sdk.Sweep.current.subscribe((s) => { stationedSweep = s.id || s.sid || ''; refreshVisibility(); scheduleCoverage(); });
    sdk.Camera.pose.subscribe(onPose);
    await Promise.all([sdk.Scene.register('fd.photo', () => new PhotoPatch()), sdk.Scene.register('fd.sandra', () => new SandraRover())]);
    rover = await addNode('fd.sandra', { shown: false, reduced: reducedRoverMotion.matches });
    await Promise.all([loadRooms(), restoreEdits()]);
    $('#hint').style.opacity = 0;
    await welcome();
  } catch (e) { console.error(e); window.sandraShowcase?.unavailable(); }
});

/* ================= photo patches ================= */
function PhotoPatch() {
  this.inputs = { url: '', corners: [], visible: true };
  this.onInit = function () {
    const T = this.context.three, c = this.inputs.corners;
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([c[0], c[1], c[2], c[3]].flatMap((p) => [p.x, p.y, p.z]), 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 3, 1, 1, 3, 2]);
    const tex = new T.TextureLoader().load(this.inputs.url, () => {
      this.loaded = true;
      if (this.outputs.objectRoot) this.apply();
    });
    if ('colorSpace' in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
    tex.anisotropy = 8;
    this.mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
    this.mesh.renderOrder = 3000; this.mesh.frustumCulled = false;
    this.outputs.objectRoot = this.mesh; this.apply();
  };
  this.apply = function () { this.outputs.objectRoot.visible = !!this.loaded && this.inputs.visible; };
  this.onInputsUpdated = function () { this.apply(); };
  this.onDestroy = function () {
    this.mesh.geometry.dispose();
    this.mesh.material.map.dispose();
    this.mesh.material.dispose();
  };
}
async function addNode(component, inputs) {
  const [obj] = await sdk.Scene.createObjects(1);
  const n = obj.addNode();
  const instance = n.addComponent(component, inputs);
  obj.start();
  return { component: instance, stop: () => obj.stop() };
}

/* ================= camera math ================= */
function rayDir(px, py, pose) {
  const W = pose.W || iframe.clientWidth, Hh = pose.H || iframe.clientHeight, P = pose.projection;
  const nx = (px / W) * 2 - 1, ny = -((py / Hh) * 2 - 1);
  // Showcase stores the projection matrix in row-major order.
  const x = (nx + (P ? P[2] : 0)) / (P ? P[0] : 1.2), y = (ny + (P ? P[6] : 0)) / (P ? P[5] : 1.2), z = -1;
  const pitch = pose.rotation.x * Math.PI / 180, yaw = pose.rotation.y * Math.PI / 180;
  const y2 = y * Math.cos(pitch) - z * Math.sin(pitch), z2 = y * Math.sin(pitch) + z * Math.cos(pitch);
  const x3 = x * Math.cos(yaw) + z2 * Math.sin(yaw), z3 = -x * Math.sin(yaw) + z2 * Math.cos(yaw);
  const L = Math.hypot(x3, y2, z3);
  return { x: x3 / L, y: y2 / L, z: z3 / L };
}
function patchCorners(rectN, pose, anchor) {
  const W = pose.W || iframe.clientWidth, Hh = pose.H || iframe.clientHeight, c = pose.position;
  const fwd = rayDir(W / 2, Hh / 2, pose);
  const d = anchor ? Math.max(0.25, (anchor.x - c.x) * fwd.x + (anchor.y - c.y) * fwd.y + (anchor.z - c.z) * fwd.z) : 2;
  return [[rectN[0], rectN[1]], [rectN[2], rectN[1]], [rectN[2], rectN[3]], [rectN[0], rectN[3]]].map(([u, v]) => {
    const r = rayDir(u * W, v * Hh, pose), k = d / (r.x * fwd.x + r.y * fwd.y + r.z * fwd.z);
    return { x: c.x + r.x * k, y: c.y + r.y * k, z: c.z + r.z * k };
  });
}
const snapPose = (p = poseCache, target = iframe) => ({ sweep: p.sweep, mode: p.mode, position: { ...p.position }, rotation: { ...p.rotation },
  projection: p.projection ? Array.from(p.projection) : null, W: target.clientWidth, H: target.clientHeight });
function samePosition(a, b) {
  return a?.mode === 'mode.inside' && b?.mode === 'mode.inside' && a.sweep === b.sweep && dist(a.position, b.position) < 0.025;
}
function sameFrame(a, b) {
  return samePosition(a, b) && a.W === b.W && a.H === b.H &&
    Math.abs(((a.rotation.y - b.rotation.y + 540) % 360) - 180) < 0.25 &&
    Math.abs(a.rotation.x - b.rotation.x) < 0.25 && Math.abs((a.projection?.[5] || 0) - (b.projection?.[5] || 0)) < 0.005;
}
async function hitAt(x, y, viewer = sdk) {
  try { return (await viewer.Renderer.getWorldPositionData({ x, y })).position; } catch { return null; }
}
/* Resolve routes exclusively against scan points in the active viewer. */
function sweepPath(start, target) {
  const byId = new Map(sweepList.filter((s) => s.enabled !== false).map((s) => [s.id, s]));
  if (!byId.has(start) || !byId.has(target)) return [];
  const previous = new Map([[start, null]]), queue = [start];
  for (const id of queue) {
    if (previous.has(target)) break;
    for (const neighbor of byId.get(id).neighbors || []) {
      if (previous.has(neighbor) || !byId.has(neighbor)) continue;
      previous.set(neighbor, id);
      queue.push(neighbor);
    }
  }
  if (!previous.has(target)) return [];
  const path = [];
  for (let id = target; id && id !== start; id = previous.get(id)) path.unshift(byId.get(id));
  return path;
}
async function visitSweep(id, transition, duration, active) {
  if (!active()) return false;
  // A move sent while the previous flight is still finishing is rejected; wait it out and retry once.
  for (let attempt = 0; attempt < 2 && active() && stationedSweep !== id; attempt++) {
    await soon(sdk.Sweep.moveTo(id, { transition: attempt ? sdk.Sweep.Transition.FADEOUT : transition,
      transitionTime: attempt ? 360 : duration }), 5000);
    for (let i = 0; i < 25 && active() && stationedSweep !== id; i++) await sleep(80);
  }
  return active() && stationedSweep === id;
}
async function walkTo(target, { active = () => true, roomJump = false } = {}) {
  if (!poseCache || !sweepList.some((s) => s.id === target && s.enabled !== false)) return false;
  if (stationedSweep === target) return true;
  const path = sweepPath(stationedSweep || poseCache.sweep, target);
  const transition = sdk.Sweep.Transition;
  if (!path.length) return visitSweep(target, transition.FADEOUT, 480, active);
  for (const step of path) {
    if (!active()) return false;
    if (agentBusy) roverToSweep(step.id);
    const reduced = roomJump && reducedRoverMotion.matches;
    if (!await visitSweep(step.id, reduced ? transition.FADEOUT : transition.FLY, reduced ? 260 : 530, active)) return false;
  }
  return true;
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
function stopAgentSoft() { window.sandraShowcase?.takeControl(); }
// Camera.setRotation is sometimes ignored by the SDK; rotate (yaw -h, pitch +v) and verify.
async function lookAt(rot, speed = 10000, active = () => true) {     // speed in degrees/second; ~90 looks like turning your head
  const off = () => { const c = poseCache.rotation; return { dy: ((rot.y - c.y + 540) % 360) - 180, dx: rot.x - c.x }; };
  for (let k = 0; k < 4; k++) {
    if (!active()) return false;
    const { dy, dx } = off();
    if (Math.abs(dy) < 0.6 && Math.abs(dx) < 0.6) return true;
    const ms = Math.min(4000, (Math.max(Math.abs(dy), Math.abs(dx)) / speed) * 1000);
    await soon(sdk.Camera.rotate(-dy, dx, { speed }), ms + 2500); await sleep(k ? 250 : Math.max(250, ms * 0.15));
    speed = Math.max(speed, 300);   // small corrections can be quick
  }
  if (!active()) return false;
  let { dy, dx } = off();
  if (Math.abs(dy) < 1.5 && Math.abs(dx) < 1.5) return true;
  // The animated turn can stall (busy or background tab). Setting the view at this scan point always lands.
  if (poseCache?.sweep) {
    await soon(sdk.Sweep.moveTo(poseCache.sweep, { rotation: { x: rot.x, y: rot.y }, transition: sdk.Sweep.Transition.INSTANT }), 3000);
    await sleep(200);
    ({ dy, dx } = off());
  }
  return Math.abs(dy) < 1.5 && Math.abs(dx) < 1.5;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
async function sampleSelection(r, pose) {
  const samples = [];
  for (const span of [1, 2.5]) {
    for (let row = -2; row <= 2; row++) for (let col = -2; col <= 2; col++) {
      if (span !== 1 && row === 0 && col === 0) continue;
      const x = r.x + r.w * (0.5 + col * span / 5);
      const y = r.y + r.h * (0.5 + row * span / 5);
      if (x >= 0 && x < pose.W && y >= 0 && y < pose.H) samples.push({ x, y });
    }
  }
  const hits = await Promise.all(samples.map(async (s) => ({ ...s, point: await hitAt(s.x, s.y) })));
  return hits.filter((s) => s.point && Number.isFinite(s.point.x) && dist(s.point, pose.position) > 0.10);
}
function worldFromRect(r, hits, pose) {
  const inside = hits.filter((s) => s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h);
  if (!inside.length) return null;
  const distanceToMiddle = (s) => Math.hypot((s.x - r.x) / r.w - 0.5, (s.y - r.y) / r.h - 0.5);
  const seed = [...inside].sort((a, b) => distanceToMiddle(a) - distanceToMiddle(b))[0].point;
  const depth = dist(pose.position, seed);
  const tolerance = Math.max(0.45, Math.min(1.2, depth * 0.35));
  const points = inside.map((s) => s.point).filter((p) => Math.abs(dist(pose.position, p) - depth) < tolerance);
  const bounds = ['x', 'y', 'z'].map((axis) => {
    const coords = points.map((p) => p[axis]);
    return [pct(coords, 0.04), pct(coords, 0.96)];
  });
  const [[x0, x1], [y0, y1], [z0, z1]] = bounds;
  return { center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    w: Math.max(0.25, x1 - x0), h: Math.max(0.25, y1 - y0), d: Math.max(0.25, z1 - z0), points };
}
function projectBox(world, pose, viewer, { w: W, h: Hh }) {
  const xs = [], ys = [];
  const screen = (p) => viewer.Conversion.worldToScreen(p, pose, { w: W, h: Hh });
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const q = screen({ x: world.center.x + x * world.w / 2, y: world.center.y + y * world.h / 2, z: world.center.z + z * world.d / 2 });
    if (!q || !Number.isFinite(q.x + q.y + q.z) || q.z > 1 || q.z < -1) return null;
    xs.push(q.x); ys.push(q.y);
  }
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  const r = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(W, Math.max(...xs)), y1: Math.min(Hh, Math.max(...ys)) };
  if (r.x1 - r.x0 < 30 || r.y1 - r.y0 < 30 || (r.x1 - r.x0) * (r.y1 - r.y0) < 0.6 * width * height) return null;
  return r;
}

/* ================= rooms ================= */
let sweepList = [], roomList = [], roomIdx = 0;
let roomNavigation = Promise.resolve(), requestedRoom = null, roomRequest = 0;
async function collect(obs, wait = 4300) {
  let latest = [], settle, timeout, sub;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(settle); clearTimeout(timeout); sub?.cancel?.(); resolve(latest); };
    timeout = setTimeout(done, wait);
    sub = obs.subscribe({ onCollectionUpdated: (collection) => {
      const batch = Object.values(collection);
      if (!batch.length) return;
      latest = batch;
      clearTimeout(settle);
      settle = setTimeout(done, 420);
    } });
  });
}
async function loadRooms() {
  const [sweeps, sdkRooms] = await Promise.all([collect(sdk.Sweep.data), collect(sdk.Room.data, 1800).catch(() => [])]);
  sweepList = sweeps;
  let rooms = sdkRooms;
  if (!rooms.filter((r) => r.label).length) {
    rooms = (info?.scan?.rooms || []).map((r) => ({ id: r.id, label: r.type }));
  }
  const bySweep = {};
  for (const s of sweepList) if (s.enabled !== false && s.roomInfo?.id) (bySweep[s.roomInfo.id] ||= []).push(s);
  roomList = rooms.filter((r) => r.label && bySweep[r.id]).map((r) => ({ id: r.id, label: r.label.split(/,| \/ /)[0].trim(), sweeps: bySweep[r.id] }));
  if (!roomList.length) {
    roomList = Object.entries(bySweep).map(([id, sweeps], index) => ({ id, label: 'Room ' + (index + 1), sweeps }));
  }
  const n = {}; roomList.forEach((r) => { n[r.label] = (n[r.label] || 0) + 1; r.k = n[r.label]; });
  roomList.forEach((r) => { if (n[r.label] > 1) r.label += ' ' + r.k; });
  $('#room-nav').classList.toggle('hidden', !roomList.length);
  updateRoomLabel();
}
const currentRoom = () => { const s = sweepList.find((x) => x.id === lastSweep); return roomList.find((r) => r.id === s?.roomInfo?.id); };
function centerSweep(r) {
  const cx = r.sweeps.reduce((a, s) => a + s.position.x, 0) / r.sweeps.length, cz = r.sweeps.reduce((a, s) => a + s.position.z, 0) / r.sweeps.length;
  return [...r.sweeps].sort((a, b) => Math.hypot(a.position.x - cx, a.position.z - cz) - Math.hypot(b.position.x - cx, b.position.z - cz))[0];
}
function updateRoomLabel() {
  const actual = currentRoom();
  if (actual) roomIdx = roomList.indexOf(actual);
  const label = $('#room-name');
  label.textContent = requestedRoom == null ? actual?.label || 'Between rooms' : 'To ' + roomList[requestedRoom].label + '…';
  label.setAttribute('aria-busy', String(requestedRoom != null));
}
function goRoom(i) {
  if (!roomList.length) return;
  const release = stopAgent();
  window.emptyRoom?.leave();
  switchView('tour');
  setMode('walk');
  requestedRoom = (i + roomList.length) % roomList.length;
  const room = roomList[requestedRoom], request = ++roomRequest;
  const active = () => request === roomRequest;
  updateRoomLabel();
  roomNavigation = roomNavigation.then(async () => {
    await release;
    if (!active()) return;
    const closest = centerSweep(room);
    const origin = stationedSweep || poseCache.sweep;
    const reachable = (s) => s.id === origin || sweepPath(origin, s.id).length;
    const target = reachable(closest) ? closest : room.sweeps.find(reachable) || closest;
    const arrived = await walkTo(target.id, { active, roomJump: true });
    if (!arrived && active()) hint('Could not reach ' + esc(room.label) + '. Try again.', 3500);
  }).catch((err) => {
    console.warn('Room navigation', err);
    if (active()) hint('Could not reach ' + esc(room.label) + '. Try again.', 3500);
  }).finally(() => {
    if (!active()) return;
    requestedRoom = null;
    updateRoomLabel();
  });
  return roomNavigation;
}
$('#room-prev').onclick = () => goRoom((requestedRoom ?? roomIdx) - 1);
$('#room-next').onclick = () => goRoom((requestedRoom ?? roomIdx) + 1);
$('#room-name').onclick = () => {
  const menu = $('#room-menu'), label = $('#room-name');
  menu.replaceChildren(...roomList.map((room, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'block w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-100';
    button.textContent = room.label;
    button.onclick = () => { menu.classList.add('hidden'); label.setAttribute('aria-expanded', 'false'); goRoom(index); };
    return button;
  }));
  label.setAttribute('aria-expanded', String(!menu.classList.toggle('hidden')));
};

/* ================= scan-point previews ================= */
function onPose(p) {
  poseCache = p;
  if (rover && p.mode !== 'mode.inside') rover.component.inputs.shown = false;
  if (p.sweep !== lastSweep) {
    lastSweep = p.sweep;
    updateRoomLabel();
    scheduleCoverage();
    if (!agentBusy && !window.sandraShowcase?.playing && p.mode === 'mode.inside') {
      setTimeout(() => { if (!window.sandraShowcase?.playing) setRoverState('idle'); }, 450);
    }
  }
  refreshVisibility();
  overlay.querySelectorAll('.sel-box').forEach((e) => e.remove());
  if (spotFor && (p.sweep !== spotFor.sweep || Math.abs(((p.rotation.y - spotFor.rot.y + 540) % 360) - 180) + Math.abs(p.rotation.x - spotFor.rot.x) > 2)) clearSpot();
  if (mode === 'select') hideMenu();
  if (mode === 'walk' && edits.some((e) => e.source && !e.patches.some((patch) => patch.sweep === p.sweep))) scheduleCoverage();
}
function refreshVisibility() {
  window.sandraShowcase?.refreshPreview();
  for (const e of edits) {
    for (const p of e.patches) {
      const component = live[e.id]?.patches[p.sweep]?.component;
      if (!component) continue;
      const visible = !capturingOriginal && view === 'after' && e.on !== false && e.status === 'ready' &&
        stationedSweep === p.sweep && samePosition(p.pose, poseCache);
      if (component.inputs.visible !== visible) component.inputs.visible = visible;
    }
  }
}

let captureQueue = Promise.resolve();
let capturingOriginal = false;
function nearbySweeps(e, origin) {
  const byId = new Map(sweepList.map((s) => [s.id, s]));
  const source = byId.get(origin);
  if (!source || !e.world?.points.length) return [];
  const seen = new Set([origin]), queue = [{ sweep: source, steps: 0 }], candidates = [];
  for (const { sweep, steps } of queue) {
    if (steps === 2) continue;
    for (const id of sweep.neighbors || []) {
      const next = byId.get(id);
      if (!next || seen.has(id) || next.floorInfo?.id !== source.floorInfo?.id) continue;
      seen.add(id);
      queue.push({ sweep: next, steps: steps + 1 });
      if (dist(next.position, e.world.center) < 4.5) candidates.push({ sweep: next, steps: steps + 1 });
    }
  }
  return candidates.sort((a, b) => a.steps - b.steps ||
    dist(a.sweep.position, e.world.center) - dist(b.sweep.position, e.world.center)).slice(0, 5).map((c) => c.sweep);
}
function queueNearbyCapture(e, pose, revision, sweeps = nearbySweeps(e, pose.sweep)) {
  if (!sweeps.length) return Promise.resolve([]);
  const capture = captureQueue.then(() => activeEdit(e, revision) ? captureNearby(e, sweeps, revision) : []);
  captureQueue = capture.catch((err) => {
    console.warn('Nearby preview capture failed:', err);
    return [];
  });
  return captureQueue;
}
async function captureNearby(e, sweeps, revision) {
  // Showcase pauses painting when fully hidden. Expose two pixels without covering the live tour.
  const frame = document.createElement('iframe');
  frame.className = 'sandra-scout absolute inset-0 w-full h-full pointer-events-none';
  frame.style.cssText = 'z-index:1;border:0;clip-path:inset(calc(100% - 2px) 0 0 calc(100% - 2px))';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  let poses, state, current;
  try {
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    frame.src = showcaseUrl;
    iframe.before(frame);
    const viewer = await soon(loaded.then(() => frame.contentWindow.MP_SDK.connect(frame.contentWindow)), 20000);
    if (!viewer) throw new Error('Background tour did not connect');
    const ready = await soon(new Promise((resolve) => {
      state = viewer.App.state.subscribe((s) => { if (s.phase === viewer.App.Phase.PLAYING) resolve(true); });
    }), 20000);
    if (!ready) throw new Error('Background tour did not start');
    let pose, stationed = '';
    poses = viewer.Camera.pose.subscribe((p) => { pose = p; });
    current = viewer.Sweep.current.subscribe((s) => { stationed = s.id || s.sid || ''; });
    const views = [];
    for (const sweep of sweeps) {
      if (!activeEdit(e, revision) || views.length === 3) break;
      const dx = e.world.center.x - sweep.position.x, dy = e.world.center.y - sweep.position.y, dz = e.world.center.z - sweep.position.z;
      const rotation = { x: Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI, y: Math.atan2(-dx, -dz) * 180 / Math.PI };
      const moved = await soon(viewer.Sweep.moveTo(sweep.id, { rotation, transition: viewer.Sweep.Transition.INSTANT }).then(() => true), 6500);
      if (!moved) break;
      const atSweep = () => stationed === sweep.id && pose?.sweep === sweep.id && pose.mode === 'mode.inside';
      for (let i = 0; i < 15 && !atSweep(); i++) await sleep(100);
      if (!atSweep()) continue;
      await sleep(350);
      for (let attempt = 0; attempt < 2 && atSweep() && activeEdit(e, revision); attempt++) {
        // Keep the SDK's native typed projection for its conversion functions.
        const sdkPose = pose;
        const snap = snapPose(sdkPose, frame);
        const size = { w: snap.W, h: snap.H };
        const box = projectBox(e.world, sdkPose, viewer, size);
        if (!box) break;
        const hits = await visiblePoints(e.world, sdkPose, viewer, size);
        if (hits.length < 2) break;
        const image = await captureReadyFrame(viewer, frame);
        if (!image || !atSweep() || !sameFrame(snap, snapPose(pose, frame))) {
          await sleep(225);
          continue;
        }
        const hint = [box.y0 / snap.H, box.x0 / snap.W, box.y1 / snap.H, box.x1 / snap.W].map((n) => Math.round(n * 1000));
        views.push({ image, pose: snap, hint, hits, roomId: sweep.roomInfo?.id || e.roomId });
        break;
      }
    }
    return views;
  } finally {
    poses?.cancel();
    state?.cancel();
    current?.cancel();
    frame.remove();
  }
}
async function captureReadyFrame(viewer, frame) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const delay of [350, 600, 900, 1250, 1500, 0]) {
    const image = await soon(grabFrame(viewer, frame), 4500);
    if (!image) break;
    const img = new Image();
    img.src = image;
    await img.decode();
    ctx.drawImage(img, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 55) lit++;
    }
    if (lit >= 12) return image;
    if (delay) await sleep(delay);
  }
  return null;
}
async function visiblePoints(world, pose, viewer, size) {
  const step = Math.max(1, Math.floor(world.points.length / 9));
  const candidates = world.points.filter((_, i) => i % step === 0).slice(0, 16);
  const hits = await Promise.all(candidates.map(async (p) => {
    const q = viewer.Conversion.worldToScreen(p, pose, size);
    if (!q || q.z < -1 || q.z > 1 || q.x < 0 || q.y < 0 || q.x >= size.w || q.y >= size.h) return null;
    const hit = await hitAt(q.x, q.y, viewer);
    return hit && dist(hit, p) < 0.24 ? { x: q.x, y: q.y, point: p } : null;
  }));
  return hits.filter(Boolean);
}
function boxRect(box, pose) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) return null;
  const [y0, x0, y1, x1] = box;
  if (x1 - x0 < 10 || y1 - y0 < 10) return null;
  return { x: x0 / 1000 * pose.W, y: y0 / 1000 * pose.H, w: (x1 - x0) / 1000 * pose.W, h: (y1 - y0) / 1000 * pose.H };
}
function covers(outer, inner, fraction) {
  if (!outer || !inner) return false;
  const w = Math.max(0, Math.min(outer.x + outer.w, inner.x + inner.w) - Math.max(outer.x, inner.x));
  const h = Math.max(0, Math.min(outer.y + outer.h, inner.y + inner.h) - Math.max(outer.y, inner.y));
  return w * h >= fraction * inner.w * inner.h;
}
function angleRect(f, pose, scope) {
  const target = isObjectRect(f.box_2d, pose);
  const rect = scope === 'roll_under_sink' ? isObjectRect(f.edit_box_2d, pose) : target;
  return covers(target, rect, 0.92) ? { target, rect } : null;
}
function editPolygon(f, pose, r) {
  const poly = f.edit_polygon_2d;
  if (!r || !Array.isArray(poly) || poly.length < 4 || poly.length > 16) return null;
  if (poly.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 1000))) return null;
  const points = poly.map(([y, x]) => [x / 1000, y / 1000]);
  if (!points.every(([x, y]) => x * pose.W >= r.x - 6 && x * pose.W <= r.x + r.w + 6 &&
    y * pose.H >= r.y - 6 && y * pose.H <= r.y + r.h + 6)) return null;
  const area = Math.abs(points.reduce((sum, [x, y], i) => {
    const [u, v] = points[(i + 1) % points.length];
    return sum + x * v - y * u;
  }, 0)) * pose.W * pose.H / 2;
  return area >= r.w * r.h * 0.25 ? points : null;
}
function paddedRect(r, pose, padding = 0.015) {
  const pad = padding * Math.max(r.w, r.h);
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  return { x, y, w: Math.min(pose.W, r.x + r.w + pad) - x, h: Math.min(pose.H, r.y + r.h + pad) - y };
}
async function locateNearby(e, sel, views, revision) {
  if (!views.length || !activeEdit(e, revision)) return [];
  const source = await annotate({ frame: sel.frame, pose: sel.pose, rect: sel.targetRect || sel.rect });
  if (!source) return [];
  const observations = await identifyViews(views).catch(() => []);
  const result = await postEdit('agent/locate-angles', {
    source, item: e.item || e.title, scope: e.scope, clear_cabinet: e.clearCabinet,
    views: views.map(({ image, hint }, i) => ({ image, hint, objects: (observations[i] || []).slice(0, 40) })),
  });
  const angles = [];
  for (const [i, v] of views.entries()) {
    const f = (result.angles || []).find((a) => a.view === i);
    const located = f && angleRect(f, v.pose, e.scope);
    if (!located || !covers(boxRect(v.hint, v.pose), located.target, 0.35)) continue;
    const r = paddedRect(located.target, v.pose, 0.1);
    const aligned = v.hits.filter(({ x, y }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (aligned.length < 2) continue;
    const fixture = recognized[e.objectId];
    if (fixture) {
      fixture.views[viewKey(v.pose)] = [e.scope === 'roll_under_sink' ? f.edit_box_2d : f.box_2d];
      fixture.touched = Date.now();
    }
    angles.push({ frame: v.image, pose: v.pose, rect: located.rect, targetRect: located.target,
      poly: editPolygon(f, v.pose, located.rect), extra: true });
  }
  if (angles.length) saveInventory();
  return angles;
}

/* ================= rendering ================= */
async function grabFrame(viewer = sdk, target = iframe) {
  const W = target.clientWidth, Hh = target.clientHeight, k = Math.min(2, 1600 / W);
  return viewer.Renderer.takeScreenShot({ width: Math.round(W * k), height: Math.round(Hh * k) }, {
    mattertags: false, sweeps: false, measurements: false, views: false,
  });
}
function taskText(e) {
  const what = e.custom || (e.option ? e.option.name + ' (' + e.option.spec + ')' : e.title);
  if (e.scope === 'roll_under_sink') {
    const open = 'Keep the existing countertop, basin, faucet, wall, and height. Create a full-height, full-depth opening under the basin with finished floor and protected, recessed plumbing.';
    if (e.clearCabinet) return open + ' Remove ALL base cabinets and cabinet frames under this countertop. Use discreet wall brackets or concealed support. Keep the whole area open with no shelves, doors, cabinets, furniture legs or toe-kick.';
    return open + ' Keep cabinetry outside the requested opening.';
  }
  if (e.action === 'remove') return 'Remove ' + (e.item || 'the selected item') + ' and continue the surrounding floor and wall. ' + (e.custom || '');
  if (e.action === 'add') return 'Install ' + what + '. Purpose: ' + e.title + '.';
  return 'Replace ' + (e.item || 'the selected item') + ' in its existing position with ' + what + '. Purpose: ' + e.title + '.';
}
async function postEdit(endpoint, body) {
  const response = await fetch('/api/home/' + H.id + '/' + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'The preview request failed.');
  return data;
}
function activeEdit(e, revision) {
  return edits.includes(e) && e.revision === revision;
}
async function renderAngle(e, angle, revision, ref = null) {
  let fix = null;
  const { frame, pose, rect, extra } = angle;
  // Edit generously around the fixture: surrounds, trim, wall above and floor in front change with it, and the
  // wide feathered margin lets the new work fade into the real photo instead of ending at a hard box.
  const big = /shower|tub|bath|vanity|cabinet|counter|door|wall|floor|stair|ramp|island|closet|bar\b|kitchen|surround/i.test((e.title || '') + ' ' + (e.item || ''));
  // generous above and below (surround, ceiling line, floor in front), tight to the sides where neighbors sit
  const vpad = (big ? 0.15 : 0.07) * Math.max(rect.w, rect.h), hpad = (big ? 0.04 : 0.05) * Math.max(rect.w, rect.h);
  let region = rect;
  if (e.scope !== 'roll_under_sink') {
    const x = Math.max(0, rect.x - hpad), y = Math.max(0, rect.y - vpad);
    region = { x, y, w: Math.min(pose.W, rect.x + rect.w + hpad) - x, h: Math.min(pose.H, rect.y + rect.h + vpad) - y };
  }
  if (/shower|tub|bath/i.test((e.title || '') + ' ' + (e.item || '')) && e.scope !== 'roll_under_sink') {
    const top = Math.max(0, region.y - region.h * 0.35);       // surrounds run up toward the ceiling
    region = { ...region, y: top, h: region.y + region.h - top };
  }
  const norm = [region.x / pose.W, region.y / pose.H, (region.x + region.w) / pose.W, (region.y + region.h) / pose.H];
  const task = taskText(e);
  for (let attempt = 0; attempt < (extra ? 2 : 3); attempt++) {
    if (!activeEdit(e, revision)) return null;
    if (!extra) setStatus(e, attempt ? 'fixing' : 'rendering', { tries: attempt });
    const meta = await postEdit('render', { image: frame, rect: norm, task, scope: e.scope, ref, fix, poly: angle.poly });
    if (!activeEdit(e, revision)) return null;
    if (!extra) setStatus(e, 'checking');
    const q = await postEdit('verify', { rid: meta.id, task, scope: e.scope, ref });
    if (!extra && activeEdit(e, revision)) { e.score = q.score; e.review = q; }
    if (q.ok === true && Number(q.score) >= 7) {
      return { sweep: pose.sweep, rid: meta.id, corners: patchCorners(meta.rect, pose, e.world?.center),
        pose: { mode: pose.mode, sweep: pose.sweep, position: pose.position }, rot: pose.rotation, rectN: meta.rect, extra: !!extra };
    }
    fix = [q.fix, ...(q.issues || [])].filter(Boolean).join('. ');
    if (!fix) break;
  }
  return null;
}
async function mountPatch(e, p, revision) {
  const n = await addNode('fd.photo', { url: '/api/home/' + H.id + '/render/' + p.rid + '/patch', corners: p.corners, visible: false });
  if (!activeEdit(e, revision)) { n.stop(); return false; }
  const nodes = (live[e.id] ||= { patches: {} }).patches;
  nodes[p.sweep]?.stop();
  nodes[p.sweep] = n;
  return true;
}
function clearPatches(e) {
  Object.values(live[e.id]?.patches || {}).forEach((n) => n.stop());
  delete live[e.id];
  e.patches = [];
}
async function renderNearby(e, angles, revision, ref) {
  const candidates = await angles;
  if (!activeEdit(e, revision) || !candidates.length) return;
  const card = jobCard({ id: e.id + '-angles', title: e.title, step: 'Preparing nearby views', pct: 70, busy: true });
  try {
    for (const angle of candidates) {
    if (!activeEdit(e, revision)) return;
      try {
        if (e.patches.some((p) => p.sweep === angle.pose.sweep)) continue;
        const p = await renderAngle(e, angle, revision, ref);
        if (p && await mountPatch(e, p, revision)) { e.patches.push(p); save(); refreshVisibility(); }
      } catch (err) { console.warn('Nearby preview rejected:', err); }
    }
  } finally { card.remove(); }
}

/* ================= processing window ================= */
let QUEUE_MODE = true;
const STEPS = { queued: ['On your list', 40], understanding: ['Understanding your request', 15], designing: ['Choosing the product & price', 35], rendering: ['Rendering it into your home', 60],
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
    img.onerror = () => res(null);
    img.src = sel.frame;
  });
}
let tourDecision = null;
let draftReply = null;
let renovationPreference = 'Prioritize small installations and reversible changes. Ask before structural work.';
function ask(html, buttons, loc = null) {
  return new Promise((resolve) => {
    tourDecision?.('stop');
    const pane = $('#guide-task');
    const el = bubble(html + '<div class="decision-buttons">' + buttons.map(([key, label], i) =>
      '<button type="button" data-k="' + key + '" class="' + (i ? 'sandra-secondary' : 'sandra-primary') + '">' + label + '</button>').join('') + '</div>', 'ai', loc);
    if (pane) pane.replaceChildren(el);
    const finish = (key) => {
      if (tourDecision === finish) tourDecision = null;
      draftReply = null;
      el.remove();          // one message at a time: the answered question leaves the card
      resolve(key);
    };
    tourDecision = finish;
    el.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => finish(b.dataset.k); });
  });
}
function newEdit(sel, fields) {
  const e = { id: 'e' + crypto.randomUUID(), title: 'Finding the fixture', action: 'replace', item: sel.item || '',
    option: null, options: [], custom: '', world: sel.world, cost: 0, patches: [], on: true, room: sel.roomLabel || '',
    roomId: sel.roomId || null, status: 'understanding', crop: sel.crop, tries: 0, ...fields };
  selFor.set(e.id, sel); edits.push(e); save(); renderPlan(); showJob(e);
  return e;
}
function setStatus(e, s, extra = {}) {
  Object.assign(e, extra, { status: s }); save(); renderPlan(); showJob(e);
}
function editScope(f, instruction) {
  const sink = /\b(sink|vanity|basin)\b/i.test([f.item, f.title, instruction].join(' '));
  const clearance = /roll[- ]under|knee|toe clearance|pull under|(?:sink|vanity).{0,32}wheelchair|wheelchair.{0,30}(?:sink|vanity)/i.test([f.title, instruction].join(' '));
  return f.scope === 'roll_under_sink' || (sink && clearance) ? 'roll_under_sink' : 'general';
}
function editTarget(sel, f, instruction, objects = []) {
  const scope = editScope(f, instruction);
  const target = isObjectRect(f.box_2d, sel.pose);
  if (!target) return null;
  const rect = scope === 'roll_under_sink' ? isObjectRect(f.edit_box_2d, sel.pose) : target;
  const renderRect = covers(target, rect, 0.9) ? rect : null;
  if (!renderRect && scope !== 'roll_under_sink') return null;
  if (!sel.whole && !covers(paddedRect(target, sel.pose, 0.12), sel.rect, 0.12) && !covers(sel.rect, target, 0.12)) return null;
  const partWorld = rect && worldFromRect(rect, sel.hits || [], sel.pose);
  const objectWorld = worldFromRect(target, sel.hits || [], sel.pose) || sel.world || partWorld;
  const fixture = fixtureForFinding(f, sel.pose, sel.roomId, partWorld || objectWorld, objects, scope);
  const kind = fixture?.kind || fixtureKind(f.kind || f.item, scope);
  const intent = editIntent(kind, f.title, scope);
  const clearCabinet = scope === 'roll_under_sink' && (f.clear_cabinet === true ||
    /(?:no|remove|without|does not need|do not need|don.t need|just).{0,50}(?:cabin\w+|counter)|(?:cabin\w+).{0,30}(?:all gone|remove|unneeded)/i.test(instruction));
  return { scope, clearCabinet, kind, intent, objectId: fixture?.id, roomId: sel.roomId,
    world: objectWorld, source: { ...sel, targetRect: target, rect: renderRect, poly: editPolygon(f, sel.pose, renderRect) } };
}
async function planSelection(sel, instruction) {
  const [objects = []] = await identifyViews([{ image: sel.frame, pose: sel.pose, hits: sel.hits, roomId: sel.roomId }]).catch(() => []);
  const image = await annotate(sel);
  if (!image) throw new Error('I could not read that frame. Please select the item again.');
  const plan = await postEdit('agent/plan', {
    views: [{ image, room: sel.roomLabel }], needs: NEEDS, persona: PERSONA, instruction, outlined: !sel.whole,
    existing: stateForAgent(sel.roomId), declined: [], inventory: [objects], preferences: renovationPreference,
  });
  return { finding: (plan.findings || [])[0], objects };
}
async function command(sel, instruction, label, finding = null, objects = []) {
  hideMenu(); clearOutline(sel);
  selections = selections.filter((x) => x !== sel); renderSelChips();
  const e = newEdit(sel, { title: label || instruction, instruction });
  try {
    if (!finding) ({ finding, objects } = await planSelection(sel, instruction));
    // A typed request names something that may be behind you: look around this spot before giving up.
    if (!finding && sel.whole && poseCache?.mode === 'mode.inside') {
      const start = { ...poseCache.rotation };
      for (let k = 1; k < 4 && !finding; k++) {
        setStatus(e, 'understanding', { title: 'Looking around for it…' });
        await lookAt({ x: -12, y: start.y + k * 90 }, 160);
        await sleep(450);
        try {
          sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null,
            { silent: true, whole: true });
          selFor.set(e.id, sel);
          ({ finding, objects } = await planSelection(sel, instruction));
        } catch (err) { console.warn('look around', err); }
      }
      if (!finding) await lookAt(start, 160);
      e.title = label || instruction;
    }
    if (!finding) throw new Error('I couldn’t find that from here. Walk to it, or tap ✎ and paint over it.');
    const target = editTarget(sel, finding, instruction, objects);
    if (!target) throw new Error('I could not confirm the target in your selection. Try circling the fixture again.');
    const { source, ...identity } = target;
    const duplicate = edits.find((planned) => matchesEdit(target, planned));
    if (duplicate) {
      if (finding.guided && !finding.revised) {
        removeEdit(e.id, true);
        return duplicate;
      }
      const k = await ask('This fixture already has <b>' + esc(duplicate.title) +
        '</b> in your plan. Apply this revision?', [['replace', 'Apply revision'], ['keep', 'Keep current']]);
      if (k !== 'replace') { removeEdit(e.id, true); return duplicate; }
    }
    const options = finding.options || [], option = options[Math.min(1, options.length - 1)] || null;
    setStatus(e, 'designing', { ...identity, title: finding.title || e.title, action: finding.action || 'replace',
      item: finding.item || '', options, option, cost: option?.total || 0, advice: finding.advice || finding.reason || '',
      custom: finding.guided && !finding.revised ? '' : instruction });
    if (QUEUE_MODE && !finding.now) {
      // The buyer keeps touring; Sandra builds everything at once later and then walks them through it.
      e.pending = source;
      e.replaces = duplicate?.id;
      setStatus(e, 'queued');
      const n = edits.filter((x) => x.status === 'queued').length;
      say('<strong>Added: ' + esc(e.title) + '</strong><p>' + (option ? 'About ' + money(option.total) + ' installed. ' : '') +
        n + ' on your list. Keep looking around, or tap <b>Make my changes</b> when you’re ready.</p>');
      return e;
    }
    await renderAndReview(e, source);
    if (duplicate && e.status === 'ready') removeEdit(duplicate.id, true);
  } catch (err) {
    if (edits.includes(e)) setStatus(e, 'failed', { error: err.message });
  }
  return e;
}

async function renderAndReview(e, sel) {
  const revision = e.revision = (e.revision || 0) + 1;
  const angles = queueNearbyCapture(e, sel.pose, revision)
    .then((views) => locateNearby(e, sel, views, revision))
    .catch((err) => { console.warn('Could not locate nearby views:', err); return []; });
  let source = sel;
  let p = sel.rect ? await renderAngle(e, sel, revision) : null;
  if (!p && e.scope === 'roll_under_sink' && activeEdit(e, revision) && e.review?.reviewer !== 'unavailable') {
    setStatus(e, 'designing');
    for (const angle of await angles) {
      p = await renderAngle(e, { ...angle, extra: false }, revision);
      if (p || !activeEdit(e, revision)) { source = angle; break; }
    }
  }
  if (!activeEdit(e, revision)) return;
  if (!p) throw new Error(e.review?.reviewer === 'unavailable' ? 'The preview could not be verified. Try again.' :
    (e.review?.issues || []).join('. ') || 'I could not confirm a clear view of the cabinet. Try circling it from inside the room.');
  if (!await mountPatch(e, p, revision)) return;
  const mounted = live[e.id].patches;
  for (const sweep of Object.keys(mounted)) {
    if (sweep === p.sweep) continue;
    mounted[sweep].stop();
    delete mounted[sweep];
  }
  e.patches = [p];
  const { pose, rect, targetRect, poly } = source;
  setStatus(e, 'ready', { source: { rid: p.rid, pose, rect, targetRect, poly } });
  refreshVisibility();
  if (!agentBusy) say(`✅ <b>${esc(e.title)}</b> is ready${e.option ? ` · ${esc(e.option.name)} · ${money(e.cost)}` : ''}.`, { sweep: p.sweep, rot: p.rot, rect: p.rectN, label: e.title });
  coverageEager.add(e.id);
  renderNearby(e, angles.then((views) => views.filter((angle) => angle.pose.sweep !== p.sweep)), revision, p.rid)
    .finally(() => { coverageEager.delete(e.id); scheduleCoverage(); });
}

/* ================= selection: draw / box, frozen view, action menu ================= */
const overlay = $('#overlay');
let drag = null, tool = 'lasso';
function setMode(m) {
  mode = m;
  overlay.style.pointerEvents = m === 'select' ? 'auto' : 'none';
  overlay.classList.toggle('paint-cursor', m === 'select');
  $('#mode-select').setAttribute('aria-pressed', String(m === 'select'));
  if (m === 'select') {
    stopAgent(); brushSurface();
    if (!brush.strokes.length) hint('Paint over what you want to change. Then type what to do with it.', 6000);
  } else { hideMenu(); clearBrush(); }
}
function setTool() {}
$('#mode-walk').onclick = () => setMode('walk');
$('#mode-select').onclick = () => setMode(mode === 'select' ? 'walk' : 'select');
let peek = false;
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (brush.strokes.length) { brush.strokes.pop(); drawBrush(); } else undo(); return; }
  if (e.key === 's' || e.key === 'S') setMode('select');
  if (e.key === 'w' || e.key === 'W') setMode('walk');
  if ((e.key === 'b' || e.key === 'B') && !e.repeat && view === 'after') { peek = true; setView('orig'); }
  if (e.key === 'Escape') { clearSelections(); closeDrawers(); setMode('walk'); }
});
document.addEventListener('keyup', (e) => { if ((e.key === 'b' || e.key === 'B') && peek) { peek = false; setView('after'); } });

/* ---- the brush: paint over what you mean, like a highlighter ---- */
const brush = { strokes: [], canvas: null, ctx: null, cursor: null, active: null };
const brushR = () => Math.max(12, Math.min(30, overlay.clientWidth * 0.018));
function brushSurface() {
  if (!brush.canvas) {
    brush.canvas = document.createElement('canvas'); brush.canvas.id = 'brush';
    brush.cursor = document.createElement('div'); brush.cursor.id = 'brush-cursor';
    overlay.append(brush.canvas, brush.cursor);
    brush.ctx = brush.canvas.getContext('2d');
  }
  const k = devicePixelRatio || 1, W = overlay.clientWidth, Hh = overlay.clientHeight;
  if (brush.canvas.width !== Math.round(W * k)) { brush.canvas.width = Math.round(W * k); brush.canvas.height = Math.round(Hh * k); drawBrush(); }
}
function drawBrush() {
  if (!brush.ctx) return;
  const c = brush.ctx, k = devicePixelRatio || 1;
  c.setTransform(k, 0, 0, k, 0, 0); c.clearRect(0, 0, brush.canvas.width, brush.canvas.height);
  c.strokeStyle = c.fillStyle = '#ff5fa2'; c.lineCap = c.lineJoin = 'round';
  for (const s of brush.strokes) {
    c.lineWidth = s.r * 2; c.beginPath();
    s.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    if (s.pts.length === 1) { c.arc(s.pts[0][0], s.pts[0][1], s.r, 0, Math.PI * 2); c.fill(); } else c.stroke();
  }
}
function clearBrush() { brush.strokes = []; brush.active = null; drawBrush(); }
function hull(points) {       // convex hull (monotone chain)
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function brushSelection() {     // the painted area -> outline polygon + bounds
  const pts = [];
  for (const s of brush.strokes) s.pts.forEach(([x, y], i) => {
    if (i % 2 && i !== s.pts.length - 1) return;
    for (let a = 0; a < 8; a++) pts.push([x + Math.cos(a * Math.PI / 4) * s.r, y + Math.sin(a * Math.PI / 4) * s.r]);
  });
  if (!pts.length) return null;
  const W = overlay.clientWidth, Hh = overlay.clientHeight;
  const poly = hull(pts).map(([x, y]) => [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(Hh, y))]);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { r: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, poly };
}
const svgNS = 'http://www.w3.org/2000/svg';
overlay.addEventListener('pointerdown', (e) => {
  if (mode !== 'select' || !sdk || e.button > 0 || e.target.closest('#sel-menu')) return;
  brushSurface();
  const b = overlay.getBoundingClientRect();
  brush.active = { r: brushR(), pts: [[e.clientX - b.left, e.clientY - b.top]] };
  brush.strokes.push(brush.active); drawBrush();
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  const b = overlay.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  if (brush.cursor && mode === 'select') {
    const r = brushR();
    Object.assign(brush.cursor.style, { left: x + 'px', top: y + 'px', width: r * 2 + 'px', height: r * 2 + 'px' });
  }
  if (!brush.active) return;
  const last = brush.active.pts[brush.active.pts.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) < 3) return;
  brush.active.pts.push([x, y]); drawBrush();
});
overlay.addEventListener('pointerup', () => {
  if (!brush.active) return;
  brush.active = null;
  paintedPrompt();
});
// After painting: one question, with the quickest answers as buttons; typing works too.
function paintedPrompt() {
  if (tourDecision) return;
  const el = document.createElement('div');
  el.className = 'msg-in';
  el.innerHTML = '<strong>What should happen to what you painted?</strong><p>Type it below, or pick one. Paint more to add to it.</p>' +
    '<div class="choice-chips"><button data-q="Remove this completely">Remove it</button>' +
    '<button data-q="Make this easier to use for my needs">Make it work for me</button>' +
    '<button data-q="replace">Replace it with…</button><button data-q="clear">Clear paint</button></div>';
  el.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
    const q = b.dataset.q;
    if (q === 'clear') { clearBrush(); setCard(null); return; }
    if (q === 'replace') { $('#chat-input').value = 'Replace it with '; $('#chat-input').focus(); return; }
    submitPainted(q);
  });
  setCard(el);
  $('#chat-input').focus();
}
async function submitPainted(text) {
  const area = brushSelection();
  if (!area) return false;
  setCard(null);
  try {
    const sel = await makeSelection(area.r, area.poly, { silent: true });
    clearBrush(); setMode('walk');
    command(sel, text, text);
  } catch (err) { hint(esc(err.message), 5000); }
  return true;
}
function cropOf(img, r, W, max = 640) {
  const k = img.naturalWidth / W, c = document.createElement('canvas');
  const s = Math.min(1, max / (Math.max(r.w, r.h) * k));
  c.width = Math.max(1, r.w * k * s); c.height = Math.max(1, r.h * k * s);
  c.getContext('2d').drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
async function makeSelection(r, poly = null, opts = {}) {
  if (!poseCache || poseCache.mode !== 'mode.inside' || stationedSweep !== poseCache.sweep || capturingOriginal) {
    throw new Error('Wait until the tour stops, then select the item again.');
  }
  const pose = snapPose();
  const room = currentRoom();
  const outline = opts.silent ? null : screenOutline(r, poly);
  let frame, hits;
  capturingOriginal = true;
  refreshVisibility();
  try {
    [frame, hits] = await Promise.all([soon(grabFrame(), 8000), soon(sampleSelection(r, pose), 8000)]);
    if (!frame || stationedSweep !== pose.sweep || !sameFrame(pose, snapPose())) {
      throw new Error('The camera moved during capture. Circle the item again once it stops.');
    }
  } catch (err) {
    outline?.remove();
    throw err;
  } finally {
    capturingOriginal = false;
    refreshVisibility();
  }
  hits ||= [];
  const world = worldFromRect(r, hits, pose);
  const img = new Image(); img.src = frame; await img.decode();
  const sel = { id: 's' + Date.now(), rect: r, poly, frame, pose, world, hits, box: outline, crop: cropOf(img, r, pose.W), whole: !!opts.whole,
    item: opts.item || '', label: opts.label || 'Your selection', roomLabel: room?.label || '', roomId: room?.id || null };
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
/* Sandra shows ONE message at a time in the card above the input. A question with buttons owns the card until
   it is answered; anything said meanwhile shows briefly as a hint. History is kept (hidden) for issue reports. */
const plainText = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function setCard(el) {
  const pane = $('#guide-task');
  if (el) pane.replaceChildren(el); else pane.replaceChildren();
  $('#sandra-card').classList.toggle('hidden', !pane.childElementCount);
}
new MutationObserver(() => $('#sandra-card').classList.toggle('hidden', !$('#guide-task').childElementCount))
  .observe($('#guide-task'), { childList: true });
function bubble(html, who = 'ai', loc = null) {
  const el = document.createElement('div');
  el.className = 'msg-in';
  el.innerHTML = (loc ? '<button type="button" class="card-loc">📍 Show me where</button>' : '') + '<div>' + html + '</div>';
  if (loc) el.querySelector('.card-loc').onclick = () => goTo(loc);
  const log = document.createElement('div');
  log.textContent = (who === 'user' ? 'You: ' : 'Sandra: ') + plainText(html);
  $('#chat').appendChild(log);
  if (who === 'user') return el;
  if (!tourDecision) setCard(el);
  else if (!/dots/.test(html)) hint(esc(plainText(html)).slice(0, 160), 5000);
  return el;
}
let unread = 0;
const say = (html, loc) => bubble(html, 'ai', loc);
const thinking = (t = 'Thinking') => bubble(`<span class="dots text-slate-500">${t}<span>.</span><span>.</span><span>.</span></span>`);
const CHANGE_RE = /\b(make|turn|change|replace|remove|add|convert|swap|install|get rid|widen|lower|raise|build)\b|\bnot wheelchair friendly\b/i;
$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#chat-input').value.trim(); if (!msg) return;
  window.sandraShowcase?.takeControl();
  $('#chat-input').value = '';
  bubble(esc(msg), 'user'); chatHistory.push({ role: 'user', content: msg });
  if (window.sandraFlow?.onMessage && await window.sandraFlow.onMessage(msg)) return;
  if (draftReply) { draftReply(msg); return; }
  if (brush.strokes.length && await submitPainted(msg)) return;
  if (selections.length) { for (const s of [...selections]) command(s, msg, msg); return; }
  if (CHANGE_RE.test(msg) && !OBJECTION.test(msg) && sdk) {
    try {
      const sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null, { silent: true, whole: true });
      command(sel, msg, msg);
    } catch (err) { bubble(esc(err.message)); }
    return;
  }
  const t = thinking();
  try {
    const res = await postEdit('chat', { message: msg, history: chatHistory, edits: stateForAgent(currentRoom()?.id) });
    bubble(esc(res.reply || '').replace(/\n/g, '<br>'));
    chatHistory.push({ role: 'assistant', content: res.reply });
  } catch { bubble('Sandra could not answer just now. Try again in a moment.'); }
  finally { t.remove(); }
});
$('#chat-clear').onclick = () => { $('#chat').innerHTML = ''; chatHistory = []; };

/* ================= guided tour: the agent walks you room by room ================= */
const ROOM_PRIORITY = [/bath/i, /bedroom/i, /stair|hall/i, /kitchen/i, /laundry/i, /entry|foyer/i];
function agentRooms() {
  const picks = [];
  for (const re of ROOM_PRIORITY) for (const r of roomList) if (re.test(r.label) && !picks.includes(r)) picks.push(r);
  for (const room of roomList) if (!picks.includes(room)) picks.push(room);
  return picks.filter((r) => !/closet|pantry/i.test(r.label));
}
function setSandraState(phase, title, detail = '') {
  $('#guide-sub').textContent = phase;
  if (tourDecision) return;          // never clobber a question the buyer hasn't answered
  const el = document.createElement('div');
  el.className = 'sandra-task msg-in';
  el.innerHTML = '<strong>' + esc(title) + '</strong>' + (detail ? '<p>' + esc(detail) + '</p>' : '');
  setCard(el);
}
function stopAgent() {
  const release = window.sandraShowcase?.takeControl();
  if (agentBusy) {
    agentAbort = true;
    tourDecision?.('stop');
  }
  return release;
}
async function startAgent() {
  if (agentBusy) return;
  if (!roomList.length || !poseCache) { hint('Sandra is waiting for room data.', 4000); return; }
  openGuide();
  agentBusy = true;
  agentAbort = false;
  document.body.classList.add('sandra-guiding');
  $('#guide-title-run').disabled = true;
  setMode('walk');
  closeDrawers();
  try { await guidedTour(); }
  catch (err) { console.error(err); setSandraState('Ready', 'Tour paused', err.message); }
  finally {
    agentBusy = false;
    document.body.classList.remove('sandra-guiding');
    $('#guide-title-run').disabled = false;
    setRoverState('idle');
    scheduleCoverage();
  }
}
$('#agent-run').onclick = startAgent;
$('#guide-title-run').onclick = startAgent;
$('#guide-stop').onclick = stopAgent;

async function surveyRoom(room) {
  const start = poseCache.rotation.y, views = [];
  capturingOriginal = true;
  refreshVisibility();
  try {
    for (let k = 0; k < 4 && !agentAbort; k++) {
      await lookAt({ x: -17, y: start + k * 90 }, 125);
      const pose = snapPose();
      const area = { x: 0, y: 0, w: pose.W, h: pose.H };
      const [image, hits] = await Promise.all([
        soon(grabFrame(), 8000),
        soon(sampleSelection(area, pose), 7500),
      ]);
      if (image && sameFrame(pose, snapPose())) views.push({ image, pose, hits: hits || [], room: room.label, roomId: room.id });
    }
  } finally { capturingOriginal = false; refreshVisibility(); }
  return views;
}

function guidedLocation(f, views, inventory) {
  let i = f.view;
  if (f.object_id) {
    const indexed = inventory.findIndex((items) => items.some((item) => item.object_id === f.object_id));
    if (!inventory[i]?.some((item) => item.object_id === f.object_id) && indexed !== -1) i = indexed;
  }
  const view = views[i];
  if (!view) return null;
  const rect = isObjectRect(f.box_2d, view.pose);
  if (!rect) return null;
  return { frame: view.image, pose: view.pose, hits: view.hits, rect, whole: true, poly: null,
    roomLabel: view.room, roomId: view.roomId, id: 's' + Date.now(), objects: inventory[i] || [] };
}
function normalizedGuideRect(rect, pose) {
  return [rect.x / pose.W, rect.y / pose.H, (rect.x + rect.w) / pose.W, (rect.y + rect.h) / pose.H];
}
function structural(f) {
  return f.effort === 'structural' || /widen(?:ing)? (?:the |this )?(?:door|entrance|opening|hall)|remove (?:a |the )?wall|new doorway|move (?:the )?plumbing/i.test(f.title || '');
}
function decisionText(prompt, skipLabel = 'Next room') {
  const answer = ask(prompt, [['skip', skipLabel], ['stop', 'End tour']]);
  draftReply = (text) => tourDecision?.(text);
  $('#chat-input').focus();
  return answer;
}
const OBJECTION = /too (?:expensive|much|complicated|invasive)|costs? too|too big|over budget|cheaper|simpler/i;
function statedCap(text) {
  const match = text.match(/(?:under|up to|at most|max(?:imum)?|budget of)\s*\$?\s*([\d,]+)(?:\s*(k)\b)?|^\s*\$\s*([\d,]+)(?:\s*(k)\b)?\s*$/i);
  if (!match) return null;
  return Number((match[1] || match[3]).replaceAll(',', '')) * (match[2] || match[4] ? 1000 : 1);
}
async function reviewSuggestion(f, sel, loc) {
  let finding = f, instruction = f.title, revised = false;
  while (!agentAbort) {
    $('#guide-sub').textContent = 'Your decision';
    const opt = (finding.options || [])[Math.min(1, (finding.options || []).length - 1)];
    const chosen = await (async () => {
      const answer = ask('<div class="sandra-room-label">' + esc(sel.roomLabel) + '</div><strong>' + esc(finding.title) +
        '</strong><p>' + esc(finding.issue || finding.reason || '') + '</p>' +
        (opt ? '<p class="sandra-price">About ' + money(opt.total) + ' installed</p>' : '') +
        (structural(finding) ? '<p>This involves structural work. Confirm the scope before previewing.</p>' : ''),
        [['yes', 'Preview change'], ['adjust', 'Refine with Sandra'], ['skip', 'Skip'], ['stop', 'End tour']], loc);
      draftReply = (text) => tourDecision?.({ text });
      return answer;
    })();
    if (chosen === 'yes') return { finding, instruction, revised };
    if (chosen === 'skip' || chosen === 'stop' || agentAbort) return chosen;
    let text = chosen?.text;
    if (!text || OBJECTION.test(text)) {
      const question = text && /expensive|budget|cost/i.test(text)
        ? 'What should the installed cost stay under? I can also find a simpler hardware change.'
        : 'What should I keep, change, or leave alone? For example, keep the doorway and install a lever handle.';
      const answer = await decisionText(question, 'Skip this change');
      if (answer === 'skip' || answer === 'stop' || agentAbort) return answer;
      text = [text, answer].filter(Boolean).join('. ');
    }
    renovationPreference = text.slice(0, 400);
    setSandraState('Revising', 'Updating the proposal', text);
    const revision = await planSelection(sel, 'Revise this proposal: ' + finding.title + '. Buyer wants: ' + text +
      '. Keep all unrelated parts untouched. If a simpler part is requested, target only that part. Find it in this original photo.');
    if (!revision.finding?.box_2d) {
      const answer = await decisionText('I could not see that part clearly. Can you describe which part to target?', 'Skip this change');
      if (answer === 'skip' || answer === 'stop' || agentAbort) return answer;
      text += '. ' + answer;
      const retry = await planSelection(sel, text);
      if (!retry.finding?.box_2d) return 'skip';
      revision.finding = retry.finding;
    }
    finding = revision.finding;
    const preserve = /\b(?:only|just)\s+(?:a\s+)?(?:lever|handle|knob)|\b(?:keep|leave)\b.{0,25}\b(?:doorway|opening|walls?)\b|(?:no|without|don.t)\s+widen/i.test(text);
    if (preserve && structural(finding)) {
      say('That revision still included structural work. I’ll keep the doorway as it is.');
      return 'skip';
    }
    const cap = statedCap(text);
    if (cap) {
      const options = (finding.options || []).filter((o) => o.total <= cap);
      if (!options.length) {
        const answer = await decisionText('I don’t have an estimated installation under ' + money(cap) +
          '. Which part should we keep, or would you like to skip it?', 'Skip this change');
        if (answer === 'skip' || answer === 'stop' || agentAbort) return answer;
        const retry = await planSelection(sel, text + '. Buyer clarified: ' + answer);
        if (!retry.finding) return 'skip';
        finding = { ...retry.finding, options: (retry.finding.options || []).filter((o) => o.total <= cap) };
        if (!finding.options.length) { say('I couldn’t find a verified-cost option within that limit.'); return 'skip'; }
      } else finding = { ...finding, options };
    }
    instruction = text;
    revised = true;
    const next = isObjectRect(finding.box_2d, sel.pose);
    if (next) {
      loc.rect = normalizedGuideRect(next, sel.pose);
      loc.label = finding.item;
      if (poseCache.sweep === loc.sweep) spotlight(loc);
      setRoverState('inspect', currentRoom(), null, next);
    }
  }
  return 'stop';
}

async function guidedTour() {
  const rooms = agentRooms();
  say('I’ll check ' + rooms.map((r) => esc(r.label)).join(', ') + '. You can refine or skip any suggestion.');
  let accepted = 0;
  for (let i = 0; i < rooms.length && !agentAbort; i++) {
    const room = rooms[i];
    setSandraState('Room ' + (i + 1) + ' of ' + rooms.length, 'Walk with me to ' + room.label);
    const target = centerSweep(room);
    await walkTo(target.id);
    if (agentAbort) break;
    await sleep(320);
    setSandraState('Reading the room', room.label, 'I’m checking fixtures and access from the original scan.');
    setRoverState('scan', room);
    const views = await surveyRoom(room);
    if (!views.length || agentAbort) continue;
    const inventory = await identifyViews(views).catch(() => views.map(() => []));
    if (agentAbort) break;
    const plan = await postEdit('agent/plan', {
      views: views.map(({ image, room }) => ({ image, room })), inventory, needs: NEEDS, persona: PERSONA,
      existing: stateForAgent(room.id), declined: [...declined], preferences: renovationPreference,
    }).catch(() => null);
    if (!plan) { say('I couldn’t finish checking ' + esc(room.label) + '.'); continue; }
    let suggested = 0;
    for (const f of (plan.findings || [])) {
      if (agentAbort || suggested >= 2) break;
      if (f.fits_needs === false || declined.has(keyOf(room.label, f.title))) continue;
      const sel = guidedLocation(f, views, inventory);
      if (!sel) continue;
      const draft = editTarget(sel, f, f.title, sel.objects);
      if (!draft) continue;
      const existing = edits.find((e) => matchesEdit(draft, e));
      if (existing) {
        const p = existing.patches[0];
        say(esc(existing.title) + ' is already in your plan for ' + esc(room.label) + '.',
          p && { sweep: p.sweep, rot: p.rot, rect: p.rectN, label: existing.title });
        continue;
      }
      const loc = { sweep: sel.pose.sweep, rot: sel.pose.rotation, rect: normalizedGuideRect(sel.rect, sel.pose), label: f.item };
      await lookAt(loc.rot, 90);
      if (agentAbort) break;
      spotlight(loc);
      setRoverState('inspect', room, null, sel.rect);
      if (structural(f)) {
        say('<b>' + esc(room.label) + '</b> · Confirm the doorway or passage dimensions against your must-haves. I’ll look for simpler changes first.', loc);
        clearSpot();
        continue;
      }
      suggested++;
      const choice = await reviewSuggestion(f, sel, loc);
      clearSpot();
      if (choice === 'stop' || agentAbort) { agentAbort = true; break; }
      if (choice === 'skip') { declined.add(keyOf(room.label, f.title)); saveDeclined(); continue; }
      setSandraState('Preparing your preview', choice.finding.title, 'Nearby angles are checked in the background.');
      const e = await command(sel, choice.instruction, choice.finding.title, { ...choice.finding, guided: true, revised: choice.revised }, sel.objects);
      if (agentAbort) break;
      if (e?.status === 'ready') {
        const preview = e.patches[0];
        await walkTo(preview.sweep);
        await lookAt(preview.rot, 90);
        setView('after');
        $('#guide-sub').textContent = 'Preview ready';
        const decision = await ask('<strong>' + esc(e.title) + '</strong><p>' + (e.cost ? money(e.cost) + ' estimated installed. ' : '') +
          'Compare the original or take a step to inspect the edit.</p>', [['next', 'Keep and continue'], ['undo', 'Undo'], ['stop', 'End tour']]);
        if (decision === 'undo') removeEdit(e.id);
        else accepted++;
        if (decision === 'stop') { agentAbort = true; break; }
      } else if (e) say('I couldn’t verify that preview. ' + esc(e.error || 'Try another view.'));
    }
    if (!suggested && !agentAbort) say(esc(room.label) + ' checked. I didn’t find another small change for your needs in the views I checked.');
  }
  clearSpot();
  setSandraState(agentAbort ? 'Explore' : 'Tour complete', agentAbort ? 'The home is yours to explore' : 'Review your plan',
    accepted ? accepted + ' changes kept. Open Planned changes to see the total.' : 'Ask Sandra about a fixture or explore another room.');
}

/* ================= changes drawer, undo, compare ================= */
function save() { try { localStorage.setItem(STORE, JSON.stringify(edits, (k, v) => k === 'pending' ? undefined : v)); } catch {} }
async function restoreEdits() {
  try { edits = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { edits = []; }
  edits = Array.isArray(edits) ? edits.filter((e) => e?.status === 'ready' && e.patches?.length) : [];
  for (const e of edits) for (const p of e.patches) if (p.pose) {
    try { await mountPatch(e, p, e.revision); } catch (err) { console.warn('Saved preview could not reopen', err); }
  }
  save(); refreshVisibility(); renderPlan();
}
function removeEdit(id, quiet = false) {
  const e = edits.find((x) => x.id === id); if (!e) return;
  clearPatches(e);
  edits = edits.filter((x) => x.id !== id); document.getElementById('job-' + id)?.remove();
  save(); renderPlan();
  if (!quiet) hint(`Removed “${esc(e.title)}”.`, 3000);
}
function undo() { const e = [...edits].reverse().find((x) => x.status === 'ready' || x.status === 'failed'); if (e) removeEdit(e.id); }
$('#undo').onclick = undo;
async function swapOption(id, i) {
  const e = edits.find((x) => x.id === id);
  if (!e?.source || !e.options[i] || e.status !== 'ready') return;
  const previous = { option: e.option, cost: e.cost, custom: e.custom, review: e.review, score: e.score };
  const source = e.source;
  e.revision++;
  setStatus(e, 'designing', { option: e.options[i], cost: e.options[i].total, custom: '' });
  try {
    const response = await fetch(`/api/home/${H.id}/render/${source.rid}/before`);
    if (!response.ok) throw new Error('The original photo is unavailable.');
    const blob = await response.blob();
    const frame = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    if (edits.includes(e)) await renderAndReview(e, { ...source, frame });
  } catch (err) {
    if (!edits.includes(e)) return;
    setStatus(e, 'ready', previous);
    refreshVisibility();
    hint(esc(err.message || 'Could not swap this option.'), 5000);
  }
}
const PILL = {
  queued: ['On your list', 'text-brand-700 bg-brand-50'],
  understanding: ['Thinking…', 'text-brand-700 bg-brand-50 animate-pulse'], designing: ['Pricing…', 'text-brand-700 bg-brand-50 animate-pulse'],
  rendering: ['Rendering…', 'text-amber-700 bg-amber-50 animate-pulse'], fixing: ['Improving…', 'text-amber-700 bg-amber-50 animate-pulse'],
  checking: ['Checking…', 'text-sky-700 bg-sky-50 animate-pulse'], ready: ['Ready', 'text-emerald-700 bg-emerald-50'], failed: ['Failed', 'text-red-700 bg-red-50'],
};
function renderPlan() {
  const on = edits.filter((e) => e.on !== false && (e.status === 'ready' || e.status === 'queued'));
  $('.sandra-coverage').hidden = !on.some((e) => e.source);
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
        ${e.source && e.options?.length > 1 && e.status === 'ready' ? `<select data-swap="${e.id}" class="mt-1 max-w-full text-xs border rounded px-1 py-0.5">${e.options.map((o, i) => `<option value="${i}" ${o.name === e.option?.name ? 'selected' : ''}>${esc(o.tier)}: ${esc(o.name)} (${money(o.total)})</option>`).join('')}</select>` : ''}
        <div class="mt-1 flex items-center gap-3 text-xs">
          ${e.status === 'ready' ? `<label class="flex items-center gap-1 text-slate-600"><input type="checkbox" data-on="${e.id}" ${e.on !== false ? 'checked' : ''} class="accent-brand-600">Show</label>
          <button data-go="${e.id}" class="text-brand-700 font-semibold">View</button>` : ''}
          <button data-del="${e.id}" class="text-slate-400 hover:text-red-600 ml-auto">Delete</button></div></div></div></li>`;
  }).join('') || '<li class="text-sm text-slate-500 p-2">Nothing yet. Tell Sandra what you’d change, or tap ✎ and paint over anything in the tour.</li>';
  $('#plan').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeEdit(b.dataset.del));
  $('#plan').querySelectorAll('[data-go]').forEach((b) => b.onclick = () => flyTo(edits.find((e) => e.id === b.dataset.go)));
  $('#plan').querySelectorAll('[data-on]').forEach((b) => b.onchange = () => { const e = edits.find((x) => x.id === b.dataset.on); e.on = b.checked; save(); refreshVisibility(); renderPlan(); });
  $('#plan').querySelectorAll('[data-swap]').forEach((s) => s.onchange = () => swapOption(s.dataset.swap, +s.value));
  const queued = edits.filter((e) => e.status === 'queued').length;
  $('#make-n').textContent = queued;
  $('#make-btn').classList.toggle('hidden', !queued);
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
  window.sandraShowcase?.takeControl(); switchView('tour'); closeDrawers(); setView('after');
  const p = e.patches.find((x) => !x.extra) || e.patches[0];
  await soon(sdk.Sweep.moveTo(p.sweep, { transition: sdk.Sweep.Transition.FLY, transitionTime: 700 }));
  await lookAt(p.rot || poseCache.rotation);
  hint(p.pose ? `<b>${esc(e.title)}</b>. Hold <b>B</b> or flip <b>Your changes</b> to compare with today.` :
    'Circle the fixture again to rebuild this saved preview with the current renderer.', 5000);
}
function setView(v) {
  view = v; refreshVisibility();
  if (v === 'after') scheduleCoverage();
  const on = v === 'after';
  $('#compare-dot').className = 'w-9 h-6 rounded-full relative transition ' + (on ? 'bg-brand-600' : 'bg-slate-300');
  $('#compare-dot').firstElementChild.className = 'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition ' + (on ? 'right-0.5' : 'left-0.5');
  $('#compare-label').textContent = on ? 'Your changes on' : 'Today (as listed)';
}
$('#compare').onclick = () => setView(view === 'after' ? 'orig' : 'after');

/* ================= drawers, tabs, panels ================= */
function closeDrawers() { document.querySelectorAll('[data-drawer-panel]').forEach((d) => d.classList.remove('open')); }
document.querySelectorAll('[data-drawer]').forEach((b) => b.onclick = () => {
  if (window.sandraShowcase?.playing) window.sandraShowcase.takeControl();
  const d = document.querySelector(`[data-drawer-panel="${b.dataset.drawer}"]`), open = d.classList.contains('open');
  closeDrawers();
  if (!open) {
    d.classList.add('open');
    if (b.dataset.drawer === 'outside' && !$('#aerial-thumb').hasAttribute('src')) {
      $('#aerial-thumb').src = `/api/home/${H.id}/aerial.jpg`;
      loadOutside().catch(() => {});
    }
    if (b.dataset.drawer === 'access' && !info?.scan?.rooms?.length) loadAccess(false);
  }
});
document.querySelectorAll('[data-drawer-panel] [data-close]').forEach((b) => b.onclick = closeDrawers);
function switchView(v) {
  if (v === 'photos') window.sandraShowcase?.takeControl();
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
  if (window.sandraFlow) return window.sandraFlow.start();
  setSandraState('Ready to explore', edits.length ? 'Welcome back' : 'Let’s take a look',
    edits.length ? edits.length + ' changes in your plan. I’ll check what’s already covered as we walk.' :
      'Start a guided tour, or ask me about a fixture in this view.');
  setRoverState('idle');
  scheduleCoverage();
}

async function loadAccess(cached = true) {
  try {
    const query = new URLSearchParams({ needs: NEEDS.join(','), cached: cached ? '1' : '0' });
    const data = await fetch(`/api/home/${H.id}?${query}`).then((r) => r.json());
    if (data.evidence) { info = data; renderAccess(info); }
  } catch {}
}
renderPlan();
loadAccess();

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

$('#guide-min').onclick = () => {
  document.body.classList.add('guide-min'); $('#guide').classList.add('hidden'); $('#guide-open').classList.remove('hidden');
  clearSpot(); unread = 0; $('#guide-new').textContent = '';
};
function openGuide() {
  document.body.classList.remove('guide-min'); $('#guide').classList.remove('hidden'); $('#guide-open').classList.add('hidden');
  $('#chat').scrollTop = $('#chat').scrollHeight;
}
$('#guide-open').onclick = openGuide;
$('#history-toggle').onclick = (event) => {
  const hidden = $('#chat').classList.toggle('hidden');
  event.currentTarget.setAttribute('aria-expanded', String(!hidden));
};
$('#guide-hop').onclick = () => setRoverState('hop');
$('#guide-angle-retry').onclick = () => {
  if (!coverageBusy) {
    $('#coverage-status').textContent = 'Checking for a new preview here…';
    prepareCurrentAngle(true).then((started) => {
      if (started === false) $('#coverage-status').textContent = 'No new edit is visible from this spot.';
    }).catch(() => { $('#coverage-status').textContent = 'Could not check this angle. Try again.'; });
  }
};
$('#guide-index').onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null, { silent: true, whole: true });
    const [objects = []] = await identifyViews([{ pose: sel.pose, image: sel.frame, hits: sel.hits, roomId: sel.roomId }]);
    const panel = bubble('<strong>' + esc(sel.roomLabel || 'This view') + '</strong><p>' +
      (objects.length ? objects.length + ' identified items. Select one to see it.' : 'I could not confirm an object from this angle.') + '</p>');
    const items = document.createElement('div');
    items.className = 'sandra-object-list';
    for (const obj of objects) {
      const rect = isObjectRect(obj.box_2d, sel.pose);
      if (!rect) continue;
      const item = document.createElement('button');
      item.textContent = obj.label + (obj.parent ? ' · Part' : '');
      item.onclick = () => goTo({ sweep: sel.pose.sweep, rot: sel.pose.rotation, rect: normalizedGuideRect(rect, sel.pose), label: obj.label });
      items.appendChild(item);
    }
    panel.firstElementChild.appendChild(items);
    $('#chat').classList.remove('hidden');
    $('#history-toggle').setAttribute('aria-expanded', 'true');
    $('#chat').scrollTop = $('#chat').scrollHeight;
  } catch (err) { bubble(esc(err.message || 'This angle could not be indexed.')); }
  finally { button.disabled = false; }
};
