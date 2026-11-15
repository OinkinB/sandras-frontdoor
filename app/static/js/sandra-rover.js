/* Sandra: a pink, charismatic little rover that lives in the 3D tour.
 *
 * - Rendered as a Showcase scene component in model coordinates.
 * - Moves on curved, eased paths (fast through the middle, leaning into turns), squashes and bounces when she
 *   stops, does a happy spin now and then, blinks, wiggles her antenna and turns to face you.
 * - Wanders around the room on her own when you're idle. Every candidate spot and path is checked against the
 *   scan: the floor must be floor height (couches, chairs and tables read higher) and nothing may sit between.
 * - Shows what she says in a speech bubble above her head.
 */
let rover = null;
let roverMotion = 0;
const reducedRoverMotion = matchMedia('(prefers-reduced-motion: reduce)');

const PINK = { body: 0xff5fa2, top: 0xff8dc0, dark: 0x3a1f2d, eye: 0xfff4fa, cheek: 0xff2d7a, accent: 0xffd166, hub: 0xffc2dc };

function SandraRover() {
  this.inputs = { destination: null, phase: 'idle', shown: false, reduced: false, snap: true, hop: false, face: 0, spin: 0, curve: 0 };
  this.onInit = function () {
    const T = this.context.three;
    this.T = T;
    const root = this.model = new T.Group();
    this.body = new T.Group();
    this.head = new T.Group();
    this.wheels = [];
    this.geometry = [];
    // transparent queue + high renderOrder so she draws over the emptied-room sphere (still depth-tested by walls)
    const M = (c) => new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 1 });
    this.materials = [M(PINK.body), M(PINK.top), M(PINK.dark), M(PINK.eye), M(PINK.accent), M(PINK.cheek), M(PINK.hub)];
    const mesh = (geometry, material, parent, x, y, z) => {
      this.geometry.push(geometry);
      const el = new T.Mesh(geometry, this.materials[material]);
      el.position.set(x, y, z); parent.add(el); return el;
    };
    // soft shadow
    const shadow = mesh(new T.CircleGeometry(0.22, 36), 2, root, 0, 0.006, 0); shadow.rotation.x = -Math.PI / 2;
    shadow.material = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false });
    // round body
    const torso = mesh(new T.SphereGeometry(0.19, 28, 20), 0, this.body, 0, 0.21, 0); torso.scale.set(1, 0.82, 0.92);
    mesh(new T.CylinderGeometry(0.2, 0.2, 0.05, 28), 1, this.body, 0, 0.12, 0);         // belly band
    // head with visor, eyes and cheeks
    this.head.position.set(0, 0.36, 0.01);
    this.body.add(this.head);
    const dome = mesh(new T.SphereGeometry(0.14, 28, 20), 1, this.head, 0, 0.02, 0); dome.scale.set(1.15, 0.85, 1);
    const visor = mesh(new T.SphereGeometry(0.115, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), 2, this.head, 0, 0.0, 0.055);
    visor.rotation.x = Math.PI / 2; visor.scale.set(1.25, 0.75, 0.55);
    this.eyes = [-0.052, 0.052].map((x) => { const e = mesh(new T.SphereGeometry(0.026, 16, 12), 3, this.head, x, 0.012, 0.118); e.scale.set(1, 1.25, 0.5); return e; });
    for (const x of [-0.1, 0.1]) { const c = mesh(new T.CircleGeometry(0.018, 16), 5, this.head, x, -0.035, 0.112); c.rotation.y = x < 0 ? -0.35 : 0.35; }
    // antenna with a bobbing ball
    this.antenna = new T.Group(); this.antenna.position.set(0, 0.13, -0.01); this.head.add(this.antenna);
    mesh(new T.CylinderGeometry(0.006, 0.006, 0.09, 8), 2, this.antenna, 0, 0.045, 0);
    mesh(new T.SphereGeometry(0.024, 14, 10), 4, this.antenna, 0, 0.095, 0);
    // wheels
    for (const x of [-0.19, 0.19]) {
      const axle = new T.Group(); axle.position.set(x, 0.1, 0); this.body.add(axle); this.wheels.push(axle);
      mesh(new T.CylinderGeometry(0.1, 0.1, 0.06, 22), 2, axle, 0, 0, 0).rotation.z = Math.PI / 2;
      mesh(new T.CylinderGeometry(0.055, 0.055, 0.066, 14), 6, axle, 0, 0, 0).rotation.z = Math.PI / 2;
      mesh(new T.BoxGeometry(0.07, 0.02, 0.018), 4, axle, 0, 0.035, 0);
    }
    root.add(this.body);
    root.scale.setScalar(0.9);
    root.traverse((o) => { o.renderOrder = 4000; });
    this.destination = new T.Vector3(); this.origin = new T.Vector3(); this.control = new T.Vector3();
    this.outputs.objectRoot = root;
    root.visible = false;
    this.elapsed = 0; this.progress = 1; this.duration = 1; this.started = false;
    this.squash = 0; this.spinT = 1; this.lastSpin = 0; this.prevYaw = 0; this.lean = 0;
  };
  this.onInputsUpdated = function () {
    const { destination, shown, snap } = this.inputs;
    this.model.visible = shown && !!destination;
    if (this.inputs.spin !== this.lastSpin) { this.lastSpin = this.inputs.spin; this.spinT = 0; }
    if (!destination) return;
    const prior = this.destination.clone();
    this.destination.set(destination.x, destination.y, destination.z);
    if (!this.started || (snap && prior.distanceTo(this.destination) > 0.015)) {
      this.model.position.copy(this.destination);
      this.model.rotation.y = this.inputs.face;
      this.started = true; this.progress = 1; this.squash = 1;
    } else if (prior.distanceTo(this.destination) > 0.015) {
      // curved path: bow sideways so she arcs around like she's carving a corner
      this.origin.copy(this.model.position);
      const d = this.origin.distanceTo(this.destination);
      const mid = this.origin.clone().lerp(this.destination, 0.5);
      const side = new this.T.Vector3(this.destination.z - this.origin.z, 0, -(this.destination.x - this.origin.x)).normalize();
      this.control.copy(mid).addScaledVector(side, (this.inputs.curve || 0) * Math.min(0.6, d * 0.35));
      this.duration = Math.max(0.35, Math.min(1.8, d / 2.4));   // brisk: ~2.4 m/s through the middle
      this.progress = 0;
    }
  };
  const bez = (a, c, b, t, out) => out.set(
    (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
    (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
    (1 - t) * (1 - t) * a.z + 2 * (1 - t) * t * c.z + t * t * b.z);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  this.onTick = function (dt) {
    if (!this.model.visible) return;
    const s = Math.min(0.05, dt > 1 ? dt / 1000 : dt);
    this.elapsed += s;
    const { phase, reduced, hop } = this.inputs;
    let speed = 0;
    if (this.progress < 1) {
      const p0 = this.progress;
      this.progress = Math.min(1, this.progress + s / this.duration);
      const e0 = ease(p0), e1 = ease(this.progress);
      const before = bez(this.origin, this.control, this.destination, e0, new this.T.Vector3());
      bez(this.origin, this.control, this.destination, e1, this.model.position);
      if (hop && !reduced) this.model.position.y += 0.22 * Math.sin(Math.PI * this.progress);
      const dx = this.model.position.x - before.x, dz = this.model.position.z - before.z;
      speed = Math.hypot(dx, dz) / Math.max(1e-4, s);
      if (speed > 0.05) {
        const facing = Math.atan2(dx, dz);
        const delta = Math.atan2(Math.sin(facing - this.model.rotation.y), Math.cos(facing - this.model.rotation.y));
        this.model.rotation.y += delta * Math.min(1, s * 14);
      }
      if (this.progress === 1) this.squash = 1;           // landing bounce
    } else {
      const face = this.inputs.face - this.model.rotation.y;
      this.model.rotation.y += Math.atan2(Math.sin(face), Math.cos(face)) * Math.min(1, s * 5);
    }
    // happy spin
    if (this.spinT < 1 && !reduced) { this.spinT = Math.min(1, this.spinT + s / 0.7); this.body.rotation.y = ease(this.spinT) * Math.PI * 2; }
    else if (this.spinT >= 1) this.body.rotation.y = phase === 'scan' && !reduced ? Math.sin(this.elapsed * 1.8) * 0.35 : this.body.rotation.y * 0.85;
    // lean into turns and forward when fast
    const yaw = this.model.rotation.y, yawRate = Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw)) / Math.max(1e-4, s);
    this.prevYaw = yaw;
    this.lean += ((reduced ? 0 : Math.max(-0.35, Math.min(0.35, -yawRate * 0.06))) - this.lean) * Math.min(1, s * 8);
    this.body.rotation.z = this.lean + (reduced ? 0 : Math.sin(this.elapsed * 2) * 0.02);
    this.body.rotation.x = reduced ? 0 : Math.min(0.22, speed * 0.07);
    for (const w of this.wheels) w.rotation.x += s * (6 + speed * 12);
    // squash & stretch, bob, blink, antenna
    this.squash *= Math.pow(0.02, s);
    const sq = reduced ? 0 : this.squash * Math.sin(this.elapsed * 22) * 0.12;
    this.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    this.body.position.y = reduced ? 0 : Math.abs(Math.sin(this.elapsed * 3.2)) * 0.012;
    const blink = this.elapsed % 3.6 > 3.45 ? 0.15 : 1;
    this.eyes.forEach((eye) => { eye.scale.y = 1.25 * blink; });
    this.antenna.rotation.z = reduced ? 0 : Math.sin(this.elapsed * 6) * 0.15 + this.lean * 1.5;
    this.antenna.rotation.x = reduced ? 0 : -Math.min(0.5, speed * 0.2);
    this.head.rotation.z = reduced ? 0 : Math.sin(this.elapsed * 1.3) * 0.08;
  };
  this.onDestroy = function () {
    this.geometry.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  };
}

