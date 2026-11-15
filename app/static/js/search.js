const $ = (selector) => document.querySelector(selector);
const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString();
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rent = new URLSearchParams(location.search).get('rent') === '1';
let state = { filters: null, results: [], labels: {} };
let markRequired = false;
let requestVersion = 0;

function chip(key, label, selected, required) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-btn';
  b.dataset.need = key;
  b.dataset.required = String(required);
  b.setAttribute('aria-pressed', String(selected));
  b.textContent = label + (required ? ' · Must have' : '');
  b.onclick = () => {
    const f = state.filters;
    const needs = new Set(f.needs), hard = new Set(f.required);
    if (markRequired) {
      if (hard.has(key)) hard.delete(key);
      else { hard.add(key); needs.add(key); }
    } else if (needs.has(key)) { needs.delete(key); hard.delete(key); }
    else needs.add(key);
    run('', { ...f, needs: [...needs], required: [...hard] });
  };
  return b;
}
function renderChips() {
  const box = $('#chips');
  const f = state.filters;
  box.replaceChildren(...Object.entries(state.labels).map(([k, label]) => chip(k, label, f.needs.includes(k), f.required.includes(k))));
}
function card(h) {
  const unconfirmed = h.required_unconfirmed || [];
  const pending = unconfirmed.length > 0;
  const hard = (state.filters.required || []).length;
  const supported = state.filters.needs.filter((n) => h.evidence[n]?.status === 'yes' && !state.filters.required.includes(n));
  const evidence = pending ? unconfirmed.map((n) => state.labels[n]).join(', ') + ' · confirm in the scan' :
    hard ? 'Must-haves supported by listing' : '';
  const priced = h.mods.length ? 'Estimated changes ' + money(h.mod_total) : '';
  const photos = /^https?:\/\//i.test(h.photo || '') ? '<img src="' + safe(h.photo) + '" alt="" loading="lazy" class="w-full h-full object-cover">' : '';
  const params = new URLSearchParams({ needs: state.filters.needs.join(','), required: state.filters.required.join(',') });
  return '<a href="/home/' + h.id + '?' + params.toString() + '" class="home-card group block bg-white rounded-xl overflow-hidden">' +
    '<div class="relative aspect-[4/3] bg-slate-100 overflow-hidden">' + photos +
    '<span class="absolute left-3 bottom-3 inline-flex items-center gap-1 bg-ink/80 text-white text-xs font-semibold px-2.5 py-1.5 rounded-md">3D tour with Sandra</span></div>' +
    '<div class="p-4"><div class="text-2xl font-bold tracking-tight">' + money(h.price) + (h.rent ? '<span class="text-sm text-slate-500"> / mo</span>' : '') +
    '</div><div class="text-base font-semibold">' + safe(h.address) + '</div><div class="text-sm text-slate-500">' +
    safe(h.city + ', ' + h.state) + ' · ' + (h.beds ?? '–') + ' bd · ' + (h.baths ?? '–') + ' ba</div>' +
    (evidence ? '<p class="match-evidence' + (pending ? ' pending' : '') + '">' + safe(evidence) + '</p>' : '') +
    (supported.length ? '<p class="text-xs text-slate-500 mt-2">' + safe(supported.slice(0, 3).map((n) => state.labels[n]).join(' · ')) + '</p>' : '') +
    '<div class="card-meter"><span>' + (priced || (state.filters.needs.length ? 'Listing evidence' : 'Open tour')) +
    '</span><strong>' + (state.filters.needs.length ? h.match + '% fit' : '↗') + '</strong></div></div></a>';
}

function renderGrid() {
  const sort = $('#sort').value;
  const results = [...state.results];
  const unresolved = (h) => (h.required_unconfirmed || []).length;
  if (sort === 'true') results.sort((a, b) => unresolved(a) - unresolved(b) || a.true_cost - b.true_cost);
  if (sort === 'mods') results.sort((a, b) => unresolved(a) - unresolved(b) || a.mod_total - b.mod_total || b.match - a.match);
  $('#grid').innerHTML = results.map(card).join('') ||
    '<p class="text-slate-500">No listings fit these filters. Try a wider search area, a different budget, or a different must-have.</p>';
  const hero = results.find((x) => /^https?:\/\//i.test(x.photo || ''));
  if (hero) {
    const img = $('#hero-img');
    if (img.getAttribute('src') !== hero.photo) {
      const candidate = new Image();
      candidate.onload = () => { if (state.results.includes(hero)) img.src = hero.photo; };
      candidate.src = hero.photo;
    }
  }
}

async function run(q, filters) {
  const version = ++requestVersion;
  $('#persona').textContent = q ? 'Sandra is checking your must-haves…' : '';
  $('#grid').setAttribute('aria-busy', 'true');
  try {
    const body = filters ? { filters } : { q, rent };
    const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Search failed');
    const data = await response.json();
    if (version !== requestVersion) return;
    state = { filters: data.filters, results: data.results, labels: data.need_labels };
    try {
      sessionStorage.setItem('fd-persona', data.filters.persona || '');
      sessionStorage.setItem('fd-budget', data.filters.max_price || '');
      if (q) sessionStorage.setItem('fd-search-query', q);
    } catch {}
    $('#persona').textContent = q ? data.filters.summary || '' : '';
    const labels = data.filters.required.map((n) => data.need_labels[n]);
    $('#result-sub').textContent = data.count.toLocaleString() + ' homes with 3D tours' +
      (labels.length ? ' · Must-haves: ' + labels.join(', ') : '');
    renderChips();
    renderGrid();
  } catch (err) {
    if (version === requestVersion) $('#persona').textContent = 'Sandra could not load the search. Try again.';
  } finally {
    if (version === requestVersion) $('#grid').removeAttribute('aria-busy');
  }
}
const query = $('#q');
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); run(query.value.trim()); });
query.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(query.value.trim()); }
});
$('#sort').addEventListener('change', renderGrid);
$('#required-mode').onclick = (e) => {
  markRequired = !markRequired;
  e.currentTarget.setAttribute('aria-pressed', String(markRequired));
  e.currentTarget.textContent = markRequired ? 'Done marking must-haves' : 'Mark must-haves';
  if (markRequired) $('#persona').textContent = 'Choose any access preference the home must already have.';
};
document.querySelectorAll('[data-example]').forEach((b) => { b.onclick = () => { query.value = b.dataset.example; query.focus(); }; });
try {
  if (performance.getEntriesByType('navigation')[0]?.type === 'back_forward') query.value = sessionStorage.getItem('fd-search-query') || '';
} catch {}
if (query.value.trim()) run(query.value.trim());
else run('', { needs: [], required: [], rent: rent ? true : null });
