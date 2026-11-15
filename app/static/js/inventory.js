/* Original scan observations and conservative identity across camera angles. */
const inventoryKey = 'frontdoor-inventory-v1-' + H.id;
let recognized = {};
try { recognized = JSON.parse(localStorage.getItem(inventoryKey) || '{}') || {}; } catch {}
const detectedViews = new Map();

function viewKey(pose) {
  const round = (value) => Math.round(value * 10) / 10;
  return [pose.sweep, round(pose.rotation.x), round((pose.rotation.y + 720) % 360),
    (pose.W / pose.H).toFixed(3), pose.projection?.[5]?.toFixed(3)].join(':');
}

function isObjectRect(box, p) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => !Number.isFinite(v) || v < 0 || v > 1000)) return null;
  const [y0, x0, y1, x1] = box;
  if (y1 - y0 < 3 || x1 - x0 < 3) return null;
  return { x: x0 * p.W / 1000, y: y0 * p.H / 1000, w: (x1 - x0) * p.W / 1000, h: (y1 - y0) * p.H / 1000 };
}

function fixtureKind(value, scope = '') {
  const s = String(value || '').toLowerCase().replaceAll('_', ' ');
  if (scope === 'roll_under_sink' || /(?:base|under.sink|vanity) cabinet|roll.under/.test(s)) return 'vanity_cabinet';
  if (/handle|knob|lever/.test(s) && /door|lever|knob/.test(s)) return 'door_handle';
  if (/shower.*(?:valve|control)|control.*shower/.test(s)) return 'shower_control';
  if (/shower.?head/.test(s)) return 'shower_head';
  if (/faucet|tap\b/.test(s)) return 'faucet';
  if (/sink|basin/.test(s)) return 'sink_basin';
  if (/countertop|counter top/.test(s)) return 'countertop';
  if (/vanity/.test(s)) return 'vanity';
  if (/tub|shower/.test(s)) return 'shower';
  if (/doorway|door\b/.test(s)) return 'door';
  if (/grab bar|handrail/.test(s)) return 'grab_bar';
  return s.trim().replace(/\W+/g, '_');
}

function registerFixture(kind, label, roomId, anchor, observation) {
  const entries = Object.values(recognized).filter((x) => x.kind === kind && x.roomId === roomId);
  let match = entries.find((x) => x.views[observation.key]?.some((box) =>
    box.every((n, i) => Math.abs(n - observation.box[i]) <= 36)));
  if (!match && anchor) {
    const near = entries.map((x) => [x, x.anchor ? dist(x.anchor, anchor) : Infinity]).sort((a, b) => a[1] - b[1]);
    if (near[0]?.[1] <= 0.32 && (!near[1] || near[1][1] - near[0][1] > 0.12)) match = near[0][0];
  }
  if (!match) {
    const id = 'o-' + crypto.randomUUID();
    match = recognized[id] = { id, kind, label, roomId, anchor, views: {}, touched: Date.now() };
  }
  const boxes = match.views[observation.key] ||= [];
  if (!boxes.some((b) => b.every((n, i) => Math.abs(n - observation.box[i]) < 8))) boxes.push(observation.box);
  if (!match.anchor && anchor) match.anchor = anchor;
  match.touched = Date.now();
  return match;
}

function saveInventory() {
  // Keep recent rooms locally. The server caches frame detections independently.
  const entries = Object.values(recognized).sort((a, b) => b.touched - a.touched).slice(0, 450);
  recognized = Object.fromEntries(entries.map((e) => [e.id, e]));
  try { localStorage.setItem(inventoryKey, JSON.stringify(recognized)); } catch {}
}

function groundedAnchor(view, box) {
  const rect = isObjectRect(box, view.pose);
  if (!rect) return null;
  const hits = view.hits || [];
  const inside = hits.filter((h) => covers(rect, { x: h.x - 1, y: h.y - 1, w: 2, h: 2 }, 0.5));
  return inside.length ? worldFromRect(rect, inside, view.pose)?.center || null : null;
}

async function identifyViews(views) {
  const missing = [];
  const keys = views.map(({ pose }) => viewKey(pose));
  keys.forEach((key, i) => { if (!detectedViews.has(key) && views[i].image) missing.push(i); });
  if (missing.length) {
    const response = await postEdit('agent/objects', {
      views: missing.map((i) => ({ key: keys[i], image: views[i].image })),
    });
    for (const row of response.views || []) {
      const i = missing[row.view];
      if (i === undefined) continue;
      const view = views[i], key = keys[i], ids = new Map();
      const objects = [];
      for (const o of row.objects || []) {
        if (!isObjectRect(o.box_2d, view.pose)) continue;
        const kind = fixtureKind(o.kind);
        const item = registerFixture(kind, o.label, view.roomId, groundedAnchor(view, o.box_2d), { key, box: o.box_2d });
        ids.set(o.id, item.id);
        objects.push({ ...o, object_id: item.id, kind });
      }
      for (const obj of objects) obj.parent = ids.get(obj.parent) || null;
      detectedViews.set(key, objects);
    }
    saveInventory();
  }
  return keys.map((key) => detectedViews.get(key) || []);
}