function roverAt(point, phase, { snap = false, hop = false, curve = null, spin = false } = {}) {
  if (!rover || !point || !Number.isFinite(point.x + point.y + point.z)) return;
  const inputs = rover.component.inputs;
  inputs.phase = phase;
  inputs.shown = poseCache?.mode === 'mode.inside';
  inputs.snap = snap;
  inputs.reduced = reducedRoverMotion.matches;
  inputs.hop = hop;
  inputs.curve = curve ?? (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5);
  if (spin) inputs.spin = (inputs.spin || 0) + 1;
  inputs.face = Math.atan2(poseCache.position.x - point.x, poseCache.position.z - point.z);
  inputs.destination = { x: point.x, y: point.y, z: point.z };
  rover.component.onInputsUpdated?.();
}
function roverToSweep(id, phase = 'walk') {
  const p = sweepList.find((s) => s.id === id)?.puckPosition;
  if (!p) return;
  const last = rover?.component.inputs.destination;
  roverAt(p, phase, { snap: !last || Math.abs(last.y - p.y) > 0.55 || dist(last, p) > 3.25 });
}

/* ---------- obstacle-aware placement ----------
 * Sandra is ~0.4 m wide. A spot is usable only if the floor in a ring around it is open (no wall, cabinet base,
 * couch or table leg within her radius), and her actual curved route, plus her half-width on each side, is open too. */
