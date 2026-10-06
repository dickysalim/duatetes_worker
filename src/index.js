/**
 * Duatetes Worker — API entry point
 * Cloudflare Worker connected to D1 database: duatetes_coupon
 *
 * Routes (to be built):
 *   POST /api/coupon/validate   — validate coupon code + return wheel segments
 *   POST /api/spin              — record spin result, return prize
 *   POST /api/redeem            — mark prize as redeemed
 *   GET  /api/coupons           — backoffice: list all coupons
 *   POST /api/coupons           — backoffice: generate coupon + send WA
 *   GET  /api/prizes            — backoffice: list prizes with percentages
 *   PUT  /api/prizes/:id        — backoffice: update prize percentage
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS headers for Pages frontends
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    // ── Health check ──
    if (pathname === '/api/health') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    return json({ error: 'Not found' }, 404);
  },
};
