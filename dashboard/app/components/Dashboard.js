'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import DataTable, { formats } from './DataTable';
import { DailyBars, DailyLines, Heatmap, Funnel } from './Charts';
import { Kpi, Card } from './ui';
import ActionPlan from './ActionPlan';
import LeadsCRM from './LeadsCRM';
import Tracking from './Tracking';
import { serviceIndex, scoreLead, leadHeatmap, buildPlan, RANK } from '../../lib/recommendations';

const div = (a, b) => (b ? a / b : null);
const TABS = ['Action plan', 'Overview', 'Leads CRM', 'Tracking', 'Campaigns', 'Ad groups', 'Keywords', 'Search terms', 'Lead sources'];
const sumBy = k => rows => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const ratioTotal = (a, b) => rows => div(sumBy(a)(rows), sumBy(b)(rows));

function applyPatch(l, p) {
  const n = { ...l, ...p };
  const cr = p.crm_status;
  if (cr === 'lost' && l.status_rank < 3) { n.status = 'lost'; n.status_rank = -1; }
  else if (cr && RANK[cr] > l.status_rank) { n.status = cr; n.status_rank = RANK[cr]; }
  return n;
}

export default function Dashboard({ data, from, to, range, days, now, initialTab }) {
  const router = useRouter();
  const [tab, setTab] = useState(TABS.includes(initialTab) ? initialTab : 'Action plan');
  const [patches, setPatches] = useState({});
  const k = data.kpis || {};
  const p = data.prevKpis || {};
  const cpq = div(k.cost, k.qualified);
  const cpl = div(k.cost, k.google_leads);
  const leadTracking = (k.google_leads || 0) > 0;

  // ── recommendation engine ──
  const svc = useMemo(() => serviceIndex(data.serviceStats), [data.serviceStats]);
  // until tracking_and_recommendations.sql is run, fall back to the latest 200 leads
  const baseLeads = useMemo(() => (data.setupMissing
    ? (data.recentLeads || []).map(l => ({ ...l, in_range: true, status_rank: RANK[l.status] ?? 0 }))
    : data.crmLeads || []), [data.setupMissing, data.crmLeads, data.recentLeads]);
  const leads = useMemo(
    () => baseLeads.map(l => scoreLead(patches[l.lead_id] ? applyPatch(l, patches[l.lead_id]) : l, svc, now)),
    [baseLeads, patches, svc, now]
  );
  const inRange = useMemo(() => leads.filter(l => l.in_range), [leads]);
  const heat = useMemo(() => leadHeatmap(inRange), [inRange]);
  const plan = useMemo(() => buildPlan({
    kpis: k, prevKpis: data.prevKpis, campaigns: data.campaigns, keywords: data.keywords, searchTerms: data.searchTerms,
    leads, svc, tracking: data.tracking, landingPages: data.landingPages, days, heat
  }), [k, data, leads, svc, days, heat]);

  const onSaved = (id, row) => {
    setPatches(s => ({ ...s, [id]: { ...(s[id] || {}), ...row } }));
    router.refresh();
  };

  const summary = [
    { label: 'Call now', value: leads.filter(l => l.urgency === 1).length, kind: 'bad', tab: 'Leads CRM' },
    { label: 'Follow-ups due', value: leads.filter(l => l.due && l.status_rank >= 0 && l.status_rank <= 2).length, kind: 'warn', tab: 'Leads CRM' },
    { label: 'Hot leads', value: leads.filter(l => l.temp === 'Hot').length, kind: 'bad', tab: 'Leads CRM' },
    { label: 'Typed phone, didn’t send', value: leads.filter(l => l.channel === 'website (phone typed)' && l.status_rank === 0).length, tab: 'Leads CRM' },
    { label: 'Leads this period', value: inRange.length, tab: 'Lead sources' },
    { label: 'Booked this period', value: inRange.filter(l => l.status_rank >= 3).length, kind: 'good', tab: 'Leads CRM' }
  ];

  // Advice per row: compares against account averages
  const advice = r => {
    const conv = r.ads_conversions || 0, leadsN = r.leads || 0, q = r.qualified || 0;
    if (r.clicks >= 15 && leadsN === 0 && conv < 1) return 'Pause?';
    if (leadTracking) {
      if (q >= 2 && cpq && r.cost / q < cpq * 0.8) return 'Scale';
      if (leadsN >= 3 && cpl && r.cost / leadsN < cpl * 0.7) return 'Scale';
      if (r.cost > 300 && q === 0) return 'Watch';
    } else {
      const acpa = div(k.cost, k.ads_conversions);
      if (conv >= 2 && acpa && r.cost / conv < acpa * 0.7) return 'Scale';
      if (conv >= 1 && acpa && r.cost / conv > acpa * 1.6) return 'Watch';
    }
    return '';
  };
  const adviceFlag = r => ({ Scale: 'good', 'Pause?': 'bad', Watch: 'warn' }[advice(r)] || null);
  const cpqFlag = r => (!r.qualified || !cpq ? null : r.cost / r.qualified < cpq * 0.8 ? 'good' : r.cost / r.qualified > cpq * 1.5 ? 'bad' : null);
  const cplFlag = r => (!r.leads || !cpl ? null : r.cost / r.leads < cpl * 0.8 ? 'good' : r.cost / r.leads > cpl * 1.5 ? 'bad' : null);
  const adviceFilter = { key: 'advice', label: 'Advice', value: r => advice(r) || 'OK', options: ['Scale', 'Watch', 'Pause?', 'OK'] };

  const perfCols = [
    { key: 'impressions', label: 'Impr.', format: 'int', total: 'sum', hidden: true },
    { key: 'clicks', label: 'Clicks', format: 'int', total: 'sum' },
    { key: 'ctr', label: 'CTR', format: 'pct', value: r => div(r.clicks, r.impressions), total: ratioTotal('clicks', 'impressions') },
    { key: 'cpc', label: 'Avg CPC', format: 'egp', value: r => div(r.cost, r.clicks), total: ratioTotal('cost', 'clicks') },
    { key: 'cost', label: 'Cost', format: 'egp', bar: true, total: 'sum' },
    { key: 'ads_conversions', label: 'Google conv.', format: 'dec', total: 'sum' },
    { key: 'cpa', label: 'Cost / Google conv.', format: 'egp', value: r => div(r.cost, r.ads_conversions), total: ratioTotal('cost', 'ads_conversions'), hidden: leadTracking },
    { key: 'leads', label: 'Real leads', format: 'int', bar: true, total: 'sum' },
    { key: 'cpl', label: 'Cost / lead', format: 'egp', value: r => div(r.cost, r.leads), flag: cplFlag, total: ratioTotal('cost', 'leads') },
    { key: 'qualified', label: 'Qualified', format: 'int', total: 'sum' },
    { key: 'cpq', label: 'Cost / qualified', format: 'egp', value: r => div(r.cost, r.qualified), flag: cpqFlag, total: ratioTotal('cost', 'qualified') },
    { key: 'booked', label: 'Booked', format: 'int', total: 'sum' },
    { key: 'cpb', label: 'Cost / booking', format: 'egp', value: r => div(r.cost, r.booked), total: ratioTotal('cost', 'booked') },
    { key: 'paid', label: 'Paid', format: 'int', total: 'sum' }
  ];

  // channel performance from the CRM leads created in the period
  const channels = useMemo(() => {
    const m = {};
    for (const l of inRange) {
      const key = `${l.channel || 'other'}|${l.source || 'unknown'}`;
      const r = (m[key] = m[key] || { channel: l.channel || 'other', source: l.source || 'unknown', leads: 0, contacted: 0, booked: 0, paid: 0, revenue: 0, score: 0 });
      r.leads += 1; r.score += l.score;
      if (l.status_rank >= 1 || l.contacted_at) r.contacted += 1;
      if (l.status_rank >= 3) r.booked += 1;
      if (l.status_rank >= 5) { r.paid += 1; r.revenue += l.value || 0; }
    }
    return Object.values(m).map(r => ({ ...r, score: r.score / r.leads }));
  }, [inRange]);

  return (
    <main>
      <header className="top">
        <div>
          <h1>Hollywood Clinic — Ads &amp; Leads</h1>
          <p className="muted">{from} → {to} · {days} days · compared with the {days} days before · Google Ads syncs daily, leads live</p>
        </div>
        <nav className="ranges">
          {[7, 30, 90].map(d => (
            <a key={d} href={`?range=${d}`} className={range === d ? 'on' : ''}>Last {d} days</a>
          ))}
          <form className="custom" method="get">
            <input type="date" name="from" defaultValue={from} />
            <input type="date" name="to" defaultValue={to} />
            <button>Go</button>
          </form>
        </nav>
      </header>

      <section className="kpis">
        <Kpi label="Spend" value={formats.egp(k.cost)} cur={k.cost} prev={p.cost} good="none" />
        <Kpi label="Clicks" value={formats.int(k.clicks)} sub={`CPC ${formats.egp(div(k.cost, k.clicks))}`} cur={k.clicks} prev={p.clicks} />
        <Kpi label="Google 'conversions'" value={formats.dec(k.ads_conversions)} sub={`${formats.egp(div(k.cost, k.ads_conversions))} each`} muted />
        <Kpi label="All leads" value={formats.int(k.leads)} cur={k.leads} prev={p.leads} sub="every source" />
        <Kpi label="Real Google leads" value={formats.int(k.google_leads)} sub={`${formats.egp(cpl)} each`} cur={k.google_leads} prev={p.google_leads} accent />
        <Kpi label="Cost / lead" value={formats.egp(cpl)} cur={cpl} prev={div(p.cost, p.google_leads)} good="down" />
        <Kpi label="Qualified" value={formats.int(k.qualified)} sub={`${formats.egp(cpq)} each`} cur={k.qualified} prev={p.qualified} />
        <Kpi label="Booked" value={formats.int(k.booked)} sub={`${formats.pct(div(k.booked, k.google_leads))} of leads · ${formats.egp(div(k.cost, k.booked))} each`} cur={k.booked} prev={p.booked} />
        <Kpi label="Paid" value={formats.int(k.paid)} sub={`${formats.egp(div(k.cost, k.paid))} each`} cur={k.paid} prev={p.paid} />
        <Kpi label="Revenue (Google leads)" value={formats.egp(k.revenue)} sub={k.revenue ? `ROAS ${(k.revenue / k.cost).toFixed(1)}×` : 'add value when paid'} cur={k.revenue} prev={p.revenue} />
      </section>

      {!leadTracking && (
        <div className="notice">
          No leads are matched to Google Ads yet. Until the website and WhatsApp links pass the click ID (gclid) or ref code,
          the &quot;Real leads&quot; columns stay empty and advice falls back to Google&apos;s own conversions (mostly contact-button clicks).
        </div>
      )}
      {data.setupMissing && (
        <div className="notice">
          Recommendations, Leads CRM and Tracking need one more SQL file: run <code>supabase/tracking_and_recommendations.sql</code> in the Supabase SQL Editor.
        </div>
      )}

      <nav className="tabs">
        {TABS.map(t => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'Action plan' && plan.actions.filter(a => a.priority === 'high').length > 0 && <em className="tab-count">{plan.actions.filter(a => a.priority === 'high').length}</em>}
            {t === 'Leads CRM' && summary[0].value > 0 && <em className="tab-count">{summary[0].value}</em>}
          </button>
        ))}
      </nav>

      {tab === 'Action plan' && <ActionPlan plan={plan} summary={summary} onGo={setTab} />}

      {tab === 'Overview' && (
        <>
          <div className="grid2">
            <Card title="Spend per day (EGP)"><DailyBars data={data.daily} dataKey="cost" name="Spend" money /></Card>
            <Card title="Leads per day (Google)">
              <DailyLines data={data.daily} height={200} series={[
                { key: 'google_leads', name: 'Real Google leads' },
                { key: 'qualified', name: 'Qualified+' },
                { key: 'ads_conversions', name: "Google 'conversions'", dashed: true }
              ]} />
            </Card>
          </div>
          <div className="grid2">
            <Card title="Google lead funnel">
              <Funnel steps={[
                ['Clicks', k.clicks], ['Leads', k.google_leads], ['Qualified', k.qualified],
                ['Booked', k.booked], ['Showed', k.showed], ['Paid', k.paid]]} />
            </Card>
            <Card title="When leads come in" note="All sources, by weekday and hour. Use it for staffing and the Google Ads ad schedule.">
              <Heatmap heat={heat} />
            </Card>
          </div>
          <Card title="Campaigns at a glance">
            <DataTable rows={data.campaigns} searchable={false} totals exportName="campaigns-summary" defaultSort={{ key: 'cost', dir: 'desc' }}
              columns={[
                { key: 'campaign_name', label: 'Campaign' },
                { key: 'cost', label: 'Cost', format: 'egp', bar: true, total: 'sum' },
                { key: 'share', label: 'Share of spend', format: 'pct', value: r => div(r.cost, k.cost) },
                { key: 'leads', label: 'Real leads', format: 'int', total: 'sum' },
                { key: 'cpl', label: 'Cost / lead', format: 'egp', value: r => div(r.cost, r.leads), flag: cplFlag, total: ratioTotal('cost', 'leads') },
                { key: 'qualified', label: 'Qualified', format: 'int', total: 'sum' },
                { key: 'cpq', label: 'Cost / qualified', format: 'egp', value: r => div(r.cost, r.qualified), flag: cpqFlag },
                { key: 'booked', label: 'Booked', format: 'int', total: 'sum' },
                { key: 'ads_conversions', label: 'Google conv.', format: 'dec', total: 'sum' },
                { key: 'advice', label: 'Advice', value: advice, flag: adviceFlag }
              ]} />
          </Card>
          <Card title="What Google counts as a conversion">
            <DataTable rows={data.convActions} searchable={false} toolbar={false} defaultSort={{ key: 'conversions', dir: 'desc' }}
              columns={[
                { key: 'conversion_action', label: 'Conversion action' },
                { key: 'conversions', label: 'Conversions', format: 'dec', bar: true },
                { key: 'share', label: 'Share', format: 'pct', value: r => div(r.conversions, data.convActions.reduce((s, x) => s + x.conversions, 0)) }
              ]} />
          </Card>
        </>
      )}

      {tab === 'Leads CRM' && <LeadsCRM leads={leads} onSaved={onSaved} setupMissing={data.setupMissing} />}

      {tab === 'Tracking' && (
        <Tracking t={data.tracking} daily={data.trackingDaily} landingPages={data.landingPages}
          trafficSources={data.trafficSources} setupMissing={data.setupMissing} />
      )}

      {tab === 'Campaigns' && (
        <Card title="Campaigns" note="Budget use = average daily spend ÷ daily budget. Near 100% with low impression share and a good cost per lead → raise the budget.">
          <DataTable rows={data.campaigns} totals exportName="campaigns" defaultSort={{ key: 'cost', dir: 'desc' }} filters={[adviceFilter]}
            columns={[
              { key: 'campaign_name', label: 'Campaign' },
              { key: 'status', label: 'Status' },
              { key: 'bidding', label: 'Bidding', hidden: true },
              { key: 'budget', label: 'Budget / day', format: 'egp', total: 'sum' },
              { key: 'util', label: 'Budget use', format: 'pct', value: r => div(r.cost / days, r.budget), flag: r => { const u = div(r.cost / days, r.budget); return u == null ? null : u >= 0.9 ? 'warn' : null; } },
              { key: 'search_is', label: 'Impr. share', format: 'pct' },
              ...perfCols,
              { key: 'revenue', label: 'Revenue', format: 'egp', total: 'sum' },
              { key: 'roas', label: 'ROAS', format: 'dec', value: r => div(r.revenue, r.cost), total: ratioTotal('revenue', 'cost') },
              { key: 'advice', label: 'Advice', value: advice, flag: adviceFlag }
            ]} />
        </Card>
      )}

      {tab === 'Ad groups' && (
        <Card title="Ad groups">
          <DataTable rows={data.adgroups} totals exportName="ad-groups" defaultSort={{ key: 'cost', dir: 'desc' }}
            filters={[adviceFilter, { key: 'campaign', label: 'Campaign', value: r => r.campaign_name }]}
            columns={[
              { key: 'ad_group_name', label: 'Ad group' },
              { key: 'campaign_name', label: 'Campaign' },
              { key: 'status', label: 'Status', hidden: true },
              ...perfCols,
              { key: 'advice', label: 'Advice', value: advice, flag: adviceFlag }
            ]} />
        </Card>
      )}

      {tab === 'Keywords' && (
        <Card title="Keywords" note="Pause? = 15+ clicks with no lead and no conversion. Scale = cost per qualified lead or per lead well below the account average.">
          <DataTable rows={data.keywords} totals exportName="keywords" defaultSort={{ key: 'cost', dir: 'desc' }}
            filters={[adviceFilter, { key: 'match', label: 'Match', value: r => r.match_type }, { key: 'campaign', label: 'Campaign', value: r => r.campaign_name }]}
            columns={[
              { key: 'keyword', label: 'Keyword' },
              { key: 'match_type', label: 'Match' },
              { key: 'ad_group_name', label: 'Ad group', hidden: true },
              { key: 'campaign_name', label: 'Campaign' },
              { key: 'status', label: 'Status', hidden: true },
              { key: 'quality_score', label: 'QS', format: 'int', flag: r => (r.quality_score && r.quality_score <= 4 ? 'bad' : r.quality_score >= 8 ? 'good' : null) },
              ...perfCols,
              { key: 'advice', label: 'Advice', value: advice, flag: adviceFlag }
            ]} />
        </Card>
      )}

      {tab === 'Search terms' && (
        <Card title="Search terms (top 500 by cost)" note="Red = 3+ clicks and no conversion: candidates for negative keywords. Green = converting.">
          <DataTable rows={data.searchTerms} totals exportName="search-terms" defaultSort={{ key: 'cost', dir: 'desc' }}
            filters={[{ key: 'state', label: 'Show', value: r => (r.clicks >= 3 && !r.ads_conversions ? 'Negative candidates' : r.ads_conversions >= 1 ? 'Converting' : 'Other'), options: ['Negative candidates', 'Converting', 'Other'] }]}
            columns={[
              { key: 'search_term', label: 'Search term', flag: r => (r.clicks >= 3 && !r.ads_conversions ? 'bad' : r.ads_conversions >= 1 ? 'good' : null) },
              { key: 'keyword', label: 'Matched keyword' },
              { key: 'ad_group_name', label: 'Ad group', hidden: true },
              { key: 'campaign_name', label: 'Campaign' },
              { key: 'impressions', label: 'Impr.', format: 'int', total: 'sum' },
              { key: 'clicks', label: 'Clicks', format: 'int', total: 'sum' },
              { key: 'ctr', label: 'CTR', format: 'pct', value: r => div(r.clicks, r.impressions) },
              { key: 'cost', label: 'Cost', format: 'egp', bar: true, total: 'sum' },
              { key: 'ads_conversions', label: 'Google conv.', format: 'dec', total: 'sum' },
              { key: 'cpa', label: 'Cost / conv.', format: 'egp', value: r => div(r.cost, r.ads_conversions) }
            ]} />
        </Card>
      )}

      {tab === 'Lead sources' && (
        <>
          {channels.length > 0 && (
            <Card title="Channels" note="Leads created in the period, by how they reached you. Book rate shows which channel’s leads are worth the most follow-up time.">
              <DataTable rows={channels} searchable={false} totals exportName="channels" defaultSort={{ key: 'leads', dir: 'desc' }}
                columns={[
                  { key: 'channel', label: 'Channel' },
                  { key: 'source', label: 'Source' },
                  { key: 'leads', label: 'Leads', format: 'int', bar: true, total: 'sum' },
                  { key: 'contacted', label: 'Contacted', format: 'int', total: 'sum' },
                  { key: 'crate', label: 'Contacted %', format: 'pct', value: r => div(r.contacted, r.leads), flag: r => (div(r.contacted, r.leads) < 0.7 ? 'bad' : null), total: ratioTotal('contacted', 'leads') },
                  { key: 'booked', label: 'Booked', format: 'int', total: 'sum' },
                  { key: 'brate', label: 'Book rate', format: 'pct', value: r => div(r.booked, r.leads), total: ratioTotal('booked', 'leads') },
                  { key: 'paid', label: 'Paid', format: 'int', total: 'sum' },
                  { key: 'revenue', label: 'Revenue', format: 'egp', total: 'sum' },
                  { key: 'score', label: 'Avg score', format: 'int' }
                ]} />
            </Card>
          )}
          <Card title="Leads by source and service">
            <DataTable rows={data.leadSources} totals exportName="lead-sources" defaultSort={{ key: 'leads', dir: 'desc' }}
              filters={[{ key: 'source', label: 'Source', value: r => r.source }]}
              columns={[
                { key: 'source', label: 'Source' },
                { key: 'service', label: 'Service' },
                { key: 'leads', label: 'Leads', format: 'int', bar: true, total: 'sum' },
                { key: 'qualified', label: 'Qualified', format: 'int', total: 'sum' },
                { key: 'qrate', label: 'Qualified %', format: 'pct', value: r => div(r.qualified, r.leads), total: ratioTotal('qualified', 'leads') },
                { key: 'booked', label: 'Booked', format: 'int', total: 'sum' },
                { key: 'brate', label: 'Book rate', format: 'pct', value: r => div(r.booked, r.leads), total: ratioTotal('booked', 'leads') },
                { key: 'paid', label: 'Paid', format: 'int', total: 'sum' },
                { key: 'revenue', label: 'Revenue', format: 'egp', total: 'sum' },
                { key: 'rpl', label: 'Revenue / lead', format: 'egp', value: r => div(r.revenue, r.leads), total: ratioTotal('revenue', 'leads') }
              ]} />
          </Card>
          {data.serviceStats?.length > 0 && (
            <Card title="Services — last 180 days" note="The yardstick the lead score uses: services whose leads book more and pay more score higher.">
              <DataTable rows={data.serviceStats} totals exportName="services-180d" defaultSort={{ key: 'leads', dir: 'desc' }}
                columns={[
                  { key: 'service', label: 'Service' },
                  { key: 'leads', label: 'Leads', format: 'int', bar: true, total: 'sum' },
                  { key: 'contacted', label: 'Contacted', format: 'int', total: 'sum' },
                  { key: 'booked', label: 'Booked', format: 'int', total: 'sum' },
                  { key: 'brate', label: 'Book rate', format: 'pct', value: r => div(r.booked, r.leads), total: ratioTotal('booked', 'leads'),
                    flag: r => (r.leads < 5 || !svc.avgBookRate ? null : div(r.booked, r.leads) > svc.avgBookRate * 1.3 ? 'good' : div(r.booked, r.leads) < svc.avgBookRate * 0.5 ? 'bad' : null) },
                  { key: 'paid', label: 'Paid', format: 'int', total: 'sum' },
                  { key: 'revenue', label: 'Revenue', format: 'egp', bar: true, total: 'sum' },
                  { key: 'rpl', label: 'Revenue / lead', format: 'egp', value: r => div(r.revenue, r.leads), total: ratioTotal('revenue', 'leads') }
                ]} />
            </Card>
          )}
        </>
      )}
    </main>
  );
}
