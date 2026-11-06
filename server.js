import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from './db.js';
import { mcpHandler } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------- sessions (signed cookie, no deps) ----------
const secretFile = path.join(D.DATA_DIR, 'secret');
const SECRET = process.env.SESSION_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : (() => { const s = D.rid(32); fs.writeFileSync(secretFile, s); return s; })());
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function setSession(req, res, userId) {
  const v = `${userId}.${Date.now() + 14 * 86400000}`;
  res.append('Set-Cookie', `sd=${v}.${sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${req.secure ? '; Secure' : ''}`);
}
function sessionUser(req) {
  const m = /(?:^|;\s*)sd=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!sig || sign(`${uid}.${exp}`) !== sig || Number(exp) < Date.now()) return null;
  return D.db.prepare(`SELECT u.id, u.email, u.workspace_id AS ws, w.name AS wname, w.mcp_key, w.whatsapp FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = ?`).get(Number(uid)) || null;
}
const needUser = (req, res, next) => { const u = sessionUser(req); if (!u) return res.status(401).json({ error: 'Please sign in again.' }); req.u = u; next(); };
const h = (fn) => (req, res) => { try { res.json(fn(req) ?? { ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } };
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// ---------- pages ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const dayLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const shell = (title, body, cls = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"></head><body class="${cls}">${body}</body></html>`;

function landing(error = '', mode = 'login') {
  const signup = mode === 'signup';
  return shell('StayDesk', `
<main class="landing">
  <section class="pitch">
    <div class="brand">StayDesk</div>
    <h1>Tell Claude about the guest. The calendar fills itself.</h1>
    <p>StayDesk is the reservation desk for boutique stays. Connect your own Claude, paste a guest's WhatsApp message, and Claude checks availability, holds the dates and writes the quote. StayDesk keeps the calendar, the hold timers and the guest link live. You edit anything with one tap.</p>
    <div class="sample"><b>You, in Claude</b><span>Family of 6 wants 26 to 29 Dec in Coorg, around ₹14k a night. Hold it for Priya, 98450 12345.</span></div>
    <div class="sample out"><b>In StayDesk, seconds later</b><span>A 24-hour hold on Mantra Villa, a quote Priya can open from a link, and a calendar bar you can drag into shape.</span></div>
  </section>
  <section class="card login">
    <h2>${signup ? 'Create your desk' : 'Sign in'}</h2>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <form method="post" action="/${signup ? 'signup' : 'login'}">
      ${signup ? '<label>Business name<input name="name" required placeholder="Hillside Homestays"></label>' : ''}
      <label>Email<input name="email" type="email" required autocomplete="username" ${signup ? '' : 'value="demo@staydesk.app"'}></label>
      <label>Password<input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? '' : 'value="demo1234"'}></label>
      <button class="btn primary">${signup ? 'Create desk' : 'Open demo desk'}</button>
    </form>
    <p class="muted">${signup ? 'Already have a desk? <a href="/">Sign in</a>' : 'The demo login is filled in for reviewers. <a href="/signup">Create your own desk</a>'}</p>
  </section>
</main>`);
}

app.get('/', (req, res) => (sessionUser(req) ? res.redirect('/app') : res.send(landing(req.query.e ? 'Wrong email or password.' : ''))));
app.get('/signup', (req, res) => res.send(landing('', 'signup')));
app.post('/login', (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email || '').toLowerCase());
  if (!u || !D.checkPw(String(req.body.password || ''), u.pass_hash)) return res.redirect('/?e=1');
  setSession(req, res, u.id); res.redirect('/app');
});
app.post('/signup', (req, res) => {
  try { const { userId } = D.createWorkspace(req.body.name, req.body.email, req.body.password); setSession(req, res, userId); res.redirect('/app'); }
  catch (e) { res.status(400).send(landing(e.message, 'signup')); }
});
app.post('/logout', (req, res) => { res.append('Set-Cookie', 'sd=; Path=/; Max-Age=0'); res.redirect('/'); });
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get('/app', (req, res) => (sessionUser(req) ? res.sendFile(path.join(__dirname, '..', 'public', 'app.html')) : res.redirect('/')));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- guest quote page ----------
app.get('/q/:token', (req, res) => {
  const b = D.bookingByToken(req.params.token);
  if (!b) return res.status(404).send(shell('Not found', '<main class="guest"><h1>This link is not valid</h1><p>Ask your host for a fresh link.</p></main>'));
  const w = D.db.prepare('SELECT name, whatsapp FROM workspaces WHERE id = ?').get(b.workspace_id);
  const state = {
    hold: [`Held for you until ${when(b.expires_at)} IST`, 'hold'], confirmed: ['Booking confirmed', 'confirmed'],
    expired: ['This hold has expired. Message your host to check the dates again.', 'expired'], cancelled: ['This booking was cancelled.', 'expired'],
  }[b.status];
  const wa = w.whatsapp ? `https://wa.me/${w.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi, I'd like to confirm booking #${b.id}: ${b.property}, ${b.unit}, ${b.check_in} to ${b.check_out}.`)}` : '';
  res.send(shell(`${b.property} · ${w.name}`, `
