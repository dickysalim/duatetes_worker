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

/** Generate 8-char alphanumeric uppercase coupon code */
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

/** Normalise phone → 62XXXXXXXXX (strip leading 0 or +) */
function normalisePhone(raw) {
  let p = raw.replace(/\D/g, '');          // digits only
  if (p.startsWith('0')) p = p.slice(1);   // 08xx → 8xx
  if (!p.startsWith('62')) p = '62' + p;   // prepend country code
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
    // Body: { phone_number: "08123..." }
    // Returns: { coupon_id, phone_number }
    if (pathname === '/api/coupons' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const rawPhone = (body.phone_number || '').trim();
      if (!rawPhone) return json({ error: 'phone_number is required' }, 400);

      const phone = normalisePhone(rawPhone);

      // Generate a unique code (retry up to 5x on collision)
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
        `INSERT INTO coupons (coupon_id, date_generated, phone_number)
         VALUES (?, ?, ?)`
      ).bind(code, now, phone).run();

      return json({ coupon_id: code, phone_number: phone }, 201);
    }

    // ── POST /api/spin ────────────────────────────────────────────
    // Body: { coupon_id, prize_won }
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
    // Body: { coupon_id }
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

    return json({ error: 'Not found' }, 404);
  },
};
