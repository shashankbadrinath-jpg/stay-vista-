import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, 'staydesk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL, mcp_key TEXT UNIQUE NOT NULL, whatsapp TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, location TEXT DEFAULT '', description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS units(id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE, name TEXT NOT NULL, capacity INTEGER NOT NULL, price INTEGER NOT NULL, weekend_price INTEGER);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE, check_in TEXT NOT NULL, check_out TEXT NOT NULL, guests INTEGER NOT NULL, guest_name TEXT NOT NULL, guest_phone TEXT DEFAULT '', status TEXT NOT NULL, expires_at TEXT, total INTEGER NOT NULL, quote_message TEXT DEFAULT '', notes TEXT DEFAULT '', token TEXT UNIQUE NOT NULL, source TEXT DEFAULT 'dashboard', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_b_unit ON bookings(unit_id, check_in);
`);

const DAY = 86400000;
export const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
export const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

export function parseDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) throw new Error(`Invalid date "${s}".`);
  return t;
}
export const addDays = (s, n) => new Date(parseDay(s) + n * DAY).toISOString().slice(0, 10);

export function nightsBetween(ci, co) {
  const a = parseDay(ci), b = parseDay(co);
  if (b <= a) throw new Error('check_out must be after check_in.');
  if ((b - a) / DAY > 60) throw new Error('Stays longer than 60 nights are not supported.');
  const out = [];
  for (let t = a; t < b; t += DAY) out.push(t);
  return out;
}

// Weekend nights (Fri, Sat) use weekend_price when the unit has one.
export function quote(unit, ci, co) {
  const nights = nightsBetween(ci, co);
  let total = 0;
  for (const t of nights) {
    const d = new Date(t).getUTCDay();
    total += (d === 5 || d === 6) && unit.weekend_price ? unit.weekend_price : unit.price;
  }
  return { nights: nights.length, total };
}

const UNIT_SQL = `SELECT u.*, p.name AS property, p.location, p.description, p.workspace_id AS ws
                  FROM units u JOIN properties p ON p.id = u.property_id`;

export function getUnit(ws, unitId) {
  const u = db.prepare(`${UNIT_SQL} WHERE u.id = ?`).get(unitId);
  if (!u || u.ws !== ws) throw new Error(`Unit ${unitId} not found. Call list_properties to see valid unit ids.`);
  return u;
}

export function conflicts(unitId, ci, co, excludeId = 0) {
  return db.prepare(`SELECT id, guest_name, check_in, check_out, status FROM bookings
    WHERE unit_id = ? AND id != ? AND check_in < ? AND check_out > ?
    AND (status = 'confirmed' OR (status = 'hold' AND expires_at > ?))`).all(unitId, excludeId, co, ci, nowIso());
}

export function present(b) {
  if (!b) return b;
  const status = b.status === 'hold' && b.expires_at && b.expires_at <= nowIso() ? 'expired' : b.status;
  return { ...b, status, nights: (parseDay(b.check_out) - parseDay(b.check_in)) / DAY };
}

const BOOKING_SQL = `SELECT b.*, u.name AS unit, u.capacity, p.name AS property, p.location
  FROM bookings b JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id`;

export const getBooking = (ws, id) => {
  const b = db.prepare(`${BOOKING_SQL} WHERE b.id = ? AND b.workspace_id = ?`).get(id, ws);
  if (!b) throw new Error(`Booking ${id} not found.`);
  return present(b);
};
export const bookingByToken = (token) => present(db.prepare(`${BOOKING_SQL} WHERE b.token = ?`).get(token));
export const listBookings = (ws) => db.prepare(`${BOOKING_SQL} WHERE b.workspace_id = ? ORDER BY b.created_at DESC, b.id DESC`).all(ws).map(present);

export function listProperties(ws) {
  const props = db.prepare('SELECT * FROM properties WHERE workspace_id = ? ORDER BY id').all(ws);
  const units = db.prepare(`SELECT u.* FROM units u JOIN properties p ON p.id = u.property_id WHERE p.workspace_id = ? ORDER BY u.id`).all(ws);
  return props.map((p) => ({ ...p, units: units.filter((u) => u.property_id === p.id) }));
}

export function addProperty(ws, { name, location = '', description = '', units }) {
  if (!name?.trim()) throw new Error('Property name is required.');
  if (!units?.length) throw new Error('Add at least one unit (room or villa).');
  const tx = db.transaction(() => {
    const id = db.prepare('INSERT INTO properties(workspace_id, name, location, description) VALUES (?,?,?,?)').run(ws, name.trim(), location, description).lastInsertRowid;
    for (const u of units) addUnit(ws, Number(id), u);
    return Number(id);
  });
  const id = tx();
  return listProperties(ws).find((p) => p.id === id);
}

export function addUnit(ws, propertyId, { name, capacity, price, weekend_price = null }) {
  const p = db.prepare('SELECT id FROM properties WHERE id = ? AND workspace_id = ?').get(propertyId, ws);
  if (!p) throw new Error('Property not found.');
  if (!name?.trim()) throw new Error('Unit name is required.');
  if (!(capacity > 0) || !(price > 0)) throw new Error('capacity and price must be positive numbers.');
  const r = db.prepare('INSERT INTO units(property_id, name, capacity, price, weekend_price) VALUES (?,?,?,?,?)')
    .run(propertyId, name.trim(), Math.round(capacity), Math.round(price), weekend_price ? Math.round(weekend_price) : null);
  return Number(r.lastInsertRowid);
}

export function updateUnit(ws, unitId, patch) {
  const u = getUnit(ws, unitId);
  const n = {
    name: patch.name?.trim() || u.name,
    capacity: Math.round(patch.capacity ?? u.capacity),
    price: Math.round(patch.price ?? u.price),
    weekend_price: patch.weekend_price === undefined ? u.weekend_price : patch.weekend_price ? Math.round(patch.weekend_price) : null,
  };
  if (!(n.capacity > 0) || !(n.price > 0)) throw new Error('capacity and price must be positive numbers.');
  db.prepare('UPDATE units SET name=?, capacity=?, price=?, weekend_price=? WHERE id=?').run(n.name, n.capacity, n.price, n.weekend_price, unitId);
}

export function availability(ws, ci, co, guests = 1, location = '') {
  nightsBetween(ci, co);
  const loc = `%${String(location).toLowerCase()}%`;
  const rows = location
    ? db.prepare(`${UNIT_SQL} WHERE p.workspace_id = ? AND u.capacity >= ? AND (lower(p.location) LIKE ? OR lower(p.name) LIKE ?) ORDER BY u.price`).all(ws, guests, loc, loc)
    : db.prepare(`${UNIT_SQL} WHERE p.workspace_id = ? AND u.capacity >= ? ORDER BY u.price`).all(ws, guests);
  return rows.filter((u) => !conflicts(u.id, ci, co).length).map((u) => ({
    unit_id: u.id, unit: u.name, property: u.property, location: u.location, description: u.description,
    capacity: u.capacity, price_per_night: u.price, weekend_price: u.weekend_price, ...quote(u, ci, co),
  }));
}

export function createBooking(ws, b) {
  const u = getUnit(ws, Number(b.unit_id));
  const guests = Number(b.guests || 1);
  if (guests > u.capacity) throw new Error(`${u.name} sleeps ${u.capacity}; ${guests} guests requested.`);
  if (!b.guest_name?.trim()) throw new Error('guest_name is required.');
  const q = quote(u, b.check_in, b.check_out);
  const clash = conflicts(u.id, b.check_in, b.check_out);
  if (clash.length) throw new Error(`Dates are not available: overlaps booking #${clash[0].id} (${clash[0].check_in} to ${clash[0].check_out}, ${clash[0].status}).`);
  const status = b.status === 'confirmed' ? 'confirmed' : 'hold';
  const expires = status === 'hold' ? new Date(Date.now() + Math.min(Math.max(Number(b.hold_hours || 24), 1), 168) * 3600000).toISOString() : null;
  const r = db.prepare(`INSERT INTO bookings(workspace_id, unit_id, check_in, check_out, guests, guest_name, guest_phone, status, expires_at, total, quote_message, notes, token, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws, u.id, b.check_in, b.check_out, guests, b.guest_name.trim(), b.guest_phone || '', status, expires,
    b.total ? Math.round(b.total) : q.total, b.quote_message || '', b.notes || '', rid(12), b.source || 'dashboard');
  return getBooking(ws, Number(r.lastInsertRowid));
}

export function updateBooking(ws, id, patch) {
  const cur = getBooking(ws, id);
  const next = {
    unit_id: Number(patch.unit_id ?? cur.unit_id), check_in: patch.check_in ?? cur.check_in, check_out: patch.check_out ?? cur.check_out,
    guests: Number(patch.guests ?? cur.guests), guest_name: patch.guest_name ?? cur.guest_name, guest_phone: patch.guest_phone ?? cur.guest_phone,
    quote_message: patch.quote_message ?? cur.quote_message, notes: patch.notes ?? cur.notes,
  };
  const u = getUnit(ws, next.unit_id);
  if (next.guests > u.capacity) throw new Error(`${u.name} sleeps ${u.capacity}.`);
  if (!next.guest_name.trim()) throw new Error('Guest name is required.');
  const q = quote(u, next.check_in, next.check_out);
  const moved = next.unit_id !== cur.unit_id || next.check_in !== cur.check_in || next.check_out !== cur.check_out;
  if (moved && ['hold', 'confirmed'].includes(cur.status)) {
    const clash = conflicts(u.id, next.check_in, next.check_out, id);
    if (clash.length) throw new Error(`Dates clash with booking #${clash[0].id} (${clash[0].check_in} to ${clash[0].check_out}).`);
  }
  const total = patch.total != null && patch.total !== '' ? Math.round(patch.total) : moved ? q.total : cur.total;
  let expires = cur.expires_at;
  if (patch.extend_hours && cur.status !== 'confirmed') expires = new Date(Math.max(Date.now(), Date.parse(cur.expires_at || nowIso())) + patch.extend_hours * 3600000).toISOString();
  db.prepare(`UPDATE bookings SET unit_id=?, check_in=?, check_out=?, guests=?, guest_name=?, guest_phone=?, quote_message=?, notes=?, total=?, expires_at=? WHERE id=?`)
    .run(next.unit_id, next.check_in, next.check_out, next.guests, next.guest_name.trim(), next.guest_phone, next.quote_message, next.notes, total, expires, id);
  return getBooking(ws, id);
}

