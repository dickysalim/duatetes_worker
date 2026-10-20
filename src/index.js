/**
 * Duatetes Worker — API
 * Cloudflare Worker connected to D1 database: duatetes_coupon
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function normalisePhone(raw) {
  let p = raw.replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

// Active prize set rules: 5–12 prizes, each % 0–100 summing to exactly 100,
// each slices integer >= 1, total slices 10–12. Returns an error string or null.
const MAX_PRIZE_NAME = 14;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── GET /api/health ──────────────────────────────────────────
    if (pathname === '/api/health' && method === 'GET') {
      return json({ ok: true, ts: new Date().toISOString() });
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
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const rawPhone = (body.phone_number || '').trim();
      if (!rawPhone) return json({ error: 'phone_number is required' }, 400);
      const phone = normalisePhone(rawPhone);

      let code, attempts = 0;
      while (attempts < 5) {
        code = generateCode();
        const existing = await env.DB.prepare(
          `SELECT coupon_id FROM coupons WHERE coupon_id = ?`
        ).bind(code).first();
        if (!existing) break;
        attempts++;
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO coupons (coupon_id, date_generated, phone_number) VALUES (?, ?, ?)`
      ).bind(code, now, phone).run();

      return json({ coupon_id: code, phone_number: phone }, 201);
    }

    // ── POST /api/spin ────────────────────────────────────────────
    // A prize flagged is_fail is auto-redeemed the moment it is won.
    if (pathname === '/api/spin' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const { coupon_id, prize_won } = body;
      if (!coupon_id || !prize_won) return json({ error: 'coupon_id and prize_won required' }, 400);

      const coupon = await env.DB.prepare(
        `SELECT * FROM coupons WHERE coupon_id = ?`
      ).bind(coupon_id).first();

      if (!coupon) return json({ error: 'Invalid coupon' }, 404);
      if (coupon.prize_won) return json({ error: 'Coupon already used' }, 409);

      const prize = await env.DB.prepare(
        `SELECT is_fail FROM prizes WHERE prize_name = ?`
      ).bind(prize_won).first();
      const autoRedeem = !!(prize && prize.is_fail);

      const now = new Date().toISOString();
      await env.DB.prepare(
        autoRedeem
          ? `UPDATE coupons SET prize_won = ?, date_prize_won = ?, is_fail = 1, is_redeemed = 1, date_redeemed = ? WHERE coupon_id = ?`
          : `UPDATE coupons SET prize_won = ?, date_prize_won = ? WHERE coupon_id = ?`
      ).bind(...(autoRedeem ? [prize_won, now, now, coupon_id] : [prize_won, now, coupon_id])).run();

      return json({ ok: true, prize_won, is_fail: autoRedeem });
    }

    // ── POST /api/redeem ──────────────────────────────────────────
    if (pathname === '/api/redeem' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const { coupon_id } = body;
      if (!coupon_id) return json({ error: 'coupon_id required' }, 400);

      const coupon = await env.DB.prepare(
        `SELECT * FROM coupons WHERE coupon_id = ?`
      ).bind(coupon_id).first();

      if (!coupon) return json({ error: 'Coupon not found' }, 404);
      if (!coupon.prize_won) return json({ error: 'Coupon has not been spun yet' }, 409);
      if (coupon.is_redeemed) return json({ error: 'Already redeemed' }, 409);

      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE coupons SET is_redeemed = 1, date_redeemed = ? WHERE coupon_id = ?`
      ).bind(now, coupon_id).run();

      return json({ ok: true });
    }

    // ── POST /api/validate ────────────────────────────────────────
    // Body: { coupon_id }
    // Returns: { valid: true, prizes: [...] } or { valid: false, error: '...' }
    if (pathname === '/api/validate' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const coupon_id = (body.coupon_id || '').trim().toUpperCase();
      if (!coupon_id) return json({ valid: false, error: 'Coupon code is required' });

      const coupon = await env.DB.prepare(
        `SELECT c.*, cu.name AS customer_name
         FROM coupons c
         LEFT JOIN customers cu ON cu.phone_number = c.phone_number
         WHERE c.coupon_id = ?`
      ).bind(coupon_id).first();

      if (!coupon) return json({ valid: false, error: 'Coupon not found. Check the code and try again.' });
      if (coupon.prize_won) return json({ valid: false, error: 'This coupon has already been used.' });

      // Wheel layout: prize_settings joined to prize details, in wheel order
      const { results: prizes } = await env.DB.prepare(
        `SELECT s.prize_pos, s.prize_id, s.percentage, s.slices, p.prize_name, p.icon, p.is_fail
         FROM prize_settings s JOIN prizes p ON p.prize_id = s.prize_id
         ORDER BY s.prize_pos ASC`
      ).all();

      return json({ valid: true, coupon_id, customer_name: coupon.customer_name || null, prizes });
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
    // Public wheel layout for the idle screen. No percentages: odds only come with a valid coupon.
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
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const prize_name = (body.prize_name || '').trim();
      const icon       = (body.icon || '🎁').trim();
      const is_fail    = body.is_fail ? 1 : 0;

      if (!prize_name) return json({ error: 'prize_name is required' }, 400);
      if ([...prize_name].length > MAX_PRIZE_NAME) return json({ error: `Prize name must be ${MAX_PRIZE_NAME} characters or fewer` }, 400);

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
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
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
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const prize_name = (body.prize_name || '').trim();
      const icon       = (body.icon || '🎁').trim();
      const is_fail    = body.is_fail ? 1 : 0;

      if (!prize_name) return json({ error: 'prize_name is required' }, 400);
      if ([...prize_name].length > MAX_PRIZE_NAME) return json({ error: `Prize name must be ${MAX_PRIZE_NAME} characters or fewer` }, 400);

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
        const like = `%${q}%`;
        const { results: rows } = await env.DB.prepare(
          `SELECT * FROM customers
           WHERE phone_number LIKE ? OR name LIKE ?
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
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const phone = (body.phone_number || '').trim();
      const name  = (body.name || '').trim();
      if (!phone) return json({ error: 'phone_number is required' }, 400);

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

    // ── PUT /api/customers/:id ────────────────────────────────────
    const customerIdMatch = pathname.match(/^\/api\/customers\/(\d+)$/);
    if (customerIdMatch && method === 'PUT') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const id    = parseInt(customerIdMatch[1]);
      const phone = (body.phone_number || '').trim();
      const name  = (body.name || '').trim();
      if (!phone) return json({ error: 'phone_number is required' }, 400);

      const conflict = await env.DB.prepare(
        `SELECT id FROM customers WHERE phone_number = ? AND id != ?`
      ).bind(phone, id).first();
      if (conflict) return json({ error: 'Phone number already in use' }, 409);

      const result = await env.DB.prepare(
        `UPDATE customers SET phone_number = ?, name = ? WHERE id = ?`
      ).bind(phone, name, id).run();
      if (result.meta.changes === 0) return json({ error: 'Customer not found' }, 404);
      return json({ ok: true });
    }

    // ── DELETE /api/customers/:id ─────────────────────────────────
    if (customerIdMatch && method === 'DELETE') {
      const id = parseInt(customerIdMatch[1]);
      const result = await env.DB.prepare(
        `DELETE FROM customers WHERE id = ?`
      ).bind(id).run();
      if (result.meta.changes === 0) return json({ error: 'Customer not found' }, 404);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