<main class="guest">
  <div class="brand">${esc(w.name)}</div>
  <p class="state ${state[1]}">${esc(state[0])}</p>
  <h1>${esc(b.property)}<small>${esc(b.unit)} · ${esc(b.location)}</small></h1>
  <dl class="facts">
    <div><dt>Check in</dt><dd>${dayLabel(b.check_in)}</dd></div><div><dt>Check out</dt><dd>${dayLabel(b.check_out)}</dd></div>
    <div><dt>Guests</dt><dd>${b.guests}</dd></div><div><dt>${b.nights} night${b.nights > 1 ? 's' : ''}</dt><dd class="total">${inr(b.total)}</dd></div>
  </dl>
  ${b.quote_message ? `<div class="note">${esc(b.quote_message)}</div>` : ''}
  ${wa && b.status === 'hold' ? `<a class="btn primary wide" href="${esc(wa)}">Confirm on WhatsApp</a>` : ''}
  <p class="muted">Prepared for ${esc(b.guest_name)}</p>
</main>`, 'plain'));
});

// ---------- dashboard API ----------
const api = express.Router();
api.use(needUser);
api.get('/state', h((req) => ({
  workspace: { name: req.u.wname, whatsapp: req.u.whatsapp, email: req.u.email, mcp_url: `${baseUrl(req)}/mcp/${req.u.mcp_key}` },
  today: D.today(), properties: D.listProperties(req.u.ws), bookings: D.listBookings(req.u.ws),
})));
api.post('/bookings', h((req) => D.createBooking(req.u.ws, { ...req.body, source: 'dashboard' })));
api.patch('/bookings/:id', h((req) => D.updateBooking(req.u.ws, +req.params.id, req.body)));
api.post('/bookings/:id/confirm', h((req) => D.setStatus(req.u.ws, +req.params.id, 'confirmed')));
api.post('/bookings/:id/cancel', h((req) => D.setStatus(req.u.ws, +req.params.id, 'cancelled')));
api.post('/properties', h((req) => D.addProperty(req.u.ws, { ...req.body, units: [{ ...req.body.unit }] })));
api.post('/properties/:id/units', h((req) => D.addUnit(req.u.ws, +req.params.id, req.body)));
api.patch('/units/:id', h((req) => D.updateUnit(req.u.ws, +req.params.id, req.body)));
api.patch('/workspace', h((req) => { D.db.prepare('UPDATE workspaces SET name = COALESCE(?, name), whatsapp = COALESCE(?, whatsapp) WHERE id = ?').run(req.body.name?.trim() || null, req.body.whatsapp ?? null, req.u.ws); }));
api.post('/workspace/rotate-key', h((req) => { D.db.prepare('UPDATE workspaces SET mcp_key = ? WHERE id = ?').run(D.rid(18), req.u.ws); }));
app.use('/api', api);

// ---------- MCP (stateless streamable HTTP) ----------
app.post('/mcp/:key', mcpHandler);
const no = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
app.get('/mcp/:key', no); app.delete('/mcp/:key', no);

D.seedDemo();
app.listen(PORT, () => {
  const demo = D.db.prepare("SELECT mcp_key FROM workspaces WHERE id = (SELECT workspace_id FROM users WHERE email = 'demo@staydesk.app')").get();
  console.log(`StayDesk on :${PORT}`);
  if (demo) console.log(`Demo MCP link: ${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/mcp/${demo.mcp_key}`);
});
