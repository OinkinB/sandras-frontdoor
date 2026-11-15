/* Sandra's flow, in the buyer's hands:
 *  1. She asks who the home is for (never assumes a wheelchair).
 *  2. The buyer explores at their own pace. When they settle in a new room, Sandra looks at what they're looking at
 *     and may point out ONE thing. Anything they ask for or paint goes on their list (priced, not built yet).
 *  3. "Make my changes": Sandra builds the whole list (with quality checks), then walks them through each change
 *     like a realtor, one stop at a time, at their pace.
 */
(function () {
  const PROFILE_KEY = 'fd-profile';
  const OPTIONS = [
    ['wheelchair', 'Uses a wheelchair', ['no_stairs', 'step_free_entry', 'wide_doorways', 'walk_in_shower', 'smooth_flooring'], 'uses a wheelchair'],
    ['walker', 'Walker or cane', ['step_free_entry', 'grab_bars', 'walk_in_shower'], 'walks with a walker or cane (does not use a wheelchair)'],
    ['stairs', 'Stairs are hard', ['no_stairs', 'first_floor_bedroom'], 'finds stairs hard'],
    ['balance', 'Balance or falls', ['grab_bars', 'walk_in_shower'], 'is careful about balance and falls'],
    ['grip', 'Weak grip / arthritis', ['lever_handles'], 'has a weak grip (arthritis)'],
    ['vision', 'Low vision', ['even_lighting'], 'has low vision'],
    ['hearing', 'Hard of hearing', ['visual_alerts'], 'is hard of hearing'],
    ['sensory', 'Sensitive to noise', ['quiet_space'], 'is sensitive to noise'],
    ['none', 'Just looking', [], ''],
  ];
  const seenRooms = new Set();
  let started = false, making = false;

  const loadProfile = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch { return null; } };
  function applyProfile(p) {
    const picked = OPTIONS.filter(([k]) => p.keys.includes(k));
    const needs = [...new Set(picked.flatMap(([, , n]) => n))];
    NEEDS.splice(0, NEEDS.length, ...needs);
    const who = picked.map(([, , , d]) => d).filter(Boolean);
    PERSONA = (who.length ? 'The person living here ' + who.join(', ') + '.' : 'No specific access needs given; suggest only small universal improvements.') +
      (p.text ? ' In their words: ' + p.text : '') + (who.includes('uses a wheelchair') ? '' : ' They do NOT use a wheelchair.');
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); sessionStorage.setItem('fd-persona', PERSONA); } catch {}
    if (typeof info !== 'undefined' && info) fetch(`/api/home/${H.id}?needs=${NEEDS.join(',')}`).then((r) => r.json()).then((d) => { info = d; renderAccess(d); }).catch(() => {});
  }
  function guessKeys() {   // pre-select from the search, without ever adding a wheelchair on its own
    return OPTIONS.filter(([k, , n]) => k !== 'none' && n.length && n.every((x) => NEEDS.includes(x)) && (k !== 'wheelchair' || /wheelchair/i.test(PERSONA))).map(([k]) => k);
  }

  // One question, multi-select chips, a Done button; typing a description also answers it.
  function askNeeds(prefill) {
    return new Promise((resolve) => {
      tourDecision?.('stop');
      const chosen = new Set(prefill);
      const el = document.createElement('div');
      el.className = 'msg-in';
      el.innerHTML = '<strong>Hi, I’m Sandra. Who will live here, and what should home make easier?</strong>' +
        '<p>Pick any that fit, or just tell me in your own words. I’ll only suggest changes that help with these.</p>' +
        '<div class="choice-chips">' + OPTIONS.map(([k, label]) => `<button type="button" data-k="${k}" aria-pressed="${chosen.has(k)}">${esc(label)}</button>`).join('') + '</div>' +
        '<div class="decision-buttons"><button type="button" data-done class="sandra-primary">That’s it</button></div>';
      el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
        const k = b.dataset.k;
        if (chosen.has(k)) chosen.delete(k); else { chosen.add(k); if (k === 'none') chosen.clear(), chosen.add('none'); else chosen.delete('none'); }
        el.querySelectorAll('[data-k]').forEach((x) => x.setAttribute('aria-pressed', String(chosen.has(x.dataset.k))));
      });
      const finish = (text = '') => {
        if (tourDecision === finish) tourDecision = null;
        draftReply = null; el.remove();
        resolve({ keys: [...chosen].filter((k) => k !== 'none'), text: typeof text === 'string' ? text : '' });
      };
      el.querySelector('[data-done]').onclick = () => finish('');
      tourDecision = finish;
      draftReply = (text) => {    // their own words: map the obvious ones, keep the rest as description
        const t = text.toLowerCase();
        const map = { wheelchair: /wheel ?chair/, walker: /walker|cane|crutch/, stairs: /stair|step/, balance: /balance|fall|dizzy/,
          grip: /grip|arthritis|hands?/, vision: /vision|blind|see\b|sight/, hearing: /hear|deaf/, sensory: /noise|sensory|autis/ };
        for (const [k, re] of Object.entries(map)) if (re.test(t)) chosen.add(k);
        finish(text);
      };
      setCard(el);
    });
  }

  async function start() {
    if (started) return; started = true;
    setRoverState('idle');
    const saved = loadProfile();
    let profile = saved;
    if (!saved) profile = await askNeeds(guessKeys());
    else {
      const names = OPTIONS.filter(([k]) => saved.keys.includes(k)).map(([, l]) => l.toLowerCase());
      const k = await ask('<strong>Welcome back.</strong><p>I’m keeping in mind: ' + esc(names.join(', ') || 'no specific needs') +
        (saved.text ? ' (“' + esc(saved.text) + '”)' : '') + '.</p>', [['ok', 'That’s right'], ['change', 'Change']]);
      if (k === 'change') profile = await askNeeds(saved.keys);
    }
    applyProfile(profile);
    const queued = edits.filter((e) => e.status === 'queued').length;
    setSandraState('Exploring', 'Look around at your own pace.',
      'I’ll point things out as you go. Tell me anything you’d change, or tap ✎ and paint over it. ' +
      (edits.length || queued ? 'Your list is top left. ' : '') + 'When your list is ready, tap Make my changes and I’ll build it and show you around.');
    setTimeout(() => { if (!tourDecision && !making) setCard(null); }, 14000);
    setInterval(notice, 1500);
  }

  // Sandra notices one thing per room, from what the buyer is looking at. She never moves the camera here.
  let noticing = false;
  async function notice() {
    if (noticing || making || agentBusy || tourDecision || mode !== 'walk' || !sdk || !poseCache || poseCache.mode !== 'mode.inside') return;
    if (typeof lastUserMove !== 'undefined' && Date.now() - lastUserMove < 2600) return;
    const room = currentRoom();
    if (!room || seenRooms.has(room.id) || /closet|pantry|garage|utility/i.test(room.label)) return;
    if ($('#guide-task').childElementCount && !$('#guide-task .sandra-task')) return;   // something else is on the card
    seenRooms.add(room.id);
    noticing = true;
    const pose0 = poseCache.sweep;
    try {
      const sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null, { silent: true, whole: true });
      const [objects = []] = await identifyViews([{ image: sel.frame, pose: sel.pose, hits: sel.hits, roomId: sel.roomId }]).catch(() => []);
      const plan = await postEdit('agent/plan', {
        views: [{ image: sel.frame, room: room.label }], inventory: [objects], needs: NEEDS, persona: PERSONA,
        existing: stateForAgent(room.id).concat(edits.filter((e) => e.status === 'queued').map((e) => ({ room: e.room, change: e.title, planned: true }))),
        declined: [...declined], preferences: renovationPreference,
      }).catch(() => null);
      if (!plan || poseCache.sweep !== pose0 || tourDecision || making) { if (poseCache.sweep !== pose0) seenRooms.delete(room.id); return; }
      const f = (plan.findings || []).find((x) => x.fits_needs !== false && !declined.has(keyOf(room.label, x.title)) && !structural(x));
      if (!f) return;
      const rect = isObjectRect(f.box_2d, sel.pose);
      if (!rect) return;
      const loc = { sweep: sel.pose.sweep, rot: sel.pose.rotation, rect: normalizedGuideRect(rect, sel.pose), label: f.item };
      spotlight(loc);
      setRoverState('inspect', room, null, rect);
      const opt = (f.options || [])[Math.min(1, (f.options || []).length - 1)];
      const stop = poseWatch(pose0);
      const k = await ask('<div class="sandra-room-label">' + esc(room.label) + '</div><strong>' + esc(f.title) + '</strong><p>' +
        esc(f.advice || f.issue || f.reason || '') + '</p>' + (opt ? '<p class="sandra-price">About ' + money(opt.total) + ' installed</p>' : ''),
        [['add', 'Add to my list'], ['no', 'No thanks']]);
      stop(); clearSpot();
      if (k === 'add') command({ ...sel, rect }, f.title, f.title, { ...f, guided: true }, objects);
      else if (k === 'no') { declined.add(keyOf(room.label, f.title)); saveDeclined(); }
    } catch (err) { console.warn('notice', err); seenRooms.delete(room.id); }
    finally { noticing = false; }
  }
  function poseWatch(sweep) {   // if they walk away, the suggestion quietly waits for another visit
    const id = setInterval(() => { if (poseCache?.sweep !== sweep && tourDecision) tourDecision('moved'); }, 500);
    return () => clearInterval(id);
  }

  /* ---- build everything on the list, then show it ---- */
  async function makeAll() {
    const list = edits.filter((e) => e.status === 'queued' && e.pending);
    const lost = edits.filter((e) => e.status === 'queued' && !e.pending);
    lost.forEach((e) => removeEdit(e.id, true));          // from before a reload: their photo is gone
    if (!list.length) { say('Your list is empty. Tell me what you’d change first.'); return; }
    making = true; tourDecision?.('stop'); setMode('walk'); closeDrawers(); clearSpot();
    agentBusy = true;
    const box = $('#making'), fill = $('#making-fill'), step = $('#making-step'), ul = $('#making-list');
    const row = (e, st) => `<li data-id="${e.id}"><span class="st">${st}</span><span>${esc(e.title)}</span></li>`;
    ul.innerHTML = list.map((e) => row(e, '○')).join('');
    box.classList.remove('hidden');
    const mark = (e, st) => { const li = ul.querySelector(`[data-id="${e.id}"] .st`); if (li) li.textContent = st; };
    for (const [i, e] of list.entries()) {
      step.textContent = `${i + 1} of ${list.length} · ${e.title}${e.room ? ' · ' + e.room : ''}`;
      fill.style.width = Math.round((i / list.length) * 100 + 4) + '%';
      mark(e, '◐');
      const tick = setInterval(() => { const s = STEPS[e.status]; if (s && e.status !== 'queued') step.textContent = `${i + 1} of ${list.length} · ${s[0]}`; }, 600);
      try {
        setStatus(e, 'rendering');
        await renderAndReview(e, e.pending);
        if (e.status !== 'ready') throw new Error(e.review?.issues?.[0] || 'It didn’t pass the quality check.');
        delete e.pending; mark(e, '✓');
      } catch (err) {
        if (edits.includes(e)) setStatus(e, 'failed', { error: err.message }); mark(e, '✕');
      } finally { clearInterval(tick); }
    }
    fill.style.width = '100%'; step.textContent = 'Done. Let me show you.';
    await sleep(700);
    box.classList.add('hidden');
    making = false;
    await walkthrough(list.filter((e) => e.status === 'ready'), list.filter((e) => e.status === 'failed'));
  }

  function narration(e) {
    const what = e.option ? e.option.name : e.title;
    const why = e.advice ? ' ' + e.advice : '';
    return (e.action === 'remove' ? 'I took out ' + (e.item || 'the old one') + '.' : 'Here’s ' + what + '.') + why;
  }
  // Turn so the change sits in the middle of the view (a little high, above Sandra's card), not where it was drawn.
  function centered(p) {
    const rot = p.rot || poseCache.rotation, r = p.rectN, P = poseCache?.projection;
    if (!r || !P) return rot;
    const hfov = 2 * Math.atan(1 / P[0]) * 180 / Math.PI, vfov = 2 * Math.atan(1 / P[5]) * 180 / Math.PI;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return { x: Math.max(-60, Math.min(30, rot.x - (cy - 0.42) * vfov)), y: rot.y - (cx - 0.5) * hfov };
  }
  async function walkthrough(ready, failed) {
    agentBusy = true;
    document.body.classList.add('sandra-guiding');
    try {
      for (const [i, e] of ready.entries()) {
        if (!edits.includes(e)) continue;
        const p = e.patches.find((x) => !x.extra) || e.patches[0];
        if (!p) continue;
        setView('after');
        setSandraState('Walkthrough', i ? 'Next, the ' + (e.room || 'next room') : 'Come with me', '');
        await walkTo(p.sweep);
        await lookAt(centered(p), 90);
        const r = p.rectN, sx = 0.5 - (r[0] + r[2]) / 2, sy = 0.42 - (r[1] + r[3]) / 2;   // where centering put it
        const loc = { sweep: p.sweep, rot: { ...poseCache.rotation }, rect: [r[0] + sx, r[1] + sy, r[2] + sx, r[3] + sy], label: e.title };
        spotlight(loc); setTimeout(() => { if (spotFor === loc) clearSpot(); }, 2600);
        const W = iframe.clientWidth, Hh = iframe.clientHeight;
        setRoverState('inspect', currentRoom(), null, { x: loc.rect[0] * W, y: loc.rect[1] * Hh, w: (loc.rect[2] - loc.rect[0]) * W, h: (loc.rect[3] - loc.rect[1]) * Hh });
        const last = i === ready.length - 1;
        const k = await ask('<div class="sandra-room-label">' + esc(e.room || 'Your change') + ' · ' + (i + 1) + ' of ' + ready.length + '</div>' +
          '<strong>' + esc(e.title) + '</strong><p>' + esc(narration(e)) + '</p>' +
          (e.cost ? '<p class="sandra-price">' + money(e.cost) + ' installed' + (e.option ? ' · item ' + money(e.option.material) + ' + labor ' + money(e.option.labor) : '') + '</p>' : '') +
          '<p>Hold <b>B</b> to see it as it is today.</p>',
          [['next', last ? 'Finish' : 'Next'], ['undo', 'Remove this'], ['stop', 'I’ll look around']]);
        clearSpot();
        if (k === 'undo') removeEdit(e.id);
        if (k === 'stop') break;
      }
    } finally { agentBusy = false; document.body.classList.remove('sandra-guiding'); setRoverState('idle'); }
    const kept = edits.filter((e) => e.status === 'ready' && e.on !== false);
    const total = kept.reduce((s, e) => s + (e.cost || 0), 0);
    let html = '<strong>That’s the tour of your changes.</strong><p>' + kept.length + ' change' + (kept.length === 1 ? '' : 's') +
      ', about ' + money(total) + ' installed. All in: ' + (H.rent ? money(H.price) + '/mo + ' + money(total) : money(H.price + total)) + '.</p>';
    if (failed.length) html += '<p>I couldn’t get ' + failed.map((e) => '“' + esc(e.title) + '”').join(', ') + ' looking right yet.</p>';
    const buttons = [['list', 'See my list'], ['done', 'Keep exploring']];
    if (failed.some((e) => e.pending)) buttons.unshift(['retry', 'Try those again']);
    const k = await ask(html, buttons);
    if (k === 'retry') { failed.forEach((e) => { if (e.pending && edits.includes(e)) setStatus(e, 'queued'); }); makeAll(); }
    if (k === 'list') document.querySelector('[data-drawer="changes"]')?.click();
  }

  $('#make-btn').onclick = makeAll;
  document.querySelector('[data-needs]').onclick = async () => applyProfile(await askNeeds(loadProfile()?.keys || []));
  document.getElementById('more-btn').onclick = (e) => {
    const m = document.getElementById('more-menu'); m.classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', String(!m.classList.contains('hidden')));
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#more-btn, #more-menu')) document.getElementById('more-menu').classList.add('hidden'); });
  document.querySelectorAll('#more-menu button').forEach((b) => b.addEventListener('click', () => document.getElementById('more-menu').classList.add('hidden')));

  window.sandraFlow = {
    start, makeAll,
    async onMessage(msg) {
      if (/^(make|build|do) (my|the|all)? ?(changes|list|it)|^go ahead|^make them/i.test(msg) && edits.some((e) => e.status === 'queued')) { makeAll(); return true; }
      if (/^(change|update) (my )?needs|who.*(live|for)/i.test(msg)) { applyProfile(await askNeeds(loadProfile()?.keys || [])); return true; }
      return false;
    },
  };
})();
