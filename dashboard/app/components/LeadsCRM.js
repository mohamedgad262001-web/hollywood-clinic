'use client';
import { useState } from 'react';
import DataTable, { formats } from './DataTable';
import { Card, TempBadge, StatusBadge, ScoreBar } from './ui';
import { STATUSES, normPhone, TYPED_CHANNEL } from '../../lib/recommendations';

const VIEWS = [
  { key: 'todo', label: 'To do now', test: l => l.urgency <= 2 },
  { key: 'open', label: 'Open pipeline', test: l => l.status_rank >= 0 && l.status_rank <= 2 },
  { key: 'range', label: 'Created in period', test: l => l.in_range },
  { key: 'won', label: 'Booked / paid', test: l => l.status_rank >= 3 && l.in_range },
  { key: 'all', label: 'Everything', test: () => true }
];

export default function LeadsCRM({ leads, onSaved, setupMissing }) {
  const [view, setView] = useState('todo');
  const v = VIEWS.find(x => x.key === view);
  const rows = leads.filter(v.test);

  const columns = [
    { key: 'score', label: 'Score', format: 'int', render: l => <ScoreBar score={l.score} /> },
    { key: 'temp', label: 'Temp', render: l => <TempBadge t={l.temp} /> },
    { key: 'action', label: 'Next action', flag: l => (l.urgency === 1 ? 'bad' : l.urgency === 2 ? 'warn' : null) },
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone', render: l => <Contact l={l} /> },
    { key: 'service', label: 'Service' },
    { key: 'status', label: 'Status', render: l => <StatusBadge s={l.status} /> },
    { key: 'created_at', label: 'Created', format: 'ago', value: l => l.created_at },
    { key: 'channel', label: 'Channel' },
    { key: 'source', label: 'Source' },
    { key: 'ad_keyword', label: 'Keyword' },
    { key: 'ad_campaign', label: 'Campaign', hidden: true },
    { key: 'visits', label: 'Visits', format: 'int', title: 'Website sessions' },
    { key: 'pageviews', label: 'Pages', format: 'int', hidden: true },
    { key: 'engagement', label: 'Signals', value: l => [l.wa_clicks && 'WhatsApp', l.call_clicks && 'Call', l.form_submits && 'Form'].filter(Boolean).join(' · ') },
    { key: 'last_seen', label: 'Last on site', format: 'ago', hidden: true },
    { key: 'next_follow_up', label: 'Follow-up', format: 'ago', flag: l => (l.due ? 'bad' : null) },
    { key: 'contacted_at', label: 'First contact', format: 'ago', hidden: true },
    { key: 'value', label: 'Value', format: 'egp', total: 'sum' },
    { key: 'crm_note', label: 'Note', value: l => (l.crm_note ? l.crm_note.split('\n').pop().slice(0, 60) : '') },
    { key: 'landing_page', label: 'Landing page', hidden: true },
    { key: 'device', label: 'Device', hidden: true }
  ];

  return (
    <Card title="Leads CRM"
      note="Every phone number is a lead — form, WhatsApp, Google lead form, or a number typed on the website without sending. Click a row to update it.">
      {setupMissing && <div className="notice">Lead scoring needs <code>supabase/tracking_and_recommendations.sql</code> — run it in the Supabase SQL Editor. ({setupMissing})</div>}
      <div className="chips">
        <span className="chips-label">View</span>
        {VIEWS.map(x => (
          <button key={x.key} className={view === x.key ? 'chip on' : 'chip'} onClick={() => setView(x.key)}>
            {x.label} <em>{leads.filter(x.test).length}</em>
          </button>
        ))}
      </div>
      <DataTable key={view} rows={rows} columns={columns} rowKey={l => l.lead_id} exportName={`leads-${view}`} totals
        defaultSort={view === 'todo' ? { key: 'score', dir: 'desc' } : { key: 'created_at', dir: 'desc' }}
        rowClass={l => (l.urgency === 1 ? 'row-urgent' : '')}
        filters={[
          { key: 'temp', label: 'Temperature', value: l => l.temp, options: ['Hot', 'Warm', 'Cold', 'Won', 'Lost'] },
          { key: 'status', label: 'Status', value: l => l.status },
          { key: 'source', label: 'Source', value: l => l.source },
          { key: 'channel', label: 'Channel', value: l => l.channel || 'other' }
        ]}
        empty={view === 'todo' ? 'Nothing urgent — every open lead has been handled. 🎉' : 'No leads.'}
        expand={l => <LeadEditor l={l} onSaved={onSaved} />} />
    </Card>
  );
}

