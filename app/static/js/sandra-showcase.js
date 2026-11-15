/* Plays prepared cues against the original scan and already-approved changes. */
(function () {
  const controls = $('#showcase-controls');
  const playButton = $('#showcase-play'), previous = $('#showcase-back'), next = $('#showcase-next');
  const plan = window.TOUR_PLAN || {};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let scenes = [], index = 0, token = 0, playing = false, started = false, completed = false;
  let tail = Promise.resolve(), wake;
  let rail = null, railStop = null;

  function WallRail() {
    this.inputs = { fixture: null, visible: false };
    this.onInit = function () {
      const T = this.context.three, { anchors, normal } = this.inputs.fixture;
      const root = new T.Group(), up = new T.Vector3(0, 1, 0);
      const points = anchors.map((p) => new T.Vector3(p.x, p.y, p.z));
      const out = new T.Vector3(normal.x, normal.y, normal.z).normalize();
      const tips = points.map((p) => p.clone().addScaledVector(out, 0.086));
      // The scan mesh sits a few millimetres proud of the real wall and would hide the rail. It is only ever shown
      // from its own scan point, where nothing stands between the viewer and that wall, so draw it on top.
      const finish = new T.MeshBasicMaterial({ color: 0x5b6264, depthTest: false });
      const edge = new T.MeshBasicMaterial({ color: 0x8c9496, depthTest: false });
      const tube = (a, b, radius, material) => {
        const joint = new T.Mesh(new T.CylinderGeometry(radius, radius, a.distanceTo(b), 20), material);
        joint.position.copy(a).lerp(b, 0.5);
        joint.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        root.add(joint);
      };
      points.forEach((p, i) => {
        const wall = p.clone().addScaledVector(out, 0.008);
        tube(wall, p.clone().addScaledVector(out, 0.026), 0.047, finish);
        tube(wall, tips[i], 0.016, edge);
        const cap = new T.Mesh(new T.SphereGeometry(0.018, 16, 10), edge);
        cap.position.copy(tips[i]); root.add(cap);
      });
      tube(tips[0], tips[1], 0.018, edge);
      root.traverse((node) => { node.renderOrder = 3500; });
      root.visible = false;
      this.outputs.objectRoot = root;
      this.onDestroy = () => {
        root.traverse((node) => node.geometry?.dispose());
        finish.dispose(); edge.dispose();
      };
    };
    this.onInputsUpdated = function () { this.outputs.objectRoot.visible = this.inputs.visible; };
  }

  function refreshPreview() {
    if (!rail) return;
    const visible = !!railStop && view === 'after' && poseCache?.mode === 'mode.inside' &&
      poseCache.sweep === railStop.sweep && stationedSweep === railStop.sweep;
    if (rail.component.inputs.visible !== visible) {
      rail.component.inputs.visible = visible;
      rail.component.onInputsUpdated?.();
    }
  }

  function aim(from, at, pitch) {
    return { x: pitch, y: Math.atan2(from.x - at.x, from.z - at.z) * 180 / Math.PI };
  }

  function savedScenes(ready) {
    return ready.flatMap((e) => {
      const p = e.patches.find((patch) => !patch.extra && patch.pose && sweepList.some((s) => s.id === patch.sweep)) ||
        e.patches.find((patch) => patch.pose && sweepList.some((s) => s.id === patch.sweep));
      return p ? [{ sweep: p.sweep, title: e.title, room: e.room, kind: 'saved', rotation: p.rot,
        detail: (e.cost ? money(e.cost) + ' estimated installed. ' : '') + 'Preview from your saved plan.' }] : [];
    });
  }

  function prepare() {
    const first = currentRoom();
    const start = poseCache.sweep;
    const ready = edits.filter((e) => e.status === 'ready' && e.on !== false);
    const prepared = [{ sweep: start, title: 'Come with me', room: first?.label,
      detail: 'I’ll show you the rooms and the features that matter to your search.' }];
    const rooms = roomList.filter((r) => !/closet|pantry|utility/i.test(r.label));
    const used = new Set([start]);
    const chosen = (plan.features || []).filter((f) => NEEDS.includes(f.need))
      .sort((a, b) => Number(b.status === 'yes') - Number(a.status === 'yes'));
    for (const feature of chosen) {
      const room = rooms.find((r) => new RegExp(feature.room, 'i').test(r.label) && !used.has(centerSweep(r).id));
      if (!room) continue;
      const s = centerSweep(room);
      used.add(s.id);
      prepared.push({ sweep: s.id, room: room.label, title: feature.title, detail: feature.detail, source: feature.source });
      if (prepared.length >= 4) break;
    }
    // Visit the stops nearest-first so the tour never doubles back through the home.
    const ordered = [prepared[0]], rest = prepared.slice(1);
    while (rest.length) {
      const from = ordered[ordered.length - 1].sweep;
      const steps = (scene) => scene.sweep === from ? 0 : (sweepPath(from, scene.sweep).length || 99);
      rest.sort((a, b) => steps(a) - steps(b));
      ordered.push(rest.shift());
    }
    prepared.splice(0, prepared.length, ...ordered);
    const authored = plan.preview;
    const exampleAvailable = authored && sweepList.some((s) => s.id === authored.sweep) &&
      (!NEEDS.length || authored.needs.some((key) => NEEDS.includes(key)));
    if (exampleAvailable) {
      const room = rooms.find((r) => r.sweeps.some((s) => s.id === authored.sweep));
      // Show the example right after the stop in the same room, instead of walking back across the home later.
      const scene = { ...authored, room: room?.label || 'Bathroom' };
      const sameRoom = prepared.findIndex((p) => p.sweep === authored.sweep || (room && p.room === room.label));
      if (sameRoom >= 0) prepared.splice(sameRoom + 1, 0, scene); else prepared.push(scene);
      used.add(authored.sweep);
    }
    if (prepared.length < 4) {
      for (const room of rooms) {
        const s = centerSweep(room);
        if (used.has(s.id)) continue;
        used.add(s.id);
        prepared.push({ sweep: s.id, room: room.label, title: room.label, detail: 'Take a look at how this room connects to the rest of the home.' });
        if (prepared.length >= 4) break;
      }
    }
    if (prepared.length === 1) {
      const near = sweepList.find((s) => s.id !== start && sweepPath(start, s.id).length === 1);
      if (near) prepared.push({ sweep: near.id, title: 'Look around', detail: 'Here’s another view of the layout.' });
    }
    return prepared.concat(savedScenes(ready));
  }

  function update(state) {
    controls.dataset.state = state;
    document.body.classList.toggle('showcase-playing', playing);
    playButton.disabled = !scenes.length;
    playButton.textContent = playing ? 'Pause tour' : completed || state === 'explore' ? 'Replay tour' : started ? 'Resume tour' : 'Start tour';
    previous.disabled = !scenes.length || index <= 0;
    next.disabled = !scenes.length || index >= scenes.length - 1;
    const progress = $('#showcase-progress');
    progress.max = Math.max(scenes.length, 1);
    progress.value = completed ? scenes.length : Math.min(index + 1, scenes.length);
  }

  function describe(scene, moving = false) {
    const source = { scan: 'Scan evidence', listing: 'Listing evidence', check: 'Check in tour' }[scene.source];
    const label = scene.kind === 'wall_rail' ? 'Prepared example' : scene.kind === 'saved' ? 'Saved change' :
      [scene.room, source].filter(Boolean).join(' · ') || 'Guided tour';
    $('#showcase-chapter').textContent = label + ' · ' + (index + 1) + ' of ' + scenes.length;
    // While walking, say where we're going; the explanation appears once we're there.
    const travelling = moving && scene.room && currentRoom()?.label !== scene.room;
    $('#showcase-title').textContent = travelling ? 'Walking to the ' + scene.room.replace(/ \d+$/, '').toLowerCase() + '…' : scene.title;
    $('#showcase-detail').textContent = travelling ? '' : scene.detail || '';
  }

  function hold(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wake = null; resolve(); };
      const timer = setTimeout(done, ms);
      wake = done;
    });
  }

  function lead(from, target, following) {
    const end = target?.puckPosition;
    if (!end) return;
    const here = from?.puckPosition;
    const ahead = following?.puckPosition;
    // Both movement endpoints are original scan waypoints. The rover can lead into the next leg on the same floor.
    if (here && dist(here, end) > 0.5 && !rover?.component.inputs.destination) roverAt(here, 'walk', { snap: true, curve: 0 });
    if (ahead && Math.abs(ahead.y - end.y) < 0.18 && dist(ahead, end) < 3.25) {
      roverAt({ x: end.x + (ahead.x - end.x) * 0.37, y: end.y, z: end.z + (ahead.z - end.z) * 0.37 }, 'walk', { curve: 0 });
    } else roverToSweep(target.id);
  }

  async function move(scene, id) {
    const target = sweepList.find((s) => s.id === scene.sweep);
    if (!target) return false;
    const path = sweepPath(poseCache.sweep, scene.sweep);
    if (!path.length && poseCache.sweep !== scene.sweep) { console.warn('No route to scene', scene.sweep, poseCache.sweep); return false; }
    for (const [i, step] of path.entries()) {
      if (id !== token) return false;
      const from = sweepList.find((s) => s.id === poseCache.sweep);
      const following = path[i + 1];
      const rotation = following ? aim(step.position, following.position, -13) : (scene.rotation || aim(poseCache.position, step.position, -15));
      lead(from, step, following);
      // Wait for each hop to really finish: the pose reports the new scan point mid-flight, and a move sent
      // during a flight is rejected. If a hop is rejected anyway, try it once more.
      for (let attempt = 0; attempt < 2 && id === token && poseCache.sweep !== step.id; attempt++) {
        await soon(sdk.Sweep.moveTo(step.id, { rotation,
          transition: reduced.matches || attempt ? sdk.Sweep.Transition.FADEOUT : sdk.Sweep.Transition.FLY,
          transitionTime: reduced.matches || attempt ? 360 : Math.min(1200, Math.max(620, dist(poseCache.position, step.position) * 380)),
        }), 5000);
        for (let i = 0; id === token && poseCache.sweep !== step.id && i < 25; i++) await sleep(80);
      }
      if (id !== token) return false;
      if (poseCache.sweep !== step.id) { console.warn('Tour step did not land', step.id, poseCache.sweep); return false; }
      await sleep(120);
    }
    if (id !== token) return false;
    if (scene.rotation && (!path.length || Math.abs(poseCache.rotation.x - scene.rotation.x) > 5)) {
      if (reduced.matches) await soon(sdk.Sweep.moveTo(scene.sweep, { rotation: scene.rotation,
        transition: sdk.Sweep.Transition.FADEOUT, transitionTime: 340 }), 1400);
      else await lookAt(scene.rotation, 140, () => id === token);
    }
    return id === token;
  }

  async function roll(id, manualStep = false) {
    while (id === token && index < scenes.length) {
      const scene = scenes[index];
      railStop = null;
      refreshPreview();
      describe(scene, true);
      update(playing ? 'playing' : 'paused');
      const arrived = await move(scene, id);
      if (id !== token) return;
      describe(scene);
      if (arrived) {
        if (scene.kind === 'wall_rail') { railStop = scene; refreshPreview(); }
        if (!manualStep) {
          // Start a small floor-checked gesture while the caption is on screen.
          setRoverState(scene.kind ? 'inspect' : 'scan').catch(() => {});
          await hold(reduced.matches ? 3900 : scene.kind ? 4200 : 3100);
        }
      }
      if (id !== token || manualStep) return;
      if (index === scenes.length - 1) break;
      index++;
    }
    if (id !== token) return;
    playing = false;
    completed = true;
    update('finished');
    if (customScenes) {      // just walked the buyer through their own changes: sum them up
      const kept = edits.filter((e) => e.status === 'ready' && e.on !== false);
      const total = kept.reduce((sum, e) => sum + (e.cost || 0), 0);
      $('#showcase-chapter').textContent = 'Your changes';
      $('#showcase-title').textContent = kept.length + ' change' + (kept.length === 1 ? '' : 's') + ' · about ' + money(total) + ' installed';
      $('#showcase-detail').textContent = 'All in: ' + (H.rent ? money(H.price) + '/mo + ' + money(total) : money(H.price + total)) +
        '. Hold B to compare with today, or keep exploring and tell me what else you’d change.';
      return;
    }
    $('#showcase-chapter').textContent = 'Tour complete';
    $('#showcase-title').textContent = 'Take a closer look';
    $('#showcase-detail').textContent = 'Replay a scene, or explore at your pace and tell me what you’d change.';
  }

  function pause(explore = false) {
    if (!scenes.length) {
      if (explore) { started = true; controls.dataset.state = 'explore'; }
      return;
    }
    token++;
    playing = false;
    wake?.();
    if (explore) {
      railStop = null; refreshPreview();
      update('explore');
    } else { update('paused'); if (scenes[index]) describe(scenes[index]); }
  }

  function launch(at = index, manual = false) {
    if (!scenes.length || agentBusy) return Promise.resolve();
    window.emptyRoom?.leave();
    tourDecision?.('stop');
    closeDrawers();
    if (!$('#photos').classList.contains('hidden')) switchView('tour');
    setMode('walk');
    const id = ++token;
    wake?.();
    index = Math.max(0, Math.min(at, scenes.length - 1));
    started = true; completed = false;
    playing = !manual;
    update(manual ? 'paused' : 'playing');
    tail = tail.catch(() => {}).then(() => id === token && roll(id, manual)).catch((err) => {
      if (id !== token) return;
      console.warn('Prepared tour interrupted', err);
      pause();
      $('#showcase-detail').textContent = 'The camera could not reach that scene. Try the next scene or explore freely.';
    });
    return tail;
  }

  async function boot() {
    if (plan.preview && sweepList.some((s) => s.id === plan.preview.sweep)) {
      try {
        await sdk.Scene.register('fd.wall-rail', () => new WallRail());
        rail = await addNode('fd.wall-rail', { fixture: plan.preview, visible: false });
      } catch (err) { console.warn('Prepared preview unavailable', err); plan.preview = null; }
    }
    if (!poseCache?.sweep || !sweepList.length) { unavailable(); return; }
    const userExploring = started || new URLSearchParams(location.search).get('explore') === '1';
    scenes = prepare();
    controls.dataset.ready = 'true';
    describe(scenes[0]);
    update(userExploring ? 'explore' : 'paused');
    try {
      const doc = iframe.contentDocument;
      doc.addEventListener('pointerdown', () => { if (playing) pause(true); }, true);
      doc.addEventListener('wheel', () => { if (playing) pause(true); }, { passive: true, capture: true });
      doc.addEventListener('keydown', (e) => { if (playing && ['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) pause(true); }, true);
    } catch {}
    if (!userExploring && !reduced.matches) launch(0);
  }

  function unavailable() {
    controls.dataset.ready = 'false';
    $('#showcase-title').textContent = 'The scan couldn’t start';
    $('#showcase-detail').textContent = 'Reload to try again, or open the listing photos from More.';
    playButton.disabled = true;
  }

  playButton.onclick = () => {
    if (playing) { pause(); return; }
    if (completed || controls.dataset.state === 'explore') {
      if (!customScenes) scenes = prepare();
      launch(0);
    } else launch(index);
  };
  previous.onclick = () => launch(index - 1, !playing);
  next.onclick = () => launch(index + 1, !playing);
  $('#showcase-explore').onclick = () => pause(true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && playing) pause(true); });
  $('#chat-input').addEventListener('focus', () => { if (controls.dataset.state === 'paused' || playing) pause(true); });
  let customScenes = false;
  function playSaved(ready) {
    const saved = savedScenes(ready);
    if (!saved.length) return Promise.resolve();
    scenes = saved;
    customScenes = true;
    setView('after');
    return launch(0);
  }
  function takeControl() { pause(true); return tail; }
  window.sandraShowcase = { boot, unavailable, playSaved, refreshPreview, takeControl, get playing() { return playing; }, get scenes() { return scenes; }, get rail() { return rail; } };
})();
