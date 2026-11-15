/* Optional defurnished preview for one original Matterport scan position. */
(function () {
  const HID = window.HOME.id;
  const st = {
    preview: null,
    spheres: {},
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

function current(preview) {
    return st.preview === preview && stationedSweep === preview.sweep && samePosition(preview.pose, poseCache);
  }

  function hideSphere(sphere) {
    const component = sphere.comp.component;
    component.inputs.visible = false;
    component.mat.opacity = 0;
    component.outputs.objectRoot.visible = false;
  }

  async function mount(preview, yaw) {
    const id = preview.sweep;
    if (!st.spheres[id]) {
      const rotation = (st.sign * yaw + st.offset) * Math.PI / 180;
      const node = await addNode('fd.empty', {
        url: '/api/home/' + HID + '/empty/' + id, center: preview.pose.position, yaw: rotation, visible: false,
      });
      st.spheres[id] = { comp: node, captureYaw: yaw };
    }
    return st.spheres[id];
  }

  async function capture(preview) {
    if (!current(preview) || capturingOriginal) return null;
    const model = rover?.component?.model, shown = model?.visible;
    capturingOriginal = true;
    refreshVisibility();
    if (model) model.visible = false;
    try {
      // Let the scene apply the visibility changes before capturing the original view.
      await sleep(100);
      for (let attempt = 0; attempt < 2 && current(preview); attempt++) {
        const frame = snapPose();
        const image = await soon(sdk.Renderer.takeEquirectangular(), 7000);
        if (image && current(preview) && sameFrame(frame, snapPose())) {
          return { image, yaw: frame.rotation.y, sweep: preview.sweep, model: window.HOME.matterport_id };
        }
      }
      return null;
    } finally {
      if (model) model.visible = shown && poseCache?.mode === 'mode.inside';
      capturingOriginal = false;
      refreshVisibility();
    }
  }

  function status(text, busy) {
    const el = document.getElementById('empty-status');
    if (!el) return;
    el.querySelector('.txt').textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function setButton(on) {
    const button = document.getElementById('empty-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Show original' : 'Preview empty here';
  }

  function leave() {
    st.preview?.controller.abort();
    st.preview = null;
    Object.values(st.spheres).forEach(hideSphere);
    setButton(false);
    status('Original scan', false);
  }

  async function loadPreview() {
    if (!stationedSweep || poseCache?.sweep !== stationedSweep || poseCache.mode !== 'mode.inside') {
      status('Stop at a scan point first', false);
      return;
    }
    const preview = { sweep: stationedSweep, pose: snapPose(), controller: new AbortController() };
    st.preview = preview;
    setButton(true);
    status('Checking this view…', true);
    const endpoint = '/api/home/' + HID + '/empty/' + preview.sweep;
    const { signal } = preview.controller;
    try {
      let metadata = await fetch(endpoint + '?meta=1', { cache: 'no-store', signal });
      if (!current(preview)) return;
      if (metadata.status === 404) {
        status('Preparing this view…', true);
        const shot = await capture(preview);
        if (!current(preview)) return;
        if (!shot) throw new Error('The view changed before capture.');
        const saved = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(shot), signal });
        if (!saved.ok) {
          const result = await saved.json().catch(() => ({}));
          throw new Error(result.error || 'Could not create the preview.');
        }
        metadata = await fetch(endpoint + '?meta=1', { cache: 'no-store', signal });
      }
      if (!metadata.ok) throw new Error('The preview is unavailable.');
      const data = await metadata.json();
      if (!current(preview)) return;
      const sphere = await mount(preview, +data.yaw || 0);
      if (!current(preview)) return;
      sphere.comp.component.inputs.visible = true;
      status('AI preview · this view', false);
    } catch (err) {
      if (!current(preview)) return;
      leave();
      status(err.message || 'Could not preview this view', false);
    }
  }

  function ui() {
    if (document.getElementById('empty-status')) return;
    const row = document.querySelector('.tl-row');
    const box = document.createElement('div');
    box.id = 'empty-status';
    box.className = row ? 'tl-pill' : '';
    box.innerHTML = '<span class="dot"></span><span class="txt" role="status">Original scan</span><button id="empty-toggle" type="button"></button>';
    (row || document.getElementById('showcase').parentElement).appendChild(box);
    const css = document.createElement('style');
    css.textContent = `#empty-status{gap:.45rem;padding-right:4px}
      #empty-status .dot{width:8px;height:8px;border-radius:50%;background:#ff5fa2}
      #empty-status.busy .dot{animation:emptyPulse 1s ease-in-out infinite}
      @keyframes emptyPulse{50%{opacity:.25;transform:scale(1.6)}}
      #empty-toggle{background:#0a0a0a;color:#fff;border-radius:999px;padding:.15rem .65rem;font-weight:600;font-size:.75rem;height:24px}
      @media (prefers-reduced-motion: reduce){#empty-status.busy .dot{animation:none}}`;
    document.head.appendChild(css);
    document.getElementById('empty-toggle').onclick = async () => {
      if (st.preview) { leave(); return; }
      await window.sandraShowcase?.takeControl();
      if (!st.preview) loadPreview();
    };
    leave();
  }

  /* Calibration helper (dev): compare the sphere with the real view to find the yaw that lines them up. */
  window.emptyRoom = {
    state: st,
    calibrate(sign, offset) { st.sign = sign; st.offset = offset; for (const id in st.spheres) st.spheres[id].comp.component.inputs.yaw = sphereYaw(st.spheres[id].captureYaw); },
    leave,
  };

  // start once the tour (tour.js) has connected the SDK
  const boot = setInterval(async () => {
    if (!window.sdk && typeof sdk === 'undefined') return;
    if (typeof sdk === 'undefined' || !sdk || !poseCache) return;
    clearInterval(boot);
    try { await sdk.Scene.register('fd.empty', () => new EmptySphere()); } catch (e) { console.warn(e); }
    ui();
    sdk.Sweep.current.subscribe((sweep) => {
      if (st.preview && (sweep.id || sweep.sid) !== st.preview.sweep) leave();
    });
    sdk.Camera.pose.subscribe((pose) => {
      if (st.preview && !samePosition(st.preview.pose, pose)) leave();
    });
  }, 400);
})();
