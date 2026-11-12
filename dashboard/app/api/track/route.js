// Public endpoint for the website tracking script (website/lead-source-capture.js).
// Not behind the dashboard login (see middleware.js). It can only record visits/events and phone-number leads;
// it can't read anything back.
import { trackEvent } from '../../../lib/db';

export const dynamic = 'force-dynamic';

const allowed = (process.env.TRACK_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

function cors(req) {
  const origin = req.headers.get('origin') || '';
  const ok = !allowed.length || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

// best-effort rate limit per IP (per server instance)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60000 }); return false; }
  h.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return h.n > 120;
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

export async function POST(req) {
  const headers = cors(req);
  const origin = req.headers.get('origin');
  if (allowed.length && origin && !allowed.includes(origin)) return new Response('origin not allowed', { status: 403, headers });

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return new Response('slow down', { status: 429, headers });

  let body;
  try {
    const text = await req.text();          // sendBeacon posts text/plain (no CORS preflight)
    if (text.length > 4000) return new Response('too large', { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return new Response('bad json', { status: 400, headers });
  }
  if (!body || typeof body !== 'object') return new Response('bad body', { status: 400, headers });

  const ua = req.headers.get('user-agent') || '';
  if (/bot|crawler|spider|preview|lighthouse|headless/i.test(ua)) return Response.json({ ok: true, skipped: 'bot' }, { headers });
  body.device = /mobile|android|iphone/i.test(ua) ? 'mobile' : /ipad|tablet/i.test(ua) ? 'tablet' : 'desktop';

  try {
    const r = await trackEvent(body);
    return Response.json(r, { headers });
  } catch (e) {
    console.error('track failed', e);
    return Response.json({ ok: false }, { status: 500, headers });
  }
}
