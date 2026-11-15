/* Empty rooms: Sandra clears out furniture and belongings the moment you arrive, without being asked.
   Each scan point's 360 panorama is de-furnished by the image model (walls, windows, floors, built-ins stay
   pixel-aligned, so the room's real dimensions are untouched), cached on the server, and wrapped on a sphere
   centered on that scan point. A toggle brings the furniture back for comparison. */
(function () {
  const HID = window.HOME.id;
  const KEY = `fd-empty-${HID}`;
  const st = {
    on: (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })(),
    spheres: {},      // sweep -> { comp, center }
    pending: {},      // sweep -> promise
    failed: {},
    // Matterport's equirectangular is centered on the camera heading at capture time; the sphere turns by that
    // heading plus a fixed offset (calibrated in the live tour by matching the sphere against the real view).
    sign: 1, offset: -90,
  };

  function EmptySphere() {
    this.inputs = { url: '', center: null, yaw: 0, visible: false };
    this.onInit = function () {
      const T = this.context.three;
      const geo = new T.SphereGeometry(8, 96, 64); geo.scale(-1, 1, 1);   // look at it from the inside
      const tex = new T.TextureLoader().load(this.inputs.url, () => { this.loaded = true; this.apply(); });
      if ('colorSpace' in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding;
      tex.anisotropy = 8;
      this.mat = new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false });
      this.mesh = new T.Mesh(geo, this.mat);
      this.mesh.renderOrder = 2500; this.mesh.frustumCulled = false;
      this.outputs.objectRoot = this.mesh; this.apply();
    };
    this.apply = function () {
      const c = this.inputs.center;
      if (c) this.mesh.position.set(c.x, c.y, c.z);
      this.mesh.rotation.y = this.inputs.yaw;
      if (this.inputs.visible && this.loaded) this.mesh.visible = true;
    };
    this.onInputsUpdated = function () { this.apply(); };
    this.onTick = function (dt) {   // the room "clears" with a soft fade instead of popping
      const s = Math.min(0.3, dt > 1 ? dt / 1000 : dt), want = this.inputs.visible && this.loaded ? 1 : 0;
      const o = this.mat.opacity + Math.sign(want - this.mat.opacity) * s / 0.7;
      this.mat.opacity = Math.max(0, Math.min(1, o));
      this.mesh.visible = this.mat.opacity > 0.001;
    };
    this.onDestroy = function () { this.mesh.geometry.dispose(); this.mat.map?.dispose(); this.mat.dispose(); };
  }

  const atSweep = (id) => poseCache && poseCache.mode === 'mode.inside' && poseCache.sweep === id;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function setVisible(id, v) {
    const s = st.spheres[id];
    if (!s || s.comp.component.inputs.visible === v) return;
    s.comp.component.inputs.visible = v;
  }
  function hideAll(except) { for (const id in st.spheres) if (id !== except) setVisible(id, false); }

  const sphereYaw = (captureYaw) => (st.sign * captureYaw + st.offset) * Math.PI / 180;
  async function mount(id, center, captureYaw) {
    if (st.spheres[id]) return st.spheres[id];
    const comp = await addNode('fd.empty', { url: `/api/home/${HID}/empty/${id}`, center, yaw: sphereYaw(captureYaw), visible: false });
    return (st.spheres[id] = { comp, center, captureYaw });
  }

  // Grab the real (furnished) panorama: our spheres and Sandra must be out of the shot.
  async function capture() {
    hideAll(null);
    // `rover` is a top-level let in sandra-rover.js: classic scripts share that scope (it is not on window)
    const model = (typeof rover !== 'undefined' && rover) ? rover.component?.model : null, was = model?.visible;
    if (model) model.visible = false;
    await wait(800);   // let the fade finish
    try {
      for (let k = 0; k < 3; k++) {   // the panorama is centered on the heading: retake if the camera turned meanwhile
        const yaw = poseCache.rotation.y, image = await sdk.Renderer.takeEquirectangular();
        if (Math.abs(((poseCache.rotation.y - yaw + 540) % 360) - 180) < 0.5 || k === 2) return { image, yaw };
        await wait(400);
      }
    }
    finally { if (model) model.visible = was; }
  }

  function status(text, busy) {
    const el = document.getElementById('empty-status');
    if (!el) return;
    el.querySelector('.txt').textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  async function arrive(id) {
    if (!st.on || !id) return;
    await wait(450);                      // let the move settle
    if (!atSweep(id)) return;
    hideAll(id);
    const center = { ...poseCache.position };
    if (st.spheres[id]) { setVisible(id, true); status('Empty room', false); return; }
    if (st.failed[id] || st.pending[id]) return;
    st.pending[id] = (async () => {
      try {
        const head = await fetch(`/api/home/${HID}/empty/${id}?meta=1`, { cache: 'no-store' });   // made already?
        let ok = head.ok, yaw = ok ? +((await head.json()).yaw || 0) : 0;
        if (!ok) {
          status('Clearing furniture…', true);
          if (typeof roverSay === 'function') roverSay('Clearing this room so you can see the space.', 4500);
          const shot = await capture(); yaw = shot.yaw;
          const r = await fetch(`/api/home/${HID}/empty/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shot) });
          ok = r.ok;
          if (!ok) { st.failed[id] = true; status('Could not clear this room', false); return; }
        }
        await mount(id, center, yaw);
        if (st.on && atSweep(id)) { setVisible(id, true); status('Empty room', false); }
      } catch (e) { console.warn('empty room', e); st.failed[id] = true; status('Could not clear this room', false); }
      finally { delete st.pending[id]; }
    })();
  }

  function toggle(on) {
    st.on = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
    const btn = document.getElementById('empty-toggle');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Show furnished' : 'Empty the rooms';
    if (on) arrive(poseCache?.sweep); else { hideAll(null); status('Furnished (as listed)', false); }
  }

  function ui() {
    if (document.getElementById('empty-status')) return;
    const row = document.querySelector('.tl-row');
    const box = document.createElement('div');
    box.id = 'empty-status';
    box.className = row ? 'tl-pill' : '';
    box.innerHTML = '<span class="dot"></span><span class="txt">Empty room</span><button id="empty-toggle" type="button"></button>';
    (row || document.getElementById('showcase').parentElement).appendChild(box);
    const css = document.createElement('style');
    css.textContent = `#empty-status{gap:.45rem;padding-right:4px}
      #empty-status .dot{width:8px;height:8px;border-radius:50%;background:#ff5fa2}
      #empty-status.busy .dot{animation:emptyPulse 1s ease-in-out infinite}
      @keyframes emptyPulse{50%{opacity:.25;transform:scale(1.6)}}
      #empty-toggle{background:#0a0a0a;color:#fff;border-radius:999px;padding:.15rem .65rem;font-weight:600;font-size:.75rem;height:24px}
      @media (prefers-reduced-motion: reduce){#empty-status.busy .dot{animation:none}}`;
    document.head.appendChild(css);
    document.getElementById('empty-toggle').onclick = () => toggle(!st.on);
    toggle(st.on);
  }

  /* Calibration helper (dev): compare the sphere with the real view to find the yaw that lines them up. */
  window.emptyRoom = {
    state: st,
    calibrate(sign, offset) { st.sign = sign; st.offset = offset; for (const id in st.spheres) st.spheres[id].comp.component.inputs.yaw = sphereYaw(st.spheres[id].captureYaw); },
    arrive, toggle,
  };

  // start once the tour (tour.js) has connected the SDK
  const boot = setInterval(async () => {
    if (!window.sdk && typeof sdk === 'undefined') return;
    if (typeof sdk === 'undefined' || !sdk || !poseCache) return;
    clearInterval(boot);
    try { await sdk.Scene.register('fd.empty', () => new EmptySphere()); } catch (e) { console.warn(e); }
    ui();
    sdk.Sweep.current.subscribe((s) => {
      const id = s.id || s.sid || '';
      if (!id) { hideAll(null); return; }
      if (!atSweep(id)) hideAll(null);
      arrive(id);
    });
    sdk.Mode.current.subscribe((m) => { if (m !== 'mode.inside') hideAll(null); });
    // the moment the camera leaves a scan point (walking, flying out), its sphere must go: it is only true from there
    sdk.Camera.pose.subscribe((p) => {
      for (const id in st.spheres) {
        const s = st.spheres[id], c = s.center, inp = s.comp.component.inputs;
        if (inp.visible && Math.hypot(p.position.x - c.x, p.position.y - c.y, p.position.z - c.z) > 0.04) inp.visible = false;
      }
    });
  }, 400);
})();