export function setStatus(ws, id, status) {
  const cur = getBooking(ws, id);
  if (status === 'confirmed') {
    if (cur.status === 'confirmed') return cur;
    if (cur.status === 'cancelled') throw new Error('Cancelled bookings cannot be confirmed. Create a new hold instead.');
    const clash = conflicts(cur.unit_id, cur.check_in, cur.check_out, id);
    if (clash.length) throw new Error(`Cannot confirm: dates now overlap booking #${clash[0].id}.`);
    db.prepare(`UPDATE bookings SET status='confirmed', expires_at=NULL WHERE id=?`).run(id);
  } else if (status === 'cancelled') {
    db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(id);
  }
  return getBooking(ws, id);
}

export function summary(ws, month) {
  const m = month || today().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('month must be YYYY-MM.');
  const start = `${m}-01`;
  const end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10);
  const days = (parseDay(end) - parseDay(start)) / DAY;
  const units = db.prepare(`SELECT COUNT(*) c FROM units u JOIN properties p ON p.id=u.property_id WHERE p.workspace_id=?`).get(ws).c;
  const bs = listBookings(ws).filter((b) => ['confirmed', 'hold'].includes(b.status) && b.check_in < end && b.check_out > start);
  let nightsConfirmed = 0, revenue = 0, holdValue = 0, holds = 0, confirmed = 0;
  const byProperty = {};
  for (const b of bs) {
    const a = Math.max(parseDay(b.check_in), parseDay(start)), z = Math.min(parseDay(b.check_out), parseDay(end));
    const n = (z - a) / DAY;
    const share = Math.round((b.total * n) / b.nights);
    const p = (byProperty[b.property] ||= { property: b.property, confirmed_nights: 0, revenue: 0 });
    if (b.status === 'confirmed') { nightsConfirmed += n; revenue += share; confirmed++; p.confirmed_nights += n; p.revenue += share; }
    else { holdValue += share; holds++; }
  }
  return { month: m, confirmed_bookings: confirmed, confirmed_revenue_inr: revenue, confirmed_nights: nightsConfirmed,
    occupancy_pct: units ? Math.round((nightsConfirmed / (units * days)) * 1000) / 10 : 0,
    open_holds: holds, open_hold_value_inr: holdValue, by_property: Object.values(byProperty) };
}

