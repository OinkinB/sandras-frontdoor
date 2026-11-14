const $ = (s) => document.querySelector(s);
const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString();
const NEED_ICONS = {
  no_stairs: '⌂', step_free_entry: '↦', wide_doorways: '⇔', walk_in_shower: '◌',
  grab_bars: '═', first_floor_bedroom: '▭', smooth_flooring: '▤', garage: '▣'
};
let state = { filters: null, results: [], labels: {} };

function chip(key, label, on) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip-btn'; b.dataset.need = key;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.innerHTML = `<span aria-hidden="true">${NEED_ICONS[key] || '•'}</span>${label}`;
  b.onclick = () => {
    const f = state.filters; if (!f) return;
    const set = new Set(f.needs);
    set.has(key) ? set.delete(key) : set.add(key);
    f.needs = [...set];
    run(null, f);
  };
  return b;
}

function renderChips() {
  const box = $('#chips'); box.innerHTML = '';
  const f = state.filters;
  Object.entries(state.labels).forEach(([k, l]) => box.appendChild(chip(k, l, f.needs.includes(k))));
  if (f.max_price) box.insertAdjacentHTML('beforeend', `<span class="chip-btn" aria-pressed="true">Under ${money(f.max_price)}</span>`);
  if (f.city) box.insertAdjacentHTML('beforeend', `<span class="chip-btn" aria-pressed="true">${f.city}</span>`);
}

function card(h) {
  const tone = h.match >= 85 ? 'bg-emerald-50 text-emerald-700' : h.match >= 65 ? 'bg-sky-50 text-sky-700' : 'bg-amber-50 text-amber-700';
  const word = h.match >= 85 ? 'High accessibility match' : h.match >= 65 ? 'Accessibility match' : 'Needs changes';
  const mods = h.mods.length
    ? `<div class="mt-2 text-[13px] text-slate-600">+ ${money(h.mod_total)} est. changes · <span class="font-semibold text-ink">True cost ${money(h.true_cost)}</span></div>
       <div class="mt-1 text-[12px] text-slate-500 truncate">${h.mods.map(m => m.label).join(' · ')}</div>`
    : `<div class="mt-2 text-[13px] text-emerald-700 font-medium">Ready as listed: no changes needed for your needs</div>`;
  const yes = state.filters.needs.filter(n => h.evidence[n]?.status === 'yes').map(n => state.labels[n]);
  const per = h.rent ? '/mo' : '';
  return `<a href="/home/${h.id}?needs=${state.filters.needs.join(',')}" class="group block bg-white rounded-2xl shadow-card overflow-hidden hover:-translate-y-0.5 hover:shadow-lg transition">
    <div class="relative aspect-[4/3] bg-slate-100 overflow-hidden">
      ${h.photo ? `<img src="${h.photo}" alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-[1.03] transition duration-500">` : ''}
      <span class="absolute left-3 bottom-3 inline-flex items-center gap-1.5 bg-ink/80 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg backdrop-blur">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>3D Tour</span>
      ${h.stories === 1 ? '<span class="absolute right-3 top-3 bg-white/95 text-xs font-semibold px-2 py-1 rounded-lg">Single-level</span>' : ''}
    </div>
    <div class="p-4">
      <div class="text-2xl font-bold tracking-tight">${money(h.price)}<span class="text-base font-medium text-slate-500">${per}</span></div>
      <div class="mt-0.5 text-sm text-slate-600">${h.beds ?? '–'} bd · ${h.baths ?? '–'} ba · ${h.sqft ? h.sqft.toLocaleString() + ' sq ft' : '—'}</div>
      <div class="text-sm text-slate-500 truncate">${h.address}, ${h.city}, ${h.state}${h.neighborhood ? ' · ' + h.neighborhood : ''}</div>
      ${mods}
      ${yes.length ? `<div class="mt-2 flex flex-wrap gap-1">${yes.slice(0, 3).map(y => `<span class="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md">✓ ${y}</span>`).join('')}</div>` : ''}
      <div class="mt-3 flex items-center justify-between rounded-xl px-3 py-2 ${tone}">
        <span class="text-[13px] font-semibold flex items-center gap-1.5">♿ ${word}</span><span class="font-bold">${h.match}%</span>
      </div>
    </div></a>`;
}

function renderGrid() {
  const sort = $('#sort').value;
  const r = [...state.results];
  if (sort === 'true') r.sort((a, b) => a.true_cost - b.true_cost);
  if (sort === 'mods') r.sort((a, b) => a.mod_total - b.mod_total || b.match - a.match);
  $('#grid').innerHTML = r.map(card).join('') || '<p class="text-slate-500">No homes match. Try removing a filter.</p>';
  const hero = r.find(x => x.photo);
  if (hero) { const img = $('#hero-img'); img.onload = () => img.classList.remove('opacity-0'); img.src = hero.photo; }
}

function skeleton() {
  $('#grid').innerHTML = Array.from({ length: 8 }, () =>
    `<div class="bg-white rounded-2xl shadow-card overflow-hidden animate-pulse"><div class="aspect-[4/3] bg-slate-200"></div><div class="p-4 space-y-2"><div class="h-6 bg-slate-200 rounded w-1/2"></div><div class="h-4 bg-slate-100 rounded"></div><div class="h-9 bg-slate-100 rounded-xl"></div></div></div>`).join('');
}

async function run(q, filters) {
  skeleton();
  $('#persona').innerHTML = q ? 'AI agent is reading your request<span class="dots"><span>.</span><span>.</span><span>.</span></span>' : '';
  const res = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filters ? { filters } : { q }) });
  const d = await res.json();
  state = { filters: d.filters, results: d.results, labels: d.need_labels };
  $('#persona').textContent = d.filters.persona ? `Searching for: ${d.filters.summary || ''}` : '';
  $('#result-sub').textContent = `${d.count.toLocaleString()} homes with 3D tours checked · ranked by accessibility match and true cost (price + estimated modifications).`;
  renderChips(); renderGrid();
}

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); run($('#q').value.trim()); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run($('#q').value.trim()); } });
$('#sort').addEventListener('change', renderGrid);
run($('#q').value.trim());
