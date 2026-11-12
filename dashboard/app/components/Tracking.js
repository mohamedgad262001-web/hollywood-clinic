'use client';
import DataTable, { formats } from './DataTable';
import { Card, Kpi } from './ui';
import { DailyBars, DailyLines } from './Charts';

const div = (a, b) => (b ? a / b : null);

export default function Tracking({ t, daily, landingPages, trafficSources, setupMissing }) {
  if (setupMissing) {
    return <div className="notice">Run <code>supabase/tracking_and_recommendations.sql</code> in the Supabase SQL Editor to turn on tracking. ({setupMissing})</div>;
  }
  if (!t || !t.visitors) {
    return (
      <Card title="Website tracking isn’t sending data yet">
        <ol className="setup">
          <li>Open <code>website/lead-source-capture.js</code> and set <code>TRACK_URL</code> to <code>https://&lt;this-dashboard&gt;/api/track</code>.</li>
          <li>Upload it to the website and add <code>&lt;script src=&quot;/lead-source-capture.js&quot; defer&gt;&lt;/script&gt;</code> before <code>&lt;/body&gt;</code> on every page.</li>
          <li>Optional: in Vercel set <code>TRACK_ALLOWED_ORIGINS=https://hollywoodclinics.net,https://www.hollywoodclinics.net</code>.</li>
          <li>Open the site, type a test mobile number in any field, then reload this tab — it appears here and in Leads CRM.</li>
        </ol>
      </Card>
    );
  }
  const actions = (t.wa_clicks || 0) + (t.call_clicks || 0) + (t.form_submits || 0);
  return (
    <>
      <section className="kpis">
        <Kpi label="Visitors" value={formats.int(t.visitors)} sub={`${formats.int(t.ad_visitors)} from Google Ads`} />
        <Kpi label="Sessions" value={formats.int(t.sessions)} sub={`${(div(t.pageviews, t.sessions) || 0).toFixed(1)} pages / session`} />
        <Kpi label="Phone numbers captured" value={formats.int(t.phone_captures)} sub={`${formats.pct(div(t.phone_captures, t.visitors))} of visitors`} accent />
        <Kpi label="WhatsApp clicks" value={formats.int(t.wa_clicks)} />
        <Kpi label="Call clicks" value={formats.int(t.call_clicks)} />
        <Kpi label="Form submits" value={formats.int(t.form_submits)} />
        <Kpi label="Contact actions / visitor" value={formats.pct(div(actions, t.visitors))} sub="WhatsApp + call + form" />
      </section>
      <div className="grid2">
        <Card title="Visitors per day"><DailyBars data={daily} dataKey="visitors" name="Visitors" /></Card>
        <Card title="Leads captured on the website per day">
          <DailyLines data={daily} series={[{ key: 'phone_captures', name: 'Phone numbers' }, { key: 'wa_clicks', name: 'WhatsApp clicks' }]} height={200} />
        </Card>
      </div>
      <Card title="Traffic sources" note="Which sources bring visitors who leave a phone number or start a WhatsApp chat.">
        <DataTable rows={trafficSources} searchable={false} exportName="traffic-sources" totals defaultSort={{ key: 'visitors', dir: 'desc' }}
          columns={[
            { key: 'source', label: 'Source' },
            { key: 'visitors', label: 'Visitors', format: 'int', bar: true, total: 'sum' },
            { key: 'phone_leads', label: 'Left phone', format: 'int', total: 'sum' },
            { key: 'rate', label: 'Phone rate', format: 'pct', value: r => div(r.phone_leads, r.visitors), total: rs => div(rs.reduce((s, r) => s + r.phone_leads, 0), rs.reduce((s, r) => s + r.visitors, 0)) },
            { key: 'wa_visitors', label: 'Opened WhatsApp', format: 'int', total: 'sum' },
            { key: 'call_visitors', label: 'Clicked call', format: 'int', total: 'sum' },
            { key: 'contact_rate', label: 'Any contact', format: 'pct', value: r => div(r.phone_leads + r.wa_visitors + r.call_visitors, r.visitors) }
          ]} />
      </Card>
      <Card title="Landing pages" note="The first page of each session. Green = above-average lead rate, red = well below (20+ sessions).">
        <LandingTable rows={landingPages} />
      </Card>
    </>
  );
}

function LandingTable({ rows }) {
  const rate = r => div(r.phone_leads + r.wa_sessions + r.call_sessions, r.sessions);
  const all = rows.reduce((a, r) => ({ s: a.s + r.sessions, c: a.c + r.phone_leads + r.wa_sessions + r.call_sessions }), { s: 0, c: 0 });
  const avg = div(all.c, all.s);
  return (
    <DataTable rows={rows} exportName="landing-pages" totals defaultSort={{ key: 'sessions', dir: 'desc' }}
      columns={[
        { key: 'landing_page', label: 'Landing page' },
        { key: 'sessions', label: 'Sessions', format: 'int', bar: true, total: 'sum' },
        { key: 'visitors', label: 'Visitors', format: 'int', total: 'sum' },
        { key: 'avg_pages', label: 'Pages / session', format: 'dec' },
        { key: 'phone_leads', label: 'Left phone', format: 'int', total: 'sum' },
        { key: 'wa_sessions', label: 'WhatsApp', format: 'int', total: 'sum' },
        { key: 'call_sessions', label: 'Call', format: 'int', total: 'sum' },
        { key: 'form_sessions', label: 'Form sent', format: 'int', total: 'sum' },
        {
          key: 'rate', label: 'Lead rate', format: 'pct', value: rate, total: () => avg,
          flag: r => (r.sessions < 20 || !avg ? null : rate(r) > avg * 1.2 ? 'good' : rate(r) < avg * 0.5 ? 'bad' : null)
        }
      ]} />
  );
}