// ---------- workspaces & users ----------
export const wsByKey = (key) => db.prepare('SELECT * FROM workspaces WHERE mcp_key = ?').get(key);
export function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; }
export function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function createWorkspace(name, email, password, key = rid(18)) {
  if (!name?.trim() || !email?.includes('@') || (password || '').length < 6) throw new Error('Enter a business name, a valid email and a password of 6+ characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) throw new Error('That email already has an account.');
  const wsId = Number(db.prepare('INSERT INTO workspaces(name, mcp_key) VALUES (?,?)').run(name.trim(), key).lastInsertRowid);
  const userId = Number(db.prepare('INSERT INTO users(workspace_id, email, pass_hash) VALUES (?,?,?)').run(wsId, email.toLowerCase(), hashPw(password)).lastInsertRowid);
  return { wsId, userId };
}

export function seedDemo() {
  if (db.prepare('SELECT COUNT(*) c FROM workspaces').get().c) return;
  const { wsId } = createWorkspace('Demo Stays', 'demo@staydesk.app', 'demo1234', process.env.DEMO_MCP_KEY || rid(18));
  db.prepare('UPDATE workspaces SET whatsapp = ? WHERE id = ?').run('919900000000', wsId);
  addProperty(wsId, { name: 'Omnia Estate', location: 'Coorg', description: 'Coffee-estate stay with a plunge pool, bonfire evenings and a resident cook.',
    units: [{ name: 'Mantra Villa', capacity: 8, price: 14000, weekend_price: 16500 }, { name: 'Raaga Cottage', capacity: 4, price: 7500, weekend_price: 9000 }] });
  addProperty(wsId, { name: 'Tide House', location: 'Gokarna', description: 'Ten minutes from Kudle beach. Sea-facing terrace, breakfast included.',
    units: [{ name: 'Sea Suite', capacity: 3, price: 6000, weekend_price: 7000 }, { name: 'Dune Villa', capacity: 6, price: 11000, weekend_price: 13000 }] });
  addProperty(wsId, { name: 'Pine Ridge', location: 'Munnar', description: 'Tea-garden cabins above the mist line, with a log fireplace.',
    units: [{ name: 'Ridge Cabin', capacity: 2, price: 5500, weekend_price: 6500 }] });
  const ps = listProperties(wsId), t = today();
  createBooking(wsId, { unit_id: ps[0].units[0].id, check_in: addDays(t, 4), check_out: addDays(t, 7), guests: 6, guest_name: 'Aarav Mehta', guest_phone: '919811100001', status: 'confirmed', source: 'seed', notes: 'Birthday weekend, wants cake arranged.' });
  createBooking(wsId, { unit_id: ps[1].units[1].id, check_in: addDays(t, 9), check_out: addDays(t, 12), guests: 5, guest_name: 'Nisha Rao', guest_phone: '919811100002', status: 'confirmed', source: 'seed' });
  createBooking(wsId, { unit_id: ps[2].units[0].id, check_in: addDays(t, 2), check_out: addDays(t, 4), guests: 2, guest_name: 'Kabir & Zoya', guest_phone: '919811100003', source: 'seed', hold_hours: 36,
    quote_message: 'Hi Kabir! Ridge Cabin is yours for 2 nights. Total ₹12,000. We will hold it for 36 hours.' });
}