function waLink(l) {
  const n = normPhone(l.phone);
  if (!n) return null;
  const first = (l.name || '').split(' ')[0];
  const msg = `مرحباً ${first} 👋 معك فريق Hollywood Clinic${l.service ? ` بخصوص استفسارك عن ${l.service}` : ''}. كيف نقدر نساعدك؟`;
  return `https://wa.me/${n}?text=${encodeURIComponent(msg)}`;
}

function Contact({ l }) {
  if (!l.phone) return '—';
  const wa = waLink(l);
  return (
    <span className="contact" dir="ltr">
      <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} title="Call">{l.phone}</a>
      {wa && <a className="wa" href={wa} target="_blank" rel="noreferrer" title="WhatsApp">WA</a>}
    </span>
  );
}

const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const stamp = () => new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function LeadEditor({ l, onSaved }) {
  const [status, setStatus] = useState(l.crm_status || l.status || 'new');
  const [note, setNote] = useState('');
  const [follow, setFollow] = useState(toLocalInput(l.next_follow_up));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save(patch) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: l.lead_id, ...patch })
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      onSaved(l.lead_id, j.lead);
      setNote('');
      setMsg({ ok: true, text: 'Saved' });
    } catch (e) {
      setMsg({ ok: false, text: String(e.message || e) });
    } finally { setBusy(false); }
  }

  const withNote = text => (text ? [l.crm_note, `[${stamp()}] ${text}`].filter(Boolean).join('\n') : l.crm_note ?? null);
  const inHours = h => new Date(Date.now() + h * 3600000).toISOString();

  return (
    <div className="editor">
      <div className="editor-info">
        <div><span className="muted small">Why this score</span><div>{l.why.length ? l.why.join(' · ') : '—'}</div></div>
        <div><span className="muted small">Source detail</span><div dir="auto">{[l.source, l.ad_campaign, l.ad_group, l.ad_keyword && `“${l.ad_keyword}”`].filter(Boolean).join(' › ') || '—'}</div></div>
        <div><span className="muted small">On the website</span><div>{l.visits ? `${l.visits} visits · ${l.pageviews || 0} pages · first ${formats.date(l.first_seen)} · landed on ${l.landing_page || '—'}` : 'Not tracked'}</div></div>
        <div><span className="muted small">Clinic</span><div>{l.sessions_booked ? `${l.sessions_booked} session(s) booked, ${l.sessions_done || 0} done` : 'No sessions yet'}{l.channel === TYPED_CHANNEL ? ' · typed phone without sending' : ''}</div></div>
        {l.crm_note && <div className="editor-notes"><span className="muted small">Notes</span><pre dir="auto">{l.crm_note}</pre></div>}
      </div>
      <div className="editor-form">
        <div className="quick">
          <button className="btn-ghost" disabled={busy} onClick={() => save({ contacted: true, crm_status: l.status_rank < 1 ? 'contacted' : l.crm_status ?? null, next_follow_up: inHours(3), crm_note: withNote('Called — no answer. WhatsApp sent.') })}>📵 No answer → retry in 3h</button>
          <button className="btn-ghost" disabled={busy} onClick={() => save({ crm_status: 'contacted', contacted: true, next_follow_up: inHours(24), crm_note: withNote('Talked — follow up tomorrow.') })}>💬 Talked → tomorrow</button>
          <button className="btn-ghost" disabled={busy} onClick={() => save({ crm_status: 'qualified', contacted: true, crm_note: withNote('Qualified — interested.') })}>⭐ Qualified</button>
          <button className="btn-ghost" disabled={busy} onClick={() => save({ crm_status: 'booked', contacted: true, next_follow_up: null, crm_note: withNote('Booked.') })}>📅 Booked</button>
          <button className="btn-ghost danger" disabled={busy} onClick={() => save({ crm_status: 'lost', next_follow_up: null, crm_note: withNote('Lost.') })}>✕ Lost</button>
        </div>
        <div className="editor-row">
          <label>Status
            <select value={status} onChange={e => setStatus(e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Next follow-up
            <input type="datetime-local" value={follow} onChange={e => setFollow(e.target.value)} />
          </label>
        </div>
        <label className="editor-note">Add note
          <textarea rows={2} dir="auto" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. asked about price, wants Saturday evening" />
        </label>
        <div className="editor-row">
          <button className="btn" disabled={busy} onClick={() => save({
            crm_status: status, next_follow_up: follow ? new Date(follow).toISOString() : null, crm_note: withNote(note.trim())
          })}>{busy ? 'Saving…' : 'Save'}</button>
          {msg && <span className={msg.ok ? 'ok-text' : 'err-text'}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
