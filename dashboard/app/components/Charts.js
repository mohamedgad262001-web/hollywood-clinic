'use client';
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';

// categorical slots in fixed order (validated palette) + recessive axis/grid
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const AXIS = { fontSize: 11, fill: '#6b7280' };
const fmt = v => Math.round(v).toLocaleString('en-US');

const day = d => d.slice(5, 10);

/** One measure per day as bars (single y-axis) */
export function DailyBars({ data, dataKey, name, height = 200, money }) {
  const rows = data.map(d => ({ ...d, day: day(d.date) }));
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid stroke="#eceef2" vertical={false} />
          <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
          <YAxis tick={AXIS} width={money ? 56 : 32} tickFormatter={fmt} allowDecimals={false} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: 'rgba(42,120,214,.08)' }} formatter={v => (money ? 'EGP ' : '') + fmt(v)} />
          <Bar isAnimationActive={false} dataKey={dataKey} name={name} fill={SERIES[0]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Several counts per day on one axis. series: [{ key, name, dashed? }] */
export function DailyLines({ data, series, height = 220 }) {
  const rows = data.map(d => ({ ...d, day: day(d.date) }));
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eceef2" vertical={false} />
          <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
          <YAxis tick={AXIS} width={32} allowDecimals={false} tickLine={false} axisLine={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Line isAnimationActive={false} key={s.key} dataKey={s.key} name={s.name} type="monotone" dot={false} activeDot={{ r: 4 }}
              stroke={s.dashed ? '#9aa3b2' : SERIES[i]} strokeWidth={2} strokeDasharray={s.dashed ? '4 3' : undefined} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Weekday × hour grid, single-hue sequential scale */
export function Heatmap({ heat, metric = 'leads' }) {
  const max = Math.max(1, ...heat.grid.flat().map(c => c[metric]));
  const total = heat.grid.flat().reduce((s, c) => s + c[metric], 0);
  if (!total) return <p className="muted">No leads in this period yet.</p>;
  return (
    <div className="heat-wrap">
      <div className="heat" role="table" aria-label="Leads by weekday and hour (Cairo time)">
        <div className="heat-row heat-head" role="row">
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h} className="heat-h">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
        </div>
        {heat.days.map((d, i) => (
          <div className="heat-row" role="row" key={d}>
            <span className="heat-d">{d}</span>
            {heat.grid[i].map((c, h) => {
              const v = c[metric];
              const t = v / max;
              return (
                <span key={h} className="heat-cell" role="cell"
                  style={{ background: v ? `rgba(42,120,214,${0.12 + 0.88 * t})` : undefined }}
                  title={`${d} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 · ${c.leads} leads · ${c.booked} booked`} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="heat-legend muted small">
        <span>fewer</span>
        {[0.12, 0.34, 0.56, 0.78, 1].map(a => <i key={a} style={{ background: `rgba(42,120,214,${a})` }} />)}
        <span>more leads · max {max} in one hour slot · Cairo time</span>
      </div>
    </div>
  );
}

/** Horizontal funnel; widths relative to the second step (clicks are far larger, so capped) */
export function Funnel({ steps }) {
  const max = Math.max(1, steps[1] ? steps[1][1] || 0 : 0);
  return (
    <div className="funnel">
      {steps.map(([label, v], i) => {
        const prev = i > 0 ? steps[i - 1][1] : null;
        return (
          <div className="funnel-row" key={label}>
            <span className="funnel-label">{label}</span>
            <span className="funnel-bar"><span style={{ width: `${Math.min(100, ((v || 0) / max) * 100)}%` }} /></span>
            <span className="funnel-val">{(v ?? 0).toLocaleString('en-US')}{prev ? <em> {((v || 0) / prev * 100).toFixed(1)}%</em> : null}</span>
          </div>
        );
      })}
    </div>
  );
}