const ROVER_R = 0.3;
// true = open floor here, false = blocked, null = can't see it (off screen)
async function openPoint(p, floorY) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight;
  const q = sdk.Conversion.worldToScreen({ x: p.x, y: floorY + 0.02, z: p.z }, poseCache, { w: W, h: Hh });
  if (!q || q.z > 1 || q.z < -1 || q.x < 2 || q.y < 2 || q.x > W - 2 || q.y > Hh - 2) return null;
  const h = await hitAt(q.x, q.y);
  if (!h || Math.abs(h.y - floorY) > 0.06) return false;                                         // furniture, cabinet, wall
  const expected = Math.hypot(p.x - poseCache.position.x, p.y - poseCache.position.y, p.z - poseCache.position.z);
  if (dist(poseCache.position, h) < expected - 0.18) return false;                               // something in front of it
  return true;
}
const nearVisitor = (p) => Math.hypot(p.x - poseCache.position.x, p.z - poseCache.position.z) < 1.3;
async function hasRoom(p, floorY, r = ROVER_R) {
  const checks = [openPoint(p, floorY)];
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; checks.push(openPoint({ x: p.x + Math.cos(a) * r, y: floorY, z: p.z + Math.sin(a) * r }, floorY)); }
  const res = await Promise.all(checks);
  if (res[0] !== true) return false;
  return res.slice(1).every((v, k) => v === true || (v === null && nearVisitor({ x: p.x + Math.cos(k * Math.PI / 4) * r, z: p.z + Math.sin(k * Math.PI / 4) * r })));
}
function curvePoint(a, b, curve, t) {   // same curve the rover component drives
  const d = Math.hypot(b.x - a.x, b.z - a.z), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const sx = (b.z - a.z) / (d || 1), sz = -(b.x - a.x) / (d || 1), off = curve * Math.min(0.6, d * 0.35);
  const cx = mx + sx * off, cz = mz + sz * off;
  return { x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x, z: (1 - t) ** 2 * a.z + 2 * (1 - t) * t * cz + t * t * b.z, sx, sz };
}
async function routeOpen(a, b, floorY, curve) {
  for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const c = curvePoint(a, b, curve, t);
    for (const side of [0, -0.22, 0.22]) {
      const p = { x: c.x + c.sx * side, y: floorY, z: c.z + c.sz * side };
      const ok = await openPoint(p, floorY);
      if (ok === false || (ok === null && !nearVisitor(p))) return false;
    }
  }
  return true;
}
// back-compat for callers
const openFloorAlong = (a, b, floorY) => routeOpen(a, b, floorY, 0);
async function pickOpenSpot(floorY, near, { prefer = null, minCam = 0.95, maxCam = 3.2 } = {}) {
  const W = iframe.clientWidth, Hh = iframe.clientHeight, cam = poseCache.position;
  const coords = [];
  for (const v of [0.62, 0.72, 0.82, 0.9]) for (const u of [0.18, 0.3, 0.42, 0.5, 0.58, 0.7, 0.82]) coords.push([u, v]);
  const hits = await Promise.all(coords.map(([u, v]) => hitAt(u * W, v * Hh)));
  const spots = hits.map((p, i) => ({ p, uv: coords[i] })).filter(({ p }) => p && Math.abs(p.y - floorY) < 0.05 &&
    Math.hypot(p.x - cam.x, p.z - cam.z) > minCam && Math.hypot(p.x - cam.x, p.z - cam.z) < maxCam && (!near || dist(p, near) > 0.55));
  spots.sort((a, b) => (prefer != null ? Math.abs(a.uv[0] - prefer) - Math.abs(b.uv[0] - prefer)
    : Math.abs(b.uv[0] - 0.5) - Math.abs(a.uv[0] - 0.5)) + (Math.random() - 0.5) * 0.4);
  for (const s of spots.slice(0, 8)) {
    if (!(await hasRoom(s.p, floorY))) continue;
    if (!near) return { p: s.p, curve: 0 };
    const swing = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5);
    for (const curve of [swing, swing / 2, 0]) if (await routeOpen(near, s.p, floorY, curve)) return { p: s.p, curve };
  }
  return null;
}

