/* In-app issue reporter: screenshot -> draw highlights -> describe -> saved to logs/feedback/ with app state. */
(() => {
  const errors = [], calls = [];
  const push = (arr, x, max = 40) => { arr.push(x); if (arr.length > max) arr.shift(); };
  window.addEventListener('error', (e) => push(errors, { t: Date.now(), msg: e.message, src: `${e.filename}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => push(errors, { t: Date.now(), msg: String(e.reason?.message || e.reason) }));
  const ce = console.error.bind(console);
  console.error = (...a) => { push(errors, { t: Date.now(), msg: a.map(String).join(' ').slice(0, 500) }); ce(...a); };
  const of = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const t0 = Date.now();
    try {
      const r = await of(url, opts);
      if (!String(url).includes('/render/')) push(calls, { url: String(url).slice(0, 160), method: opts?.method || 'GET', status: r.status, ms: Date.now() - t0 });
      return r;
    } catch (err) { push(calls, { url: String(url).slice(0, 160), error: String(err), ms: Date.now() - t0 }); throw err; }
  };

  const btn = document.createElement('button');
  btn.className = 'flex items-center gap-2 border border-slate-300 text-slate-700 text-sm font-semibold rounded-full pl-3 pr-4 py-1.5 hover:border-red-400 hover:text-red-600';
  btn.innerHTML = '<span aria-hidden="true">⚑</span> Report issue';
  btn.title = 'Screenshot this, mark what is wrong, and log it';
  document.addEventListener('DOMContentLoaded', () => (document.getElementById('report-slot') || document.body).appendChild(btn));

  async function capture() {
    if (window.FD_SHOT) { try { return await window.FD_SHOT(); } catch {} }
    if (!window.html2canvas) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const c = await window.html2canvas(document.body, { useCORS: true, scale: 1, windowWidth: innerWidth, windowHeight: innerHeight, x: scrollX, y: scrollY, width: innerWidth, height: innerHeight });
    return c.toDataURL('image/png');
  }

  btn.onclick = async () => {
    btn.disabled = true; btn.lastChild.textContent = ' Capturing…';
    let shot; try { shot = await capture(); } catch { shot = null; }
    btn.disabled = false; btn.lastChild.textContent = ' Report issue';
    open(shot);
  };

  function open(shot) {
    const m = document.createElement('div');
    m.className = 'fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4';
    m.innerHTML = `<div class="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] flex flex-col overflow-hidden">
      <div class="px-5 py-3 border-b flex items-center gap-3"><div class="font-semibold">Report an issue</div>
        <div class="text-sm text-slate-500">Drag on the picture to circle what's wrong.</div>
        <div class="ml-auto flex gap-1 text-sm"><button data-tool="box" class="px-2.5 py-1 rounded-lg bg-slate-900 text-white">▢ Box</button>
          <button data-tool="pen" class="px-2.5 py-1 rounded-lg">✎ Pen</button><button data-undo class="px-2.5 py-1 rounded-lg">↶ Undo</button></div></div>
      <div class="flex-1 min-h-0 overflow-auto bg-slate-100 grid place-items-center p-3">${shot ? '<canvas class="max-w-full shadow cursor-crosshair rounded-lg"></canvas>' : '<p class="text-slate-500 p-10">Screenshot unavailable; describe the issue below.</p>'}</div>
      <div class="p-4 border-t flex gap-3 items-end">
        <textarea rows="2" class="flex-1 border rounded-xl px-3 py-2 outline-none focus:border-brand-500" placeholder="What went wrong? What did you expect?"></textarea>
        <button data-cancel class="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100">Cancel</button>
        <button data-send class="px-4 py-2 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700">Save report</button></div></div>`;
    document.body.appendChild(m);
    const ta = m.querySelector('textarea'); ta.focus();
    const close = () => m.remove();
    m.querySelector('[data-cancel]').onclick = close;
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const marks = []; let tool = 'box', cv = m.querySelector('canvas'), img = null;
    const redraw = () => {
      const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
      ctx.lineWidth = Math.max(3, cv.width / 300); ctx.strokeStyle = '#ef4444'; ctx.lineJoin = ctx.lineCap = 'round';
      for (const mk of marks) {
        ctx.beginPath();
        if (mk.type === 'box') { ctx.fillStyle = 'rgba(239,68,68,.12)'; ctx.rect(mk.x, mk.y, mk.w, mk.h); ctx.fill(); }
        else mk.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.stroke();
      }
    };
    if (cv) {
      img = new Image(); img.onload = () => { cv.width = img.naturalWidth; cv.height = img.naturalHeight; redraw(); }; img.src = shot;
      const pt = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
      let cur = null;
      cv.onpointerdown = (e) => { const [x, y] = pt(e); cur = tool === 'box' ? { type: 'box', x, y, w: 0, h: 0 } : { type: 'pen', pts: [[x, y]] }; marks.push(cur); cv.setPointerCapture(e.pointerId); };
      cv.onpointermove = (e) => { if (!cur) return; const [x, y] = pt(e); if (cur.type === 'box') { cur.w = x - cur.x; cur.h = y - cur.y; } else cur.pts.push([x, y]); redraw(); };
      cv.onpointerup = () => { cur = null; };
      m.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
        tool = b.dataset.tool; m.querySelectorAll('[data-tool]').forEach((x) => x.className = 'px-2.5 py-1 rounded-lg' + (x === b ? ' bg-slate-900 text-white' : ''));
      });
      m.querySelector('[data-undo]').onclick = () => { marks.pop(); redraw(); };
    }
    m.querySelector('[data-send]').onclick = async (ev) => {
      ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Saving…';
      let context = { errors, calls, viewport: [innerWidth, innerHeight], ua: navigator.userAgent };
      try { Object.assign(context, (await window.FD_CONTEXT?.()) || {}); } catch (err) { context.contextError = String(err); }
      const body = { url: location.href, page: location.pathname, note: ta.value, marks: marks.length, context,
        image: cv ? cv.toDataURL('image/png') : null, raw: shot };
      const r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({}));
      m.querySelector('.p-4').innerHTML = r.ok ? `<div class="text-emerald-700 font-medium">Saved as <code>logs/feedback/${r.id}</code>. Thanks!</div>` : '<div class="text-red-600">Could not save the report.</div>';
      setTimeout(close, 1600);
    };
  }
})();
