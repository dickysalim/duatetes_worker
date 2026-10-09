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
        `SELECT * FROM coupons ORDER BY date_generated DESC LIMIT 100`
      ).all();
      return json({ coupons: results });
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

      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE coupons SET prize_won = ?, date_prize_won = ? WHERE coupon_id = ?`
      ).bind(prize_won, now, coupon_id).run();

      return json({ ok: true, prize_won });
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
        `SELECT * FROM coupons WHERE coupon_id = ?`
      ).bind(coupon_id).first();

      if (!coupon) return json({ valid: false, error: 'Coupon not found. Check the code and try again.' });
      if (coupon.prize_won) return json({ valid: false, error: 'This coupon has already been used.' });

      // Fetch active prizes for the wheel
      const { results: prizes } = await env.DB.prepare(
        `SELECT * FROM prizes WHERE is_active = 1 ORDER BY id ASC`
      ).all();

      return json({ valid: true, coupon_id, prizes });
    }

    // ── GET /api/prizes ───────────────────────────────────────────
    if (pathname === '/api/prizes' && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT * FROM prizes ORDER BY id ASC`
      ).all();
      return json({ prizes: results });
    }

    // ── POST /api/prizes ──────────────────────────────────────────
    if (pathname === '/api/prizes' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const prize_name       = (body.prize_name || '').trim();
      const prize_percentage = parseFloat(body.prize_percentage);
      const icon             = (body.icon || '🎁').trim();
      const is_active        = body.is_active === false ? 0 : 1;

      if (!prize_name) return json({ error: 'prize_name is required' }, 400);
      if (isNaN(prize_percentage) || prize_percentage < 0 || prize_percentage > 100) {
        return json({ error: 'prize_percentage must be between 0 and 100' }, 400);
      }

      const existing = await env.DB.prepare(
        `SELECT id FROM prizes WHERE LOWER(prize_name) = LOWER(?)`
      ).bind(prize_name).first();
      if (existing) return json({ error: 'A prize with that name already exists' }, 409);

      const result = await env.DB.prepare(
        `INSERT INTO prizes (prize_name, prize_percentage, icon, is_active) VALUES (?, ?, ?, ?)`
      ).bind(prize_name, prize_percentage, icon, is_active).run();

      return json({ id: result.meta.last_row_id, prize_name, prize_percentage, icon, is_active }, 201);
    }

    // ── PUT /api/prizes/:id ───────────────────────────────────────
    const prizeIdMatch = pathname.match(/^\/api\/prizes\/(\d+)$/);

    if (prizeIdMatch && method === 'PUT') {
      const id = parseInt(prizeIdMatch[1]);
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const prize_name       = (body.prize_name || '').trim();
      const prize_percentage = parseFloat(body.prize_percentage);
      const icon             = (body.icon || '🎁').trim();
      const is_active        = body.is_active ? 1 : 0;

      if (!prize_name) return json({ error: 'prize_name is required' }, 400);
      if (isNaN(prize_percentage) || prize_percentage < 0 || prize_percentage > 100) {
        return json({ error: 'prize_percentage must be between 0 and 100' }, 400);
      }

      const duplicate = await env.DB.prepare(
        `SELECT id FROM prizes WHERE LOWER(prize_name) = LOWER(?) AND id != ?`
      ).bind(prize_name, id).first();
      if (duplicate) return json({ error: 'A prize with that name already exists' }, 409);

      const result = await env.DB.prepare(
        `UPDATE prizes SET prize_name = ?, prize_percentage = ?, icon = ?, is_active = ? WHERE id = ?`
      ).bind(prize_name, prize_percentage, icon, is_active, id).run();

      if (result.meta.changes === 0) return json({ error: 'Prize not found' }, 404);
      return json({ ok: true });
    }

    // ── DELETE /api/prizes/:id ────────────────────────────────────
    if (prizeIdMatch && method === 'DELETE') {
      const id = parseInt(prizeIdMatch[1]);
      const result = await env.DB.prepare(
        `DELETE FROM prizes WHERE id = ?`
      ).bind(id).run();
      if (result.meta.changes === 0) return json({ error: 'Prize not found' }, 404);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
