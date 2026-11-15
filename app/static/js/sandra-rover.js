/* Sandra's body and motion run as a Showcase scene component in model coordinates. */
let rover = null;
let roverMotion = 0;
const reducedRoverMotion = matchMedia('(prefers-reduced-motion: reduce)');

function SandraRover() {
  this.inputs = { destination: null, phase: 'idle', shown: false, reduced: false, snap: true, hop: false, face: 0 };
  this.onInit = function () {
    const T = this.context.three;
    const root = this.model = new T.Group();
    this.body = new T.Group();
    this.wheels = [];
    this.geometry = [];
    this.materials = [
      new T.MeshBasicMaterial({ color: 0x455c64 }),
      new T.MeshBasicMaterial({ color: 0xa2b6b5 }),
      new T.MeshBasicMaterial({ color: 0x1a2528 }),
      new T.MeshBasicMaterial({ color: 0x71f9de }),
      new T.MeshBasicMaterial({ color: 0xffba64 }),
    ];
    const mesh = (geometry, material, parent, x, y, z) => {
      this.geometry.push(geometry);
      const el = new T.Mesh(geometry, this.materials[material]);
      el.position.set(x, y, z);
      parent.add(el);
      return el;
    };
    const box = (w, h, d, m, parent, x, y, z) => mesh(new T.BoxGeometry(w, h, d), m, parent, x, y, z);
    mesh(new T.CircleGeometry(0.23, 36), 2, root, 0, 0.007, 0).rotation.x = -Math.PI / 2;
    box(0.37, 0.21, 0.31, 1, this.body, 0, 0.198, 0);
    box(0.34, 0.13, 0.35, 0, this.body, 0, 0.28, 0.025);
    const visor = box(0.297, 0.113, 0.025, 2, this.body, 0, 0.276, 0.211);
    visor.rotation.x = -0.09;
    this.eyes = [-0.075, 0.075].map((x) => box(0.058, 0.046, 0.009, 3, this.body, x, 0.284, 0.23));
    box(0.19, 0.012, 0.012, 3, this.body, 0, 0.182, 0.198);
    box(0.05, 0.026, 0.09, 4, this.body, 0.115, 0.362, -0.06);
    box(0.33, 0.044, 0.037, 0, this.body, 0, 0.111, 0.165);
    for (const x of [-0.205, 0.205]) {
      const axle = new T.Group();
      axle.position.set(x, 0.112, 0);
      this.body.add(axle);
      this.wheels.push(axle);
      mesh(new T.CylinderGeometry(0.113, 0.113, 0.066, 20), 2, axle, 0, 0, 0).rotation.z = Math.PI / 2;
      mesh(new T.CylinderGeometry(0.075, 0.075, 0.072, 14), 1, axle, 0, 0, 0).rotation.z = Math.PI / 2;
      box(0.077, 0.028, 0.021, 4, axle, 0, 0.042, 0);
    }
    root.add(this.body);
    root.scale.setScalar(0.84);
    this.destination = new T.Vector3();
    this.origin = new T.Vector3();
    this.outputs.objectRoot = root;
    root.visible = false;
    this.elapsed = 0;
    this.progress = 1;
    this.started = false;
  };
  this.onInputsUpdated = function () {
    const { destination, shown, snap } = this.inputs;
    this.model.visible = shown && !!destination;
    if (!destination) return;
    const prior = this.destination.clone();
    this.destination.set(destination.x, destination.y, destination.z);
    if (!this.started || (snap && prior.distanceTo(this.destination) > 0.015)) {
      this.model.position.copy(this.destination);
      this.model.rotation.y = this.inputs.face;
      this.started = true;
      this.progress = 1;
    } else if (prior.distanceTo(this.destination) > 0.015) {
      this.origin.copy(this.model.position);
      this.distance = this.origin.distanceTo(this.destination);
      this.progress = 0;
    }
  };
  this.onTick = function (dt) {
    if (!this.model.visible) return;
    const seconds = Math.min(0.05, dt > 1 ? dt / 1000 : dt);
    this.elapsed += seconds;
    const { phase, reduced, hop } = this.inputs;
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + seconds * 1.6 / Math.max(0.25, this.distance));
      const t = this.progress;
      this.model.position.lerpVectors(this.origin, this.destination, t);
      if (hop && !reduced) this.model.position.y += 0.22 * Math.sin(Math.PI * t);
      const facing = Math.atan2(this.destination.x - this.origin.x, this.destination.z - this.origin.z);
      const delta = Math.atan2(Math.sin(facing - this.model.rotation.y), Math.cos(facing - this.model.rotation.y));
      const reverse = Math.abs(delta) > Math.PI * 0.78;
      if (!reverse) this.model.rotation.y += delta * Math.min(1, seconds * 11);
      for (const wheel of this.wheels) wheel.rotation.x += seconds * (reverse ? -13 : 13);
    } else {
      const face = this.inputs.face - this.model.rotation.y;
      this.model.rotation.y += Math.atan2(Math.sin(face), Math.cos(face)) * Math.min(1, seconds * 4);
    }
    if (!reduced) {
      this.body.rotation.z = Math.sin(this.elapsed * (phase === 'scan' ? 5 : 2)) * 0.021;
      this.body.rotation.x = this.progress < 1 ? -0.045 : 0;
      this.body.position.y = Math.sin(this.elapsed * 2.8) * 0.008;
      const blink = this.elapsed % 4.2 > 4.02 ? 0.16 : 1;
      this.eyes.forEach((eye) => { eye.scale.y = blink; });
      if (phase === 'scan' && this.progress === 1) this.body.rotation.y = Math.sin(this.elapsed * 1.7) * 0.23;
      else this.body.rotation.y *= 0.88;
    }
  };
  this.onDestroy = function () {
    this.geometry.forEach((item) => item.dispose());
    this.materials.forEach((item) => item.dispose());
  };
}

