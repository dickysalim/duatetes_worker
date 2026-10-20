/**
 * Duatetes Worker — API
 * Cloudflare Worker connected to D1 database: duatetes_coupon
 *
 * Secrets (wrangler secret / .dev.vars):
 *   SESSION_SECRET  random string; signs login sessions, spin tickets and prize picks
 *   ADMIN_PIN_HASH  "salt:sha256hex(salt + pin)"; set with ./set-pin
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Session-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Parsed JSON object body, or null when it is missing, malformed or not an object.
async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function normalisePhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

// Normalised numbers are 62 + 8–13 digits.
const validPhone = p => /^62\d{8,13}$/.test(p);

// Escape LIKE wildcards so a search for "50%" matches literally.
const likeEscape = s => s.replace(/[\\%_]/g, c => '\\' + c);

// Active prize set rules: 5–12 prizes, each % 0–100 summing to exactly 100,
// each slices integer >= 1, total slices 10–12. Returns an error string or null.
const MAX_PRIZE_NAME = 14;
const MAX_ICON = 16;
const MAX_CUSTOMER_NAME = 60;
const MIN_PRIZES = 5, MAX_PRIZES = 12, MIN_SLICES = 10, MAX_SLICES = 12;
function validateActiveSet(list) {
  if (list.length < MIN_PRIZES || list.length > MAX_PRIZES) {
    return `Active prizes must be ${MIN_PRIZES}–${MAX_PRIZES} (got ${list.length})`;
  }
  const seen = new Set();
  let pctSum = 0, sliceSum = 0;
  for (const p of list) {
    if (!Number.isInteger(p.prize_id) || seen.has(p.prize_id)) return 'Invalid or duplicate prize id';
    seen.add(p.prize_id);
    if (typeof p.percentage !== 'number' || !(p.percentage >= 0 && p.percentage <= 100)) {
      return 'Percentage must be between 0 and 100';
    }
    if (!Number.isInteger(p.slices) || p.slices < 1) return 'Slices must be a whole number of at least 1';
    pctSum += p.percentage;
    sliceSum += p.slices;
  }
  if (Math.abs(pctSum - 100) > 0.001) return `Percentages must total 100% (got ${Math.round(pctSum * 1000) / 1000}%)`;
  if (sliceSum < MIN_SLICES || sliceSum > MAX_SLICES) {
    return `Total slices must be ${MIN_SLICES}–${MAX_SLICES} (got ${sliceSum})`;
  }
  return null;
}

// ── Crypto helpers ────────────────────────────────────────────────
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(s + '='.repeat((4 - (s.length % 4)) % 4));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// HMAC-SHA256 under SESSION_SECRET; `label` keeps sessions, tickets and picks from being interchangeable.
async function hmac(env, label, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(`${label}:${data}`));
}

async function signToken(env, label, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(env, label, body))}`;
}

// Payload object when the signature checks out, otherwise null.
async function verifyToken(env, label, token) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, b64url(await hmac(env, label, body)))) return null;
  try { return JSON.parse(b64urlDecode(body)); } catch { return null; }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// ── Back-office sessions ──────────────────────────────────────────
// Sliding session: valid while the last activity is under 3 days old.
// Any admin request older than an hour gets a fresh token in X-Session-Token.
const SESSION_IDLE_MS = 3 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 60 * 60 * 1000;

// { token } when authenticated (token set only when it should be replaced), otherwise null.
async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const session = await verifyToken(env, 'session', header.slice(7));
  const now = Date.now();
  if (!session || typeof session.t !== 'number' || now - session.t > SESSION_IDLE_MS || session.t > now + 60000) return null;
  const refreshed = now - session.t > SESSION_REFRESH_MS
    ? await signToken(env, 'session', { t: now })
    : null;
  return { token: refreshed };
}

// ── Login rate limit ──────────────────────────────────────────────
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

async function loginBlocked(env, ip, now) {
  const row = await env.DB.prepare(`SELECT fails, first_fail FROM auth_attempts WHERE ip = ?`).bind(ip).first();
  return !!row && now - Date.parse(row.first_fail) < LOGIN_WINDOW_MS && row.fails >= LOGIN_MAX_FAILS;
}

async function recordLoginFail(env, ip, now) {
  const iso = new Date(now).toISOString();
  const row = await env.DB.prepare(`SELECT first_fail FROM auth_attempts WHERE ip = ?`).bind(ip).first();
  if (!row || now - Date.parse(row.first_fail) >= LOGIN_WINDOW_MS) {
    await env.DB.prepare(`INSERT OR REPLACE INTO auth_attempts (ip, fails, first_fail) VALUES (?, 1, ?)`).bind(ip, iso).run();
  } else {
    await env.DB.prepare(`UPDATE auth_attempts SET fails = fails + 1 WHERE ip = ?`).bind(ip).run();
  }
  await env.DB.prepare(`DELETE FROM auth_attempts WHERE first_fail < ?`)
    .bind(new Date(now - LOGIN_WINDOW_MS).toISOString()).run();
}

// ── Prize pick ────────────────────────────────────────────────────
// Weighted by prize percentage, but derived from HMAC(coupon_id) instead of a
// fresh random number: a coupon always maps to the same prize, so reloading
// mid-spin cannot be used to re-roll. Null when no prizes are on the wheel.
async function pickPrize(env, couponId) {
  const { results: prizes } = await env.DB.prepare(
    `SELECT s.percentage, p.prize_name, p.icon, p.is_fail
     FROM prize_settings s JOIN prizes p ON p.prize_id = s.prize_id
     ORDER BY s.prize_pos ASC`
  ).all();
  if (!prizes.length) return null;

  const bytes = new Uint8Array(await hmac(env, 'pick', couponId));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + bytes[i];
  const r = n / 2 ** 48; // [0, 1)

  const total = prizes.reduce((sum, p) => sum + p.percentage, 0);
  if (total <= 0) return prizes[Math.floor(r * prizes.length)];
  let x = r * total;
  for (const p of prizes) {
    x -= p.percentage;
    if (x < 0) return p;
  }
  return [...prizes].reverse().find(p => p.percentage > 0);
}

const SPIN_TICKET_MS = 15 * 60 * 1000;

// Routes that need no login. Everything else under /api needs a session.
const PUBLIC = new Set([
  'GET /api/health',
  'GET /api/wheel',
  'GET /api/winners',
  'POST /api/validate',
  'POST /api/spin',
  'POST /api/spin/claim',
  'POST /api/login',
]);

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

      const { pathname } = new URL(request.url);
      if (!env.SESSION_SECRET || !env.ADMIN_PIN_HASH) {
        console.error('SESSION_SECRET / ADMIN_PIN_HASH are not configured');
        return json({ error: 'Server is not configured' }, 500);
      }

      let session = null;
      if (!PUBLIC.has(`${request.method} ${pathname}`)) {
        session = await authenticate(request, env);
        if (!session) return json({ error: 'Unauthorized' }, 401);
      }

      const res = await route(request, env);
      if (session && session.token) res.headers.set('X-Session-Token', session.token);
      return res;
    } catch (err) {
      console.error('Unhandled error:', err && err.stack || err);
      return json({ error: 'Server error' }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  // ── GET /api/health ──────────────────────────────────────────
  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, ts: new Date().toISOString() });
  }

  // ── POST /api/login ──────────────────────────────────────────
  // Body: { pin }. Returns { token } for the back office.
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    if (await loginBlocked(env, ip, now)) {
      return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    }

    const pin = typeof body.pin === 'string' ? body.pin : '';
    const [salt, expected] = env.ADMIN_PIN_HASH.split(':');
    const ok = /^\d{6}$/.test(pin) && safeEqual(await sha256Hex(salt + pin), expected || '');
    if (!ok) {
      await recordLoginFail(env, ip, now);
      return json({ error: 'Incorrect PIN' }, 401);
    }

    await env.DB.prepare(`DELETE FROM auth_attempts WHERE ip = ?`).bind(ip).run();
    return json({ token: await signToken(env, 'session', { t: now }) });
  }

  // ── GET /api/session ─────────────────────────────────────────
  // Auth check for the back office; the refreshed token header does the rest.
  if (pathname === '/api/session' && method === 'GET') {
    return json({ ok: true });
  }

  // ── GET /api/coupons ─────────────────────────────────────────
  if (pathname === '/api/coupons' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT c.*, cu.name AS customer_name
       FROM coupons c
       LEFT JOIN customers cu ON cu.phone_number = c.phone_number
       ORDER BY c.date_generated DESC LIMIT 200`
    ).all();
    return json({ coupons: results });
  }

  // ── GET /api/coupons/:coupon_id ───────────────────────────────
  // Lookup a single coupon by its code; joins customer name if available
  const couponLookupMatch = pathname.match(/^\/api\/coupons\/([A-Z0-9]{1,12})$/i);
  if (couponLookupMatch && method === 'GET') {
    const id = couponLookupMatch[1].toUpperCase();
    const coupon = await env.DB.prepare(
      `SELECT c.*, cu.name AS customer_name
       FROM coupons c
       LEFT JOIN customers cu ON cu.phone_number = c.phone_number
       WHERE c.coupon_id = ?`
    ).bind(id).first();
    if (!coupon) return json({ error: 'Coupon not found' }, 404);
    return json(coupon);
  }

  // ── POST /api/coupons ─────────────────────────────────────────
  if (pathname === '/api/coupons' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const rawPhone = String(body.phone_number || '').trim();
    if (!rawPhone) return json({ error: 'phone_number is required' }, 400);
    const phone = normalisePhone(rawPhone);
    if (!validPhone(phone)) return json({ error: 'Invalid phone number' }, 400);

    let code = null;
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = generateCode();
      const existing = await env.DB.prepare(
        `SELECT coupon_id FROM coupons WHERE coupon_id = ?`
      ).bind(candidate).first();
      if (!existing) code = candidate;
    }
    if (!code) return json({ error: 'Could not generate a unique code, try again' }, 500);

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO coupons (coupon_id, date_generated, phone_number) VALUES (?, ?, ?)`
    ).bind(code, now, phone).run();

    return json({ coupon_id: code, phone_number: phone }, 201);
  }

  // ── POST /api/validate ────────────────────────────────────────
  // Body: { coupon_id }
  // Returns: { valid: true, customer_name, prizes: [...] } or { valid: false, error: '...' }
  // Customer-facing, so the messages are Indonesian. No odds are sent.
  if (pathname === '/api/validate' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const coupon_id = String(body.coupon_id || '').trim().toUpperCase();
    if (!coupon_id) return json({ valid: false, error: 'Kode kupon wajib diisi.' });

    const coupon = await env.DB.prepare(
      `SELECT c.prize_won, cu.name AS customer_name
       FROM coupons c
       LEFT JOIN customers cu ON cu.phone_number = c.phone_number
       WHERE c.coupon_id = ?`
    ).bind(coupon_id).first();

    if (!coupon) return json({ valid: false, error: 'Kupon tidak ditemukan. Periksa kode dan coba lagi.' });
    if (coupon.prize_won) return json({ valid: false, error: 'Kupon ini sudah digunakan.' });

    const { results: prizes } = await env.DB.prepare(
      `SELECT s.prize_pos, s.prize_id, s.slices, p.prize_name, p.icon, p.is_fail
       FROM prize_settings s JOIN prizes p ON p.prize_id = s.prize_id
       ORDER BY s.prize_pos ASC`
    ).all();
    if (!prizes.length) return json({ valid: false, error: 'Roda hadiah belum tersedia. Coba lagi nanti.' });

    return json({ valid: true, coupon_id, customer_name: coupon.customer_name || null, prizes });
  }

  // ── POST /api/spin ────────────────────────────────────────────
  // Body: { coupon_id }. Picks the prize on the server and returns it with a
  // signed ticket. Nothing is written yet: the prize is only recorded when the
  // customer actually sees it (/api/spin/claim). The same coupon always gets
  // the same prize back, so reloading mid-spin does not re-roll.
  if (pathname === '/api/spin' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const coupon_id = String(body.coupon_id || '').trim().toUpperCase();
    if (!coupon_id) return json({ error: 'coupon_id required' }, 400);

    const coupon = await env.DB.prepare(
      `SELECT prize_won FROM coupons WHERE coupon_id = ?`
    ).bind(coupon_id).first();
    if (!coupon) return json({ error: 'Kupon tidak ditemukan.' }, 404);
    if (coupon.prize_won) return json({ error: 'Kupon ini sudah digunakan.' }, 409);

    const prize = await pickPrize(env, coupon_id);
    if (!prize) return json({ error: 'Roda hadiah belum tersedia.' }, 503);

    const ticket = await signToken(env, 'ticket', {
      c: coupon_id, p: prize.prize_name, f: prize.is_fail ? 1 : 0, e: Date.now() + SPIN_TICKET_MS,
    });
    return json({ ok: true, prize_name: prize.prize_name, icon: prize.icon, is_fail: !!prize.is_fail, ticket });
  }

  // ── POST /api/spin/claim ──────────────────────────────────────
  // Body: { ticket }. Records the prize on the coupon once it is on screen.
  // A prize flagged is_fail is auto-redeemed. Safe to repeat.
  if (pathname === '/api/spin/claim' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const t = await verifyToken(env, 'ticket', body.ticket);
    if (!t || typeof t.c !== 'string' || typeof t.p !== 'string' || typeof t.e !== 'number') {
      return json({ error: 'Invalid ticket' }, 400);
    }
    if (Date.now() > t.e) return json({ error: 'Ticket expired' }, 410);

    const fail = t.f ? 1 : 0;
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE coupons
       SET prize_won = ?, date_prize_won = ?, is_fail = ?, is_redeemed = ?, date_redeemed = ?
       WHERE coupon_id = ? AND prize_won IS NULL`
    ).bind(t.p, now, fail, fail, fail ? now : null, t.c).run();

    if (result.meta.changes === 0) {
      const coupon = await env.DB.prepare(`SELECT prize_won FROM coupons WHERE coupon_id = ?`).bind(t.c).first();
      if (!coupon) return json({ error: 'Kupon tidak ditemukan.' }, 404);
      if (coupon.prize_won !== t.p) return json({ error: 'Kupon ini sudah digunakan.' }, 409);
    }
    return json({ ok: true, prize_won: t.p, is_fail: !!fail });
  }

  // ── POST /api/redeem ──────────────────────────────────────────
  if (pathname === '/api/redeem' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const coupon_id = String(body.coupon_id || '').trim().toUpperCase();
    if (!coupon_id) return json({ error: 'coupon_id required' }, 400);

    const coupon = await env.DB.prepare(
      `SELECT prize_won, is_redeemed FROM coupons WHERE coupon_id = ?`
    ).bind(coupon_id).first();

    if (!coupon) return json({ error: 'Coupon not found' }, 404);
    if (!coupon.prize_won) return json({ error: 'Coupon has not been spun yet' }, 409);
    if (coupon.is_redeemed) return json({ error: 'Already redeemed' }, 409);

    const result = await env.DB.prepare(
      `UPDATE coupons SET is_redeemed = 1, date_redeemed = ? WHERE coupon_id = ? AND is_redeemed = 0`
    ).bind(new Date().toISOString(), coupon_id).run();
    if (result.meta.changes === 0) return json({ error: 'Already redeemed' }, 409);

    return json({ ok: true });
  }

  // ── GET /api/winners ──────────────────────────────────────────
  // Public recent-winners feed: spun coupons that did not land on a fail prize.
  // Exposes customer name and prize only, never phone numbers.
  if (pathname === '/api/winners' && method === 'GET') {
    const { results: winners } = await env.DB.prepare(
      `SELECT cu.name AS customer_name, c.prize_won, p.icon, c.date_prize_won
       FROM coupons c
       LEFT JOIN customers cu ON cu.phone_number = c.phone_number
       LEFT JOIN prizes p ON p.prize_name = c.prize_won
       WHERE c.prize_won IS NOT NULL AND c.is_fail = 0
       ORDER BY c.date_prize_won DESC LIMIT 10`
    ).all();
    return json({ winners });
  }

  // ── GET /api/wheel ────────────────────────────────────────────
  // Public wheel layout for the idle screen. No percentages: odds stay on the server.
  if (pathname === '/api/wheel' && method === 'GET') {
    const { results: prizes } = await env.DB.prepare(
      `SELECT s.prize_pos, s.prize_id, s.slices, p.prize_name, p.icon, p.is_fail
       FROM prize_settings s JOIN prizes p ON p.prize_id = s.prize_id
       ORDER BY s.prize_pos ASC`
    ).all();
    return json({ prizes });
  }

  // ── GET /api/prizes ───────────────────────────────────────────
  // Every prize plus its wheel settings (prize_pos null = not on the wheel).
  if (pathname === '/api/prizes' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.prize_id, p.prize_name, p.icon, p.is_fail, s.prize_pos, s.percentage, s.slices
       FROM prizes p LEFT JOIN prize_settings s ON s.prize_id = p.prize_id
       ORDER BY p.prize_id ASC`
    ).all();
    return json({ prizes: results });
  }

  // ── POST /api/prizes ──────────────────────────────────────────
  // Adds a prize to the catalogue. It is not on the wheel until it is in prize_settings.
  if (pathname === '/api/prizes' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const prize_name = String(body.prize_name || '').trim();
    const icon       = String(body.icon || '🎁').trim();
    const is_fail    = body.is_fail ? 1 : 0;

    if (!prize_name) return json({ error: 'prize_name is required' }, 400);
    if ([...prize_name].length > MAX_PRIZE_NAME) return json({ error: `Prize name must be ${MAX_PRIZE_NAME} characters or fewer` }, 400);
    if (!icon || [...icon].length > MAX_ICON) return json({ error: 'Invalid icon' }, 400);

    const existing = await env.DB.prepare(
      `SELECT prize_id FROM prizes WHERE LOWER(prize_name) = LOWER(?)`
    ).bind(prize_name).first();
    if (existing) return json({ error: 'A prize with that name already exists' }, 409);

    const result = await env.DB.prepare(
      `INSERT INTO prizes (prize_name, icon, is_fail) VALUES (?, ?, ?)`
    ).bind(prize_name, icon, is_fail).run();

    return json({ prize_id: result.meta.last_row_id, prize_name, icon, is_fail, prize_pos: null, percentage: null, slices: null }, 201);
  }

  // ── PUT /api/prize-settings ───────────────────────────────────
  // Body: { settings: [{ prize_id, percentage, slices }, ...] }
  // Replaces the whole wheel layout atomically; prize_pos = array order (1..n).
  if (pathname === '/api/prize-settings' && method === 'PUT') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const list = Array.isArray(body.settings) ? body.settings : null;
    if (!list) return json({ error: 'settings array is required' }, 400);

    const err = validateActiveSet(list);
    if (err) return json({ error: err }, 400);

    const ids = list.map(p => p.prize_id);
    const { results: found } = await env.DB.prepare(
      `SELECT prize_id FROM prizes WHERE prize_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    if (found.length !== ids.length) return json({ error: 'Unknown prize id in list' }, 400);

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM prize_settings`),
      ...list.map((p, i) => env.DB.prepare(
        `INSERT INTO prize_settings (prize_pos, prize_id, percentage, slices) VALUES (?, ?, ?, ?)`
      ).bind(i + 1, p.prize_id, p.percentage, p.slices)),
    ]);
    return json({ ok: true });
  }

  // ── PUT /api/prizes/:id ───────────────────────────────────────
  const prizeIdMatch = pathname.match(/^\/api\/prizes\/(\d+)$/);

  if (prizeIdMatch && method === 'PUT') {
    const id = parseInt(prizeIdMatch[1]);
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);

    const prize_name = String(body.prize_name || '').trim();
    const icon       = String(body.icon || '🎁').trim();
    const is_fail    = body.is_fail ? 1 : 0;

    if (!prize_name) return json({ error: 'prize_name is required' }, 400);
    if ([...prize_name].length > MAX_PRIZE_NAME) return json({ error: `Prize name must be ${MAX_PRIZE_NAME} characters or fewer` }, 400);
    if (!icon || [...icon].length > MAX_ICON) return json({ error: 'Invalid icon' }, 400);

    const duplicate = await env.DB.prepare(
      `SELECT prize_id FROM prizes WHERE LOWER(prize_name) = LOWER(?) AND prize_id != ?`
    ).bind(prize_name, id).first();
    if (duplicate) return json({ error: 'A prize with that name already exists' }, 409);

    const result = await env.DB.prepare(
      `UPDATE prizes SET prize_name = ?, icon = ?, is_fail = ? WHERE prize_id = ?`
    ).bind(prize_name, icon, is_fail, id).run();

    if (result.meta.changes === 0) return json({ error: 'Prize not found' }, 404);
    return json({ ok: true });
  }

  // ── DELETE /api/prizes/:id ────────────────────────────────────
  if (prizeIdMatch && method === 'DELETE') {
    const id = parseInt(prizeIdMatch[1]);
    const onWheel = await env.DB.prepare(`SELECT prize_id FROM prize_settings WHERE prize_id = ?`).bind(id).first();
    if (onWheel) {
      return json({ error: 'Move the prize out of Prize Settings before deleting it' }, 409);
    }
    const result = await env.DB.prepare(
      `DELETE FROM prizes WHERE prize_id = ?`
    ).bind(id).run();
    if (result.meta.changes === 0) return json({ error: 'Prize not found' }, 404);
    return json({ ok: true });
  }

  // ── GET /api/customers ────────────────────────────────────────
  // ?q=xxx  → search by phone or name (LIKE)
  if (pathname === '/api/customers' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    let results;
    if (q) {
      const like = `%${likeEscape(q)}%`;
      const { results: rows } = await env.DB.prepare(
        `SELECT * FROM customers
         WHERE phone_number LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
         ORDER BY name ASC LIMIT 10`
      ).bind(like, like).all();
      results = rows;
    } else {
      const { results: rows } = await env.DB.prepare(
        `SELECT * FROM customers ORDER BY created_at DESC`
      ).all();
      results = rows;
    }
    return json({ customers: results });
  }

  // ── POST /api/customers ───────────────────────────────────────
  // Upsert by phone_number — updates name if phone already exists
  if (pathname === '/api/customers' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const rawPhone = String(body.phone_number || '').trim();
    const name     = String(body.name || '').trim();
    if (!rawPhone) return json({ error: 'phone_number is required' }, 400);
    const phone = normalisePhone(rawPhone);
    if (!validPhone(phone)) return json({ error: 'Invalid phone number' }, 400);
    if ([...name].length > MAX_CUSTOMER_NAME) return json({ error: `Name must be ${MAX_CUSTOMER_NAME} characters or fewer` }, 400);

    await env.DB.prepare(
      `INSERT INTO customers (phone_number, name)
       VALUES (?, ?)
       ON CONFLICT(phone_number) DO UPDATE SET name = excluded.name`
    ).bind(phone, name).run();

    const customer = await env.DB.prepare(
      `SELECT * FROM customers WHERE phone_number = ?`
    ).bind(phone).first();
    return json(customer);
  }

  return json({ error: 'Not found' }, 404);
}
