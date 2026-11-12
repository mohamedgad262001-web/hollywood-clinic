'use client';

/** cur/prev → "▲ 12%" coloured by whether that direction is good */
export function Kpi({ label, value, sub, cur, prev, good = 'up', muted, accent }) {
  let delta = null;
  if (prev != null && cur != null && Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0) {
    const d = (cur - prev) / Math.abs(prev);
    if (Math.abs(d) >= 0.005) {
      const isGood = good === 'up' ? d > 0 : d < 0;
      delta = <span className={'delta ' + (good === 'none' ? 'flat' : isGood ? 'up' : 'down')} title="vs the previous period of the same length">{d > 0 ? '▲' : '▼'} {Math.abs(d * 100).toFixed(0)}%</span>;
    }
  }
  return (
    <div className={'kpi' + (muted ? ' kpi-muted' : '') + (accent ? ' kpi-accent' : '')}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{delta}{sub && <span>{sub}</span>}</div>
    </div>
  );
}

export function Card({ title, note, right, children, className = '' }) {
  return (
    <section className={'card ' + className}>
      {(title || right) && (
        <div className="card-head">
          <h2>{title}</h2>
          {right}
        </div>
      )}
      {note && <p className="muted small">{note}</p>}
      {children}
    </section>
  );
}

const TEMP = { Hot: 'bad', Warm: 'warn', Cold: 'neutral', Won: 'good', Lost: 'neutral' };
const STATUS = { new: 'info', contacted: 'neutral', qualified: 'warn', booked: 'good', showed: 'good', paid: 'good', lost: 'neutral' };
const PRIO = { high: 'bad', medium: 'warn', low: 'neutral' };

export function Badge({ kind = 'neutral', children, title }) {
  return <span className={'badge badge-' + kind} title={title}>{children}</span>;
}
export const TempBadge = ({ t }) => <Badge kind={TEMP[t]}>{t === 'Hot' ? '🔥 ' : ''}{t}</Badge>;
export const StatusBadge = ({ s }) => <Badge kind={STATUS[s] || 'neutral'}>{s || 'new'}</Badge>;
export const PrioBadge = ({ p }) => <Badge kind={PRIO[p]}>{p}</Badge>;

export function ScoreBar({ score }) {
  const kind = score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cold';
  return (
    <span className={'score score-' + kind} title="Lead score 0–100">
      <span className="score-track"><span style={{ width: `${score}%` }} /></span>
      <b>{score}</b>
    </span>
  );
}