async function setRoverState(phase, room = null, sweep = null, rect = null) {
  if (!rover || poseCache?.mode !== 'mode.inside') return;
  if (sweep) { roverToSweep(sweep, phase); return; }
  const ticket = ++roverMotion;
  const pose = snapPose(), puck = sweepList.find((s) => s.id === pose.sweep)?.puckPosition;
  if (!puck) return;
  const W = pose.W, Hh = pose.H;
  const current = rover.component.inputs.destination || puck;
  if (phase === 'hop') {
    const points = await Promise.all([[0.52, 0.73], [0.48, 0.73], [0.56, 0.73]].map(([u, v]) => hitAt(u * W, v * Hh)));
    if (ticket !== roverMotion || !sameFrame(pose, snapPose())) return;
    const [p, a, b] = points;
    if (p && a && b && p.y - puck.y > 0.09 && p.y - puck.y < 0.35 && dist(p, current) < 0.95 &&
      Math.abs(p.y - a.y) < 0.035 && Math.abs(p.y - b.y) < 0.035 && dist(a, b) > 0.08) { roverAt(p, 'inspect', { hop: true, spin: true }); return; }
    hint('Sandra needs a nearby, level surface for a hop.', 3500);
  }
  const prefer = rect ? Math.max(0.15, Math.min(0.85, (rect.x + rect.w / 2) / W)) : null;
  const spot = await pickOpenSpot(puck.y, current, { prefer });
  if (ticket !== roverMotion || !sameFrame(pose, snapPose())) return;
  if (spot) roverAt(spot.p, phase === 'hop' ? 'scan' : phase, { curve: spot.curve, spin: phase === 'inspect' });
  else if (dist(current, puck) > 3) roverAt(puck, phase, { snap: true });   // only jump if she's far away; otherwise stay put
}