function fixtureForFinding(finding, pose, roomId, world, objects = [], scope) {
  const kind = fixtureKind(finding.kind || finding.item || finding.title, scope);
  const box = scope === 'roll_under_sink' ? finding.edit_box_2d || finding.box_2d : finding.box_2d;
  const rect = isObjectRect(box, pose);
  if (!rect || !kind) return null;
  const matches = objects.filter((obj) => obj.kind === kind).map((obj) => ({ obj, rect: isObjectRect(obj.box_2d, pose) }));
  const match = matches.find((o) => covers(rect, o.rect, 0.55) && covers(o.rect, rect, 0.45));
  const entry = registerFixture(kind, match?.obj.label || finding.item || kind, roomId, world?.center, {
    key: viewKey(pose), box: match?.obj.box_2d || box,
  });
  saveInventory();
  return entry;
}

function editIntent(kind, title, scope) {
  if (scope === 'roll_under_sink') return 'roll_under';
  if (kind === 'door_handle' && /lever|knob/i.test(title)) return 'door_hardware';
  if (kind === 'shower' && /curbless|roll.in|walk.in/i.test(title)) return 'shower_access';
  return String(title || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

function matchesEdit(target, edit) {
  if (!edit.source || edit.status !== 'ready' || edit.roomId !== target.roomId) return false;
  const kind = edit.kind || fixtureKind(edit.item + ' ' + edit.title, edit.scope);
  if (!kind || kind !== target.kind || (edit.intent || editIntent(kind, edit.title, edit.scope)) !== target.intent) return false;
  if (edit.objectId && target.objectId === edit.objectId) return true;
  const oldObject = recognized[edit.objectId], newObject = recognized[target.objectId];
  if (oldObject && newObject && Object.keys(oldObject.views).some((key) => key in newObject.views)) return false;
  const a = edit.world?.center, b = target.world?.center;
  return !!(a && b && dist(a, b) <= 0.55);
}

/* Capture new reachable angles after the buyer settles at a scan point. */
const coverageEager = new Set();
const angleAttempts = new Map();
const originalPhotos = new Map();
let coverageTimer = null;
let coverageBusy = false;

function scheduleCoverage() {
  clearTimeout(coverageTimer);
  coverageTimer = setTimeout(() => { prepareCurrentAngle().catch((err) => console.warn('Angle preview:', err)); }, 800);
}

async function originalPhoto(e) {
  const rid = e.source.rid;
  if (originalPhotos.has(rid)) return originalPhotos.get(rid);
  const response = await fetch('/api/home/' + H.id + '/render/' + rid + '/before');
  if (!response.ok) throw new Error('The saved original photo is unavailable.');
  const blob = await response.blob();
  const frame = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  if (originalPhotos.size >= 5) originalPhotos.delete(originalPhotos.keys().next().value);
  originalPhotos.set(rid, frame);
  return frame;
}

async function prepareCurrentAngle(force = false) {
  if (coverageBusy || !sdk || !stationedSweep || poseCache?.sweep !== stationedSweep ||
    mode === 'select' || view !== 'after' || poseCache.mode !== 'mode.inside') return false;
  const sweep = sweepList.find((s) => s.id === stationedSweep);
  if (!sweep) return false;
  const edit = edits.find((e) => {
    if (!e.source || !e.world?.points?.length || e.status !== 'ready' || e.on === false || coverageEager.has(e.id) ||
      e.patches.some((p) => p.sweep === sweep.id) || dist(e.world.center, sweep.position) > 6 || Math.abs(e.world.center.y - sweep.position.y) > 2.3) return false;
    if (!projectBox(e.world, poseCache, sdk, { w: iframe.clientWidth, h: iframe.clientHeight })) return false;
    const id = e.id + ':' + e.revision + ':' + sweep.id;
    const tries = angleAttempts.get(id);
    return force || (!tries || (tries.count < 2 && Date.now() >= tries.next));
  });
  if (!edit) return false;
  coverageBusy = true;
  const revision = edit.revision;
  const key = edit.id + ':' + revision + ':' + sweep.id;
  const attempts = (angleAttempts.get(key)?.count || 0) + 1;
  const status = $('#coverage-status');
  if (status) status.textContent = 'Checking this angle for ' + edit.title;
  let checked = false;
  try {
    const views = await queueNearbyCapture(edit, edit.source.pose, revision, [sweep]);
    if (views.length && activeEdit(edit, revision)) {
      checked = true;
      const frame = await originalPhoto(edit);
      const angles = await locateNearby(edit, { ...edit.source, frame }, views, revision);
      await renderNearby(edit, Promise.resolve(angles), revision, edit.source.rid);
    }
    if (status && stationedSweep === sweep.id) status.textContent = edit.patches.some((p) => p.sweep === sweep.id)
      ? 'Preview available from this angle.' : 'This angle has no verified preview.';
  } finally {
    if (angleAttempts.size > 350) angleAttempts.clear();
    angleAttempts.set(key, { count: attempts, next: Date.now() + (checked ? 65000 : 12500) });
    coverageBusy = false;
    if (stationedSweep !== sweep.id || edit.patches.some((p) => p.sweep === sweep.id)) scheduleCoverage();
    else if (!checked && attempts < 2) {
      setTimeout(() => { if (stationedSweep === sweep.id) scheduleCoverage(); }, 13000);
    }
  }
  return true;
}
