// Update a lead's CRM fields from the dashboard (behind the dashboard login).
import { updateLead, CRM_STATUSES } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  // JSON only: a cross-site form can't send application/json without a CORS preflight, which we never allow
  if (!(req.headers.get('content-type') || '').includes('application/json')) {
    return Response.json({ ok: false, error: 'json only' }, { status: 415 });
  }
  let b;
  try { b = await req.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
  if (!b || typeof b.lead_id !== 'string' || !b.lead_id) return Response.json({ ok: false, error: 'lead_id required' }, { status: 400 });

  const patch = {};
  if ('crm_status' in b) {
    if (b.crm_status && !CRM_STATUSES.includes(b.crm_status)) return Response.json({ ok: false, error: 'bad status' }, { status: 400 });
    patch.crm_status = b.crm_status || null;
  }
  if ('crm_note' in b) patch.crm_note = b.crm_note == null ? null : String(b.crm_note).slice(0, 4000);
  if ('next_follow_up' in b) {
    if (b.next_follow_up && Number.isNaN(Date.parse(b.next_follow_up))) return Response.json({ ok: false, error: 'bad date' }, { status: 400 });
    patch.next_follow_up = b.next_follow_up || null;
  }
  if (b.contacted) patch.contacted = true;

  try {
    const row = await updateLead(b.lead_id, patch);
    if (!row) return Response.json({ ok: false, error: 'lead not found' }, { status: 404 });
    return Response.json({ ok: true, lead: row });
  } catch (e) {
    const msg = String(e.message || e);
    const hint = /column .* does not exist/.test(msg) ? ' — run supabase/tracking_and_recommendations.sql' : '';
    return Response.json({ ok: false, error: msg + hint }, { status: 500 });
  }
}
