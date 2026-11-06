const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const DAY = 864e5, WIN = 28;
let S = null, tab = 'calendar', filter = 'all', calStart = null, lastJson = '';
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addD = (d, n) => iso(Date.parse(d + 'T00:00:00Z') + n * DAY);
const short = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const TABS = [['calendar', 'Calendar'], ['bookings', 'Bookings'], ['properties', 'Properties'], ['connect', 'Connect Claude']];

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
function toast(msg, bad) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}
async function load(force) {
  const s = await api('/state'); const j = JSON.stringify(s);
  if (!force && j === lastJson) return; lastJson = j; S = s;
  calStart ||= s.today; $('#ws').textContent = s.workspace.name; render();
}
function render() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-t="${k}">${l}</button>`).join('');
  $('#view').innerHTML = { calendar, bookings, properties, connect }[tab]();
}
$('#tabs').addEventListener('click', (e) => { const t = e.target.dataset.t; if (t) { tab = t; render(); } });

// ---------- calendar ----------
function calendar() {
  const days = Array.from({ length: WIN }, (_, i) => addD(calStart, i)), end = addD(calStart, WIN);
  const live = S.bookings.filter((b) => ['hold', 'confirmed'].includes(b.status));
  const head = days.map((d) => { const dt = new Date(d + 'T00:00:00Z'), w = dt.getUTCDay();
    return `<th class="${w === 5 || w === 6 ? 'we' : ''} ${d === S.today ? 'today' : ''}">${dt.getUTCDate() === 1 || d === calStart ? short(d).split(' ')[1] : '&nbsp;'}<b>${dt.getUTCDate()}</b>${'SMTWTFS'[w]}</th>`; }).join('');
  let rows = '';
  if (!S.properties.length) return `<div class="empty-state">No properties yet. Add one in Properties, or ask Claude to add it.</div>`;
  for (const p of S.properties) {
    rows += `<tr class="prop"><th colspan="${WIN + 1}">${esc(p.name)}${p.location ? ' · ' + esc(p.location) : ''}</th></tr>`;
    for (const u of p.units) {
      let cells = '', i = 0;
      while (i < WIN) {
        const d = days[i], b = live.find((x) => x.unit_id === u.id && x.check_in <= d && x.check_out > d), w = new Date(d + 'T00:00:00Z').getUTCDay();
        if (b) { const span = Math.min(WIN - i, (Date.parse(b.check_out) - Date.parse(d)) / DAY);
          cells += `<td class="bk ${b.status}" colspan="${span}" data-b="${b.id}" title="${esc(b.guest_name)}">${esc(b.guest_name)}</td>`; i += span; }
        else { cells += `<td class="empty ${w === 5 || w === 6 ? 'we' : ''} ${d === S.today ? 'today' : ''}" data-u="${u.id}" data-d="${d}"></td>`; i++; }
      }
      rows += `<tr><th class="name">${esc(u.name)}<small>sleeps ${u.capacity}</small></th>${cells}</tr>`;
    }
  }
  return `<div class="bar"><button class="btn small" data-nav="-14">‹ Earlier</button><button class="btn small" data-nav="0">Today</button><button class="btn small" data-nav="14">Later ›</button>
    <span class="muted">${short(calStart)} to ${short(addD(end, -1))}</span><span class="sp"></span><span class="legend"><span class="c">Confirmed</span><span class="h">Hold</span></span>
    <button class="btn primary small" data-new>New booking</button></div><div class="cal"><table><thead><tr><th class="name"></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">Tap an empty day to start a booking, or a bar to edit it. Holds that pass their timer free the dates on their own.</p>`;
}