/* ---------- free wandering while you look around ---------- */
let lastUserMove = Date.now();
setInterval(async () => {
  if (!rover || !sdk || !poseCache || poseCache.mode !== 'mode.inside' || reducedRoverMotion.matches) return;
  if ((typeof agentBusy !== 'undefined' && agentBusy) || window.sandraShowcase?.playing) return;
  if (Date.now() - lastUserMove < 1500) return;                  // let the camera settle first
  if (Math.random() < 0.45) return;                              // not constantly busy: pauses feel alive
  const puck = sweepList.find((s) => s.id === poseCache.sweep)?.puckPosition;
  const here = rover.component.inputs.destination;
  if (!puck || !here) return;
  const pose = snapPose(), ticket = ++roverMotion;
  const spot = await pickOpenSpot(puck.y, here);
  if (ticket !== roverMotion || !sameFrame(pose, snapPose()) || !spot) return;
  roverAt(spot.p, 'idle', { curve: spot.curve, spin: Math.random() < 0.22 });
}, 3200);

/* ---------- speech bubble above Sandra ---------- */
const sayEl = document.createElement('div');
sayEl.id = 'rover-say';
sayEl.className = 'absolute z-30 pointer-events-none max-w-[260px] bg-white text-ink text-sm font-medium rounded-2xl px-3 py-2 shadow-xl ring-2 ring-pink-300 transition-opacity duration-300 opacity-0';
sayEl.style.transform = 'translate(-50%, -100%)';
document.addEventListener('DOMContentLoaded', () => document.getElementById('stage')?.appendChild(sayEl));
let sayUntil = 0;
function roverSay(text, ms = 5200) {
  const t = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return;
  // up to ~120 characters, ending on a sentence or word boundary
  let out = t;
  if (t.length > 120) { const cut = t.slice(0, 120); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); out = end > 40 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…'; }
  sayEl.textContent = out;
  sayUntil = Date.now() + ms;
}
(function follow() {
  requestAnimationFrame(follow);
  const comp = rover?.component;
  if (!comp?.model?.visible || !poseCache || Date.now() > sayUntil) { sayEl.style.opacity = 0; return; }
  const p = comp.model.position, W = iframe.clientWidth, Hh = iframe.clientHeight;
  const q = sdk.Conversion.worldToScreen({ x: p.x, y: p.y + 0.62, z: p.z }, poseCache, { w: W, h: Hh });
  if (!q || q.z > 1 || q.z < -1 || q.x < 0 || q.x > W || q.y < 0 || q.y > Hh) { sayEl.style.opacity = 0; return; }
  sayEl.style.left = q.x + 'px'; sayEl.style.top = q.y + 'px'; sayEl.style.opacity = 1;
})();
// Sandra's words live in one card at the bottom of the screen; no second copy above her head.
// track when the visitor moves the camera, so wandering never fights them
setTimeout(function hook() {
  if (!sdk) return setTimeout(hook, 1000);
  sdk.Camera.pose.subscribe(() => { lastUserMove = Date.now(); });
}, 1000);