function roverAt(point, phase, { snap = false, hop = false } = {}) {
  if (!rover || !point || !Number.isFinite(point.x + point.y + point.z)) return;
  const inputs = rover.component.inputs;
  inputs.phase = phase;
  inputs.shown = poseCache?.mode === 'mode.inside';
  inputs.snap = snap;
  inputs.reduced = reducedRoverMotion.matches;
  inputs.hop = hop;
  inputs.face = Math.atan2(poseCache.position.x - point.x, poseCache.position.z - point.z);
  inputs.destination = { x: point.x, y: point.y, z: point.z };
}
function roverToSweep(id, phase = 'walk') {
  const p = sweepList.find((s) => s.id === id)?.puckPosition;
  if (!p) return;
  const last = rover?.component.inputs.destination;
  roverAt(p, phase, { snap: !last || Math.abs(last.y - p.y) > 0.55 || dist(last, p) > 3.25 });
}

async function setRoverState(phase, room = null, sweep = null, rect = null) {
  if (!rover || poseCache?.mode !== 'mode.inside') return;
  if (sweep) { roverToSweep(sweep, phase); return; }
  const ticket = ++roverMotion;
  const pose = snapPose(), puck = sweepList.find((s) => s.id === pose.sweep)?.puckPosition;
  if (!puck) return;
  const W = pose.W, Hh = pose.H;
  const x = rect ? Math.max(0.2, Math.min(0.8, (rect.x + rect.w / 2) / W)) : 0.54;
  const coordinates = phase === 'hop'
    ? [[0.52, 0.73], [0.48, 0.73], [0.56, 0.73]]
    : [[x, 0.88], [0.52, 0.88], [0.42, 0.78], [0.62, 0.78], [0.51, 0.69]];
  const points = await Promise.all(coordinates.map(([u, v]) => hitAt(u * W, v * Hh)));
  if (ticket !== roverMotion || !sameFrame(pose, snapPose())) return;
  const current = rover.component.inputs.destination || puck;
  if (phase === 'hop') {
    const [p, a, b] = points;
    if (p && a && b && p.y - puck.y > 0.09 && p.y - puck.y < 0.35 && dist(p, current) < 0.95 &&
      Math.abs(p.y - a.y) < 0.035 && Math.abs(p.y - b.y) < 0.035 && dist(a, b) > 0.08) {
      roverAt(p, 'inspect', { hop: true });
      return;
    }
    hint('Sandra needs a nearby, level surface for a hop.', 3500);
  }
  const clear = points.find((p) => p && Math.abs(p.y - puck.y) < 0.12 && dist(p, puck) < 2 &&
    Math.hypot(p.x - pose.position.x, p.z - pose.position.z) > 0.85);
  roverAt(clear || puck, phase === 'hop' ? 'scan' : phase, { snap: !clear && dist(current, puck) > 3 });
}
