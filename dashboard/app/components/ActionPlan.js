'use client';
import { useEffect, useState } from 'react';
import { Card, PrioBadge, Badge } from './ui';

const AREAS = ['All', 'Follow-up', 'Sales', 'Ads', 'Budget', 'Growth', 'Tracking'];

export default function ActionPlan({ plan, onGo, summary }) {
  const [area, setArea] = useState('All');
  const [done, setDone] = useState(() => new Set());
  useEffect(() => {
    try { setDone(new Set(JSON.parse(localStorage.getItem('ha_done_actions') || '[]'))); } catch {}
  }, []);
  const toggleDone = id => setDone(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem('ha_done_actions', JSON.stringify([...n])); } catch {}
    return n;
  });

  const shown = plan.actions.filter(a => area === 'All' || a.area === area);
  const counts = { high: 0, medium: 0, low: 0 };
  plan.actions.forEach(a => { if (!done.has(a.id)) counts[a.priority] += 1; });

  return (
    <>
      <div className="today">
        {summary.map(s => (
          <button key={s.label} className={'today-tile' + (s.kind ? ' today-' + s.kind : '')} onClick={() => s.tab && onGo(s.tab)}>
            <span className="today-value">{s.value}</span>
            <span className="today-label">{s.label}</span>
          </button>
        ))}
      </div>

      {plan.best.length > 0 && (
        <Card title="What’s working best">
          <div className="best-grid">
            {plan.best.map(b => (
              <div className="best" key={b.label}>
                <div className="best-label">{b.label}</div>
                <div className="best-value" dir="auto">{b.value}</div>
                <div className="muted small">{b.sub}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Your action plan"
        note="Ranked by priority. Recommendations are recalculated from your live leads and Google Ads data every time the page loads."
        right={<span className="muted small">{counts.high} high · {counts.medium} medium · {counts.low} low open</span>}>
        <div className="chips">
          {AREAS.map(a => {
            const n = a === 'All' ? plan.actions.length : plan.actions.filter(x => x.area === a).length;
            if (a !== 'All' && !n) return null;
            return <button key={a} className={area === a ? 'chip on' : 'chip'} onClick={() => setArea(a)}>{a} <em>{n}</em></button>;
          })}
        </div>
        {!shown.length && <p className="muted">Nothing to do here right now 🎉</p>}
        <div className="actions">
          {shown.map((a, i) => <Action key={a.id} a={a} startOpen={i < 2 && a.priority === 'high'} done={done.has(a.id)} onDone={() => toggleDone(a.id)} onGo={onGo} />)}
        </div>
      </Card>
    </>
  );
}

function Action({ a, startOpen, done, onDone, onGo }) {
  const [open, setOpen] = useState(!!startOpen);
  return (
    <article className={'action prio-' + a.priority + (done ? ' done' : '')}>
      <header onClick={() => setOpen(o => !o)}>
        <PrioBadge p={a.priority} />
        <Badge>{a.area}</Badge>
        <h3>{a.title}</h3>
        {a.impact && <span className="impact">{a.impact}</span>}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </header>
      {open && (
        <div className="action-body">
          <p className="why">{a.why}</p>
          <div className="action-cols">
            <div>
              <h4>What to do</h4>
              <ol>{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
            {a.items?.length > 0 && (
              <div>
                <h4>Top items</h4>
                <ul className="items">
                  {a.items.map((it, i) => <li key={i}><b dir="auto">{it.label}</b><span className="muted small" dir="auto">{it.sub}</span></li>)}
                </ul>
              </div>
            )}
          </div>
          <div className="action-foot">
            {a.tab && <button className="btn" onClick={() => onGo(a.tab)}>Open {a.tab} →</button>}
            <button className="btn-ghost" onClick={onDone}>{done ? 'Mark as not done' : '✓ Mark done'}</button>
          </div>
        </div>
      )}
    </article>
  );
}
