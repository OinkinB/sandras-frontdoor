/* Optional profile, manual edit queue, and handoff to the prepared walkthrough. */
(function () {
  const PROFILE_KEY = 'fd-profile';
  const OPTIONS = [
    ['wheelchair', 'Uses a wheelchair', ['no_stairs', 'step_free_entry', 'wide_doorways', 'roll_in_shower', 'smooth_flooring'], 'uses a wheelchair'],
    ['walker', 'Walker or cane', ['step_free_entry', 'grab_bars', 'walk_in_shower'], 'walks with a walker or cane (does not use a wheelchair)'],
    ['stairs', 'Stairs are hard', ['no_stairs', 'first_floor_bedroom'], 'finds stairs hard'],
    ['balance', 'Balance or falls', ['grab_bars', 'walk_in_shower'], 'is careful about balance and falls'],
    ['grip', 'Weak grip / arthritis', ['lever_handles'], 'has a weak grip (arthritis)'],
    ['vision', 'Low vision', ['even_lighting'], 'has low vision'],
    ['hearing', 'Hard of hearing', ['visual_alerts'], 'is hard of hearing'],
    ['sensory', 'Sensitive to noise', ['quiet_space'], 'is sensitive to noise'],
    ['none', 'Just looking', [], ''],
  ];
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
    if (typeof info !== 'undefined' && info) loadAccess();
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
        if (text === 'stop' || text === 'moved') { resolve(null); return; }   // dismissed: keep the current needs
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
    if (started) return;
    started = true;
    // Search already captured the buyer's needs. An explicitly saved profile is available for a direct visit.
    const saved = loadProfile();
    if (!NEEDS.length && saved?.keys?.length) applyProfile(saved);
    await window.sandraShowcase.boot();
  }

  /* ---- build everything on the list, then show it ---- */
  async function makeAll() {
    if (making || agentBusy) return;
    const release = window.sandraShowcase?.takeControl();
    const list = edits.filter((e) => e.status === 'queued' && e.pending);
    const lost = edits.filter((e) => e.status === 'queued' && !e.pending);
    lost.forEach((e) => removeEdit(e.id, true));          // from before a reload: their photo is gone
    if (!list.length) { say('Your list is empty. Tell me what you’d change first.'); return; }
    making = true; tourDecision?.('stop'); setMode('walk'); closeDrawers(); clearSpot();
    agentBusy = true;
    await release;
    const box = $('#making'), fill = $('#making-fill'), step = $('#making-step'), ul = $('#making-list');
    const row = (e, st) => `<li data-id="${e.id}"><span class="st">${st}</span><span>${esc(e.title)}</span></li>`;
    ul.innerHTML = list.map((e) => row(e, '○')).join('');
    box.classList.remove('hidden');
    setCard(null);          // the 'Added…' note is done; the build screen and walkthrough take over
    const mark = (e, st) => { const li = ul.querySelector(`[data-id="${e.id}"] .st`); if (li) li.textContent = st; };
    for (const [i, e] of list.entries()) {
      step.textContent = `${i + 1} of ${list.length} · ${e.title}${e.room ? ' · ' + e.room : ''}`;
      fill.style.width = Math.round((i / list.length) * 100 + 4) + '%';
      mark(e, '◐');
      const tick = setInterval(() => { const s = STEPS[e.status]; if (s && e.status !== 'queued') step.textContent = `${i + 1} of ${list.length} · ${s[0]}`; }, 600);
      try {
        step.textContent = `${i + 1} of ${list.length} · Looking at the whole ${e.item || 'area'}`;
        e.pending = await reframe(e).catch((err) => { console.warn('reframe', err); return e.pending; });
        setStatus(e, 'rendering');
        await renderAndReview(e, e.pending);
        if (e.status !== 'ready') throw new Error(e.review?.issues?.[0] || 'It didn’t pass the quality check.');
        if (e.replaces) removeEdit(e.replaces, true);
        delete e.replaces; delete e.pending; mark(e, '✓');
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

  /* Before building a change, look at it properly: what the buyer painted is only a hint. Go to that spot, turn so
     the whole fixture is in view, and have the agent find everything the change touches in that fresh view. */
  async function reframe(e) {
    const src = e.pending;
    if (!src?.pose || !e.world?.center) return src;
    const r = src.targetRect || src.rect, W = src.pose.W, Hh = src.pose.H, m = 0.07;
    const clipped = !r || r.x < m * W || r.y < m * Hh || r.x + r.w > (1 - m) * W || r.y + r.h > (1 - m) * Hh;
    const cramped = r && (r.w > 0.8 * W || r.h > 0.8 * Hh);
    if (!clipped && !cramped) return src;          // already framed with room around it
    await walkTo(src.pose.sweep);
    const c = e.world.center, p = poseCache.position;
    const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
    await lookAt({ x: Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI, y: Math.atan2(-dx, -dz) * 180 / Math.PI }, 140);
    await sleep(700);
    const sel = await makeSelection({ x: 0, y: 0, w: iframe.clientWidth, h: iframe.clientHeight }, null, { silent: true, whole: true });
    const { finding, objects } = await planSelection(sel, 'Change: ' + e.title + (e.custom ? ' (' + e.custom + ')' : '') +
      '. Find the ' + (e.item || 'fixture') + ' this applies to. box_2d must enclose everything the change touches: the whole ' +
      'fixture and its surround from the floor to its top edge, trim, and the floor right in front of it.');
    if (!finding) return src;
    const t = editTarget(sel, finding, e.title, objects);
    if (!t?.source?.rect) return src;
    e.world = t.world || e.world;
    return t.source;
  }

  async function walkthrough(ready, failed) {
    agentBusy = false;
    if (ready.length) await window.sandraShowcase.playSaved(ready);
    if (failed.length) say('<strong>Some changes need another pass</strong><p>' +
      failed.map((e) => esc(e.title)).join(', ') + '.</p>');
  }

  $('#make-btn').onclick = makeAll;
  // Start from what Sandra already knows (saved answer, else the search), never from a blank slate.
  const currentKeys = () => loadProfile()?.keys?.length ? loadProfile().keys :
    OPTIONS.filter(([k, , n]) => k !== 'none' && n.length && n.every((x) => NEEDS.includes(x))).map(([k]) => k);
  async function changeNeeds() { const p = await askNeeds(currentKeys()); if (p) applyProfile(p); }
  document.querySelector('[data-needs]').onclick = changeNeeds;
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
      if (/^(change|update) (my )?needs|who.*(live|for)/i.test(msg)) { await changeNeeds(); return true; }
      return false;
    },
  };
})();