// ---------- bookings ----------
function bookings() {
  const list = S.bookings.filter((b) => filter === 'all' || (filter === 'closed' ? ['cancelled', 'expired'].includes(b.status) : b.status === filter));
  const opts = [['all', 'All'], ['hold', 'Holds'], ['confirmed', 'Confirmed'], ['closed', 'Cancelled or expired']];
  return `<div class="bar"><select id="flt" style="width:auto">${opts.map(([k, l]) => `<option value="${k}" ${filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="sp"></span><button class="btn primary small" data-new>New booking</button></div>
  ${list.length ? `<div class="list">${list.map((b) => `<button class="row" data-b="${b.id}"><span class="t">${esc(b.guest_name)} <span class="chip ${b.status}">${b.status}</span>${b.source === 'claude' ? '<span class="via">via Claude</span>' : ''}</span><span class="r">${inr(b.total)}</span>
    <span class="s">${esc(b.property)}, ${esc(b.unit)} · ${short(b.check_in)} to ${short(b.check_out)} · ${b.guests} guests</span><span class="s" style="text-align:right">${b.status === 'hold' ? 'holds until ' + new Date(b.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '#' + b.id}</span></button>`).join('')}</div>`
    : '<div class="empty-state">Nothing here yet. Ask Claude to hold dates for a guest and it will show up within seconds.</div>'}`;
}
document.addEventListener('change', (e) => { if (e.target.id === 'flt') { filter = e.target.value; render(); } });

// ---------- properties ----------
function properties() {
  return `${S.properties.map((p) => `<div class="prop"><h3>${esc(p.name)}</h3><div class="muted">${esc(p.location)}${p.description ? ' · ' + esc(p.description) : ''}</div>
    ${p.units.map((u) => `<form class="unit" data-unit="${u.id}"><label>Unit<input name="name" value="${esc(u.name)}"></label><label>Sleeps<input name="capacity" type="number" min="1" value="${u.capacity}"></label>
    <label>Weekday ₹<input name="price" type="number" min="1" value="${u.price}"></label><label>Fri/Sat ₹<input name="weekend_price" type="number" min="0" value="${u.weekend_price || ''}"></label><button class="btn small">Save</button></form>`).join('')}
    <form class="unit" data-addunit="${p.id}"><label>New unit<input name="name" placeholder="Garden Room" required></label><label>Sleeps<input name="capacity" type="number" min="1" required></label>
    <label>Weekday ₹<input name="price" type="number" min="1" required></label><label>Fri/Sat ₹<input name="weekend_price" type="number" min="0"></label><button class="btn small">Add unit</button></form></div>`).join('')}
  <div class="prop"><h3>Add a property</h3><form id="addprop"><div class="g2"><label>Name<input name="name" required></label><label>Location<input name="location" required></label></div>
  <label>Description<input name="description" placeholder="What a guest should know"></label><div class="g2"><label>First unit<input name="uname" required placeholder="Main Villa"></label><label>Sleeps<input name="capacity" type="number" min="1" required></label>
  <label>Weekday ₹<input name="price" type="number" min="1" required></label><label>Fri/Sat ₹<input name="weekend_price" type="number" min="0"></label></div><button class="btn primary">Add property</button></form></div>`;
}

// ---------- connect ----------
function connect() {
  const w = S.workspace;
  return `<div class="prop"><h3>Connect your Claude</h3><p class="muted">Claude does the thinking and writing on your own plan. StayDesk has no AI and no AI keys.</p>
  <label>Your StayDesk link<div class="code"><input id="mcp" readonly value="${esc(w.mcp_url)}"><button class="btn" data-copy="#mcp">Copy</button></div></label>
  <ol class="steps"><li>In Claude, open Settings, then Connectors, then Add custom connector.</li><li>Name it StayDesk and paste the link above. Leave any OAuth fields empty.</li><li>Start a chat and enable StayDesk from the tools menu.</li></ol>
  <p><b>Try these</b></p><div class="prompts"><div>What's free in Coorg from 26 to 29 December for 6 people?</div><div>Hold the cheapest option for Priya, 98450 12345, for 48 hours and write her a quote.</div>
  <div>Add a new property, Cedar Nest in Wayanad, two cottages that sleep 4 at ₹6,500 a night.</div><div>Write me a sales summary for this month.</div></div>
  <p class="muted">Anyone with this link can act on your bookings. If it leaks, <button class="btn small danger" data-rotate>generate a new link</button></p></div>
  <div class="prop"><h3>Guest page settings</h3><form id="wsform"><div class="g2"><label>Business name<input name="name" value="${esc(w.name)}"></label>
  <label>WhatsApp number for guests<input name="whatsapp" value="${esc(w.whatsapp)}" placeholder="919876543210"></label></div><button class="btn small">Save</button></form></div>`;
}

// ---------- booking dialog ----------
function openBooking(id, pre = {}) {
  const b = id ? S.bookings.find((x) => x.id === id) : null, units = S.properties.flatMap((p) => p.units.map((u) => ({ ...u, label: `${p.name}: ${u.name}` })));
  if (!units.length) return toast('Add a property first', true);
  const v = b || { unit_id: pre.unit_id || units[0].id, check_in: pre.check_in || S.today, check_out: addD(pre.check_in || S.today, 2), guests: 2, guest_name: '', guest_phone: '', total: '', quote_message: '', notes: '', status: 'new' };
  const link = b ? `${location.origin}/q/${b.token}` : '';
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" id="bf"><div class="bar"><h2>${b ? `Booking #${b.id}` : 'New booking'}</h2>${b ? `<span class="chip ${b.status}">${b.status}</span>` : ''}<span class="sp"></span><button class="btn small" value="x" formnovalidate>Close</button></div>
  <label>Unit<select name="unit_id">${units.map((u) => `<option value="${u.id}" ${u.id === v.unit_id ? 'selected' : ''}>${esc(u.label)} (sleeps ${u.capacity})</option>`).join('')}</select></label>
  <div class="g2"><label>Check in<input type="date" name="check_in" value="${v.check_in}" required></label><label>Check out<input type="date" name="check_out" value="${v.check_out}" required></label>
  <label>Guest name<input name="guest_name" value="${esc(v.guest_name)}" required></label><label>Guest phone<input name="guest_phone" value="${esc(v.guest_phone)}" placeholder="919876543210"></label>
  <label>Guests<input type="number" min="1" name="guests" value="${v.guests}"></label><label>Total ₹ ${b ? '' : '(blank = auto)'}<input type="number" name="total" value="${v.total}"></label></div>
  <label>Message to guest<textarea name="quote_message" rows="5">${esc(v.quote_message)}</textarea></label><label>Internal notes<input name="notes" value="${esc(v.notes)}"></label>
  <p class="err" id="derr"></p><div class="acts"><button class="btn primary" data-act="save">${b ? 'Save changes' : 'Create hold'}</button>
  ${!b ? '<button class="btn" data-act="create-confirmed">Create as confirmed</button>' : ''}
  ${b && ['hold', 'expired'].includes(b.status) ? '<button class="btn" data-act="confirm">Confirm booking</button><button class="btn" data-act="extend">Extend hold 24h</button>' : ''}
  ${b ? `<button class="btn" data-act="copy" data-link="${link}">Copy guest link</button><a class="btn" href="${link}" target="_blank" rel="noopener">Open guest page</a>` : ''}
  <span class="sp"></span>${b && b.status !== 'cancelled' ? '<button class="btn danger" data-act="cancel">Cancel booking</button>' : ''}</div></form>`;
  dlg.dataset.id = id || ''; dlg.showModal();
}
document.addEventListener('click', async (e) => {
  const t = e.target, dlg = $('#dlg');
  try {
    if (t.closest('[data-nav]')) { const n = +t.closest('[data-nav]').dataset.nav; calStart = n ? addD(calStart, n) : S.today; return render(); }
    if (t.closest('[data-new]')) return openBooking(null);
    const cell = t.closest('td.empty'); if (cell) return openBooking(null, { unit_id: +cell.dataset.u, check_in: cell.dataset.d });
    const bk = t.closest('[data-b]'); if (bk) return openBooking(+bk.dataset.b);
    if (t.dataset.copy) { await navigator.clipboard.writeText($(t.dataset.copy).value); return toast('Copied'); }
    if (t.dataset.rotate) { if (!confirm('The old link will stop working. Continue?')) return; await api('/workspace/rotate-key', 'POST'); await load(true); return toast('New link ready'); }
    const act = t.dataset.act; if (!act) return;
    e.preventDefault();
    const id = dlg.dataset.id ? +dlg.dataset.id : null, f = Object.fromEntries(new FormData($('#bf')));
    ['unit_id', 'guests'].forEach((k) => (f[k] = +f[k])); f.total = f.total === '' ? undefined : +f.total;
    if (act === 'copy') { await navigator.clipboard.writeText(t.dataset.link); return toast('Guest link copied'); }
    if (act === 'save') { id ? await api('/bookings/' + id, 'PATCH', f) : await api('/bookings', 'POST', f); toast(id ? 'Saved' : 'Hold created'); }
    if (act === 'create-confirmed') { await api('/bookings', 'POST', { ...f, status: 'confirmed' }); toast('Booking confirmed'); }
    if (act === 'confirm') { await api('/bookings/' + id, 'PATCH', f); await api(`/bookings/${id}/confirm`, 'POST'); toast('Confirmed'); }
    if (act === 'extend') { await api('/bookings/' + id, 'PATCH', { ...f, extend_hours: 24 }); toast('Hold extended'); }
    if (act === 'cancel') { if (!confirm('Cancel this booking and free the dates?')) return; await api(`/bookings/${id}/cancel`, 'POST'); toast('Cancelled'); }
    dlg.close(); await load(true);
  } catch (err) { const d = $('#derr'); if (d && dlg.open) d.textContent = err.message; else toast(err.message, true); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target; if (f.id === 'bf') return;
  try {
    const d = Object.fromEntries(new FormData(f)), num = (...ks) => ks.forEach((k) => (d[k] = d[k] === '' ? null : +d[k]));
    if (f.dataset.unit) { e.preventDefault(); num('capacity', 'price', 'weekend_price'); await api('/units/' + f.dataset.unit, 'PATCH', d); toast('Saved'); }
    else if (f.dataset.addunit) { e.preventDefault(); num('capacity', 'price', 'weekend_price'); await api(`/properties/${f.dataset.addunit}/units`, 'POST', d); toast('Unit added'); }
    else if (f.id === 'addprop') { e.preventDefault(); num('capacity', 'price', 'weekend_price'); await api('/properties', 'POST', { name: d.name, location: d.location, description: d.description, unit: { name: d.uname, capacity: d.capacity, price: d.price, weekend_price: d.weekend_price } }); toast('Property added'); }
    else if (f.id === 'wsform') { e.preventDefault(); await api('/workspace', 'PATCH', d); toast('Saved'); }
    else return;
    await load(true);
  } catch (err) { toast(err.message, true); }
});
load(true); setInterval(() => { if (!$('#dlg').open && !document.activeElement?.matches('input,textarea,select')) load().catch(() => {}); }, 5000);
