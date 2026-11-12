import pg from 'pg';
const { Pool, types } = pg;
// keep DATE columns as 'YYYY-MM-DD' strings (no time-zone shifting)
types.setTypeParser(1082, v => v);

const g = globalThis;
export function pool() {
  if (!g.__haPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const local = /localhost|127\.0\.0\.1|\/var\/run/.test(url);
    g.__haPool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
  }
  return g.__haPool;
}

const CORE = ['ha_dash_kpis', 'ha_dash_daily', 'ha_dash_campaigns', 'ha_dash_adgroups', 'ha_dash_keywords',
  'ha_dash_search_terms', 'ha_dash_conversion_actions', 'ha_dash_lead_sources', 'ha_dash_recent_leads'];
// from tracking_and_recommendations.sql — the dashboard still works (with a setup notice) until it is run
const EXTRA = ['ha_dash_crm_leads', 'ha_dash_service_stats', 'ha_dash_tracking', 'ha_dash_tracking_daily',
  'ha_dash_landing_pages', 'ha_dash_traffic_sources'];

const TEXT_KEYS = new Set(['lead_id', 'phone', 'name', 'crm_note', 'service', 'landing_page', 'keyword', 'search_term',
  'ad_keyword', 'campaign_name', 'ad_group_name', 'source']);

// numeric/bigint come back as strings from pg — turn them into numbers
function clean(rows) {
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) o[k] = v.toISOString();
      else if (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v) && !TEXT_KEYS.has(k)) o[k] = Number(v);
      else o[k] = v;
    }
    return o;
  });
}

const q = (p, fn, from, to) => p.query(`select * from ${fn}($1::date, $2::date)`, [from, to]).then(r => clean(r.rows));

export async function loadDashboard(from, to, prevFrom, prevTo) {
  const p = pool();
  const [core, prev, extra] = await Promise.all([
    Promise.all(CORE.map(fn => q(p, fn, from, to))),
    q(p, 'ha_dash_kpis', prevFrom, prevTo).catch(() => [null]),
    Promise.all(EXTRA.map(fn => q(p, fn, from, to))).catch(e => ({ error: String(e.message || e) }))
  ]);
  const [kpis, daily, campaigns, adgroups, keywords, searchTerms, convActions, leadSources, recentLeads] = core;
  const ok = Array.isArray(extra);
  const [crmLeads, serviceStats, tracking, trackingDaily, landingPages, trafficSources] = ok ? extra : [[], [], [], [], [], []];
  return {
    kpis: kpis[0], prevKpis: prev[0] || null, daily, campaigns, adgroups, keywords, searchTerms, convActions, leadSources, recentLeads,
    crmLeads, serviceStats, tracking: tracking[0] || null, trackingDaily, landingPages, trafficSources,
    setupMissing: ok ? null : extra.error
  };
}

export async function trackEvent(payload) {
  const r = await pool().query('select ha_track($1::jsonb) as r', [JSON.stringify(payload)]);
  return r.rows[0].r;
}

export const CRM_STATUSES = ['new', 'contacted', 'qualified', 'booked', 'showed', 'paid', 'lost'];

/** patch: { crm_status?, crm_note?, next_follow_up?, contacted? } — only the keys present are changed */
export async function updateLead(leadId, patch) {
  const has = k => Object.prototype.hasOwnProperty.call(patch, k);
  const status = has('crm_status') ? (patch.crm_status || null) : null;
  const contacted = !!patch.contacted || (status && !['new', 'lost'].includes(status));
  const r = await pool().query(
    `update ha_leads set
       crm_status     = case when $2::boolean then $3::text else crm_status end,
       crm_note       = case when $4::boolean then $5::text else crm_note end,
       next_follow_up = case when $6::boolean then $7::timestamptz else next_follow_up end,
       contacted_at   = case when $8::boolean and contacted_at is null then now() else contacted_at end,
       crm_updated_at = now()
     where lead_id = $1
     returning lead_id, crm_status, crm_note, next_follow_up, contacted_at`,
    [leadId, has('crm_status'), status, has('crm_note'), patch.crm_note ?? null,
      has('next_follow_up'), patch.next_follow_up || null, contacted]
  );
  return clean(r.rows)[0] || null;
}
