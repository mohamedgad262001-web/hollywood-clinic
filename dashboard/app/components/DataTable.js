'use client';
import { Fragment, useMemo, useState } from 'react';

const fmtNum = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));

export const formats = {
  int: v => fmtNum(v),
  dec: v => fmtNum(v, 1),
  egp: v => (v == null || !Number.isFinite(v) ? '—' : 'EGP ' + fmtNum(v)),
  pct: v => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1) + '%'),
  text: v => (v == null || v === '' ? '—' : String(v)),
  date: v => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  ago: v => {
    if (!v) return '—';
    const m = (Date.now() - Date.parse(v)) / 60000, a = Math.abs(m);
    const s = a < 60 ? Math.max(1, Math.round(a)) + 'm' : a < 1440 ? Math.round(a / 60) + 'h' : Math.round(a / 1440) + 'd';
    return m < 0 ? 'in ' + s : s + ' ago';
  }
};
const isNum = f => !!f && !['text', 'date', 'ago'].includes(f);

/**
 * columns: [{ key, label, format, value?: row => any, render?: row => node, flag?: row => 'good'|'bad'|'warn'|null,
 *             bar?: true (inline magnitude bar), total?: 'sum' | (rows) => value, hidden?: true, title? }]
 * filters: [{ key, label, value: row => string, options?: string[] }]  → one row of chips per filter
 */
export default function DataTable({
  rows, columns, defaultSort, searchable = true, pageSize = 25, empty = 'No data yet.',
  filters = [], exportName, totals = false, expand, rowKey, rowClass, toolbar = true
}) {
  const [sort, setSort] = useState(defaultSort || { key: columns[0].key, dir: 'desc' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(pageSize);
  const [hidden, setHidden] = useState(() => new Set(columns.filter(c => c.hidden).map(c => c.key)));
  const [active, setActive] = useState({});
  const [open, setOpen] = useState(null);
  const [dense, setDense] = useState(false);

  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const cols = columns.filter(c => !hidden.has(c.key));

  const filterOptions = useMemo(() => filters.map(f => {
    if (f.options) return f.options;
    const counts = {};
    for (const r of rows) { const v = f.value(r) ?? '—'; counts[v] = (counts[v] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v]) => v);
  }), [rows, filters]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      for (const f of filters) if (active[f.key] != null && String(f.value(r) ?? '—') !== active[f.key]) return false;
      if (!needle) return true;
      return columns.some(c => String(valueOf(c, r) ?? '').toLowerCase().includes(needle));
    });
  }, [rows, columns, filters, active, q]);

  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort.key) || columns[0];
    return [...filtered].sort((a, b) => {
      const x = valueOf(col, a), y = valueOf(col, b);
      const nx = x == null || x === '' || (typeof x === 'number' && !Number.isFinite(x));
      const ny = y == null || y === '' || (typeof y === 'number' && !Number.isFinite(y));
      if (nx && ny) return 0; if (nx) return 1; if (ny) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? r : -r;
    });
  }, [filtered, columns, sort]);

  const maxima = useMemo(() => {
    const m = {};
    for (const c of columns) if (c.bar) m[c.key] = Math.max(0, ...filtered.map(r => Number(valueOf(c, r)) || 0));
    return m;
  }, [filtered, columns]);

  const totalRow = useMemo(() => {
    if (!totals) return null;
    const t = {};
    for (const c of columns) {
      if (c.total === 'sum') t[c.key] = filtered.reduce((s, r) => s + (Number(valueOf(c, r)) || 0), 0);
      else if (typeof c.total === 'function') t[c.key] = c.total(filtered);
    }
    return t;
  }, [filtered, columns, totals]);

  if (!rows.length) return <p className="muted">{empty}</p>;

  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const pg = Math.min(page, pages - 1);
  const shown = sorted.slice(pg * size, pg * size + size);

  const exportCsv = () => {
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map(c => esc(c.label)).join(',')];
    for (const r of sorted) lines.push(cols.map(c => { const v = valueOf(c, r); return esc(typeof v === 'number' ? Math.round(v * 100) / 100 : v); }).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${exportName || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggleSort = key => { setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' })); setPage(0); };

  return (
    <div className="dt">
      {toolbar && (
        <div className="dt-toolbar">
          {searchable && <input className="search" placeholder="Search…" value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />}
          <span className="muted small dt-count">{sorted.length === rows.length ? `${rows.length} rows` : `${sorted.length} of ${rows.length}`}</span>
          <span className="dt-spacer" />
          <details className="dt-menu">
            <summary>Columns</summary>
            <div className="dt-menu-body">
              {columns.map(c => (
                <label key={c.key}>
                  <input type="checkbox" checked={!hidden.has(c.key)}
                    onChange={() => setHidden(h => { const n = new Set(h); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; })} />
                  {c.label}
                </label>
              ))}
            </div>
          </details>
          <button className="btn-ghost" onClick={() => setDense(d => !d)} title="Row density">{dense ? 'Comfortable' : 'Compact'}</button>
          <button className="btn-ghost" onClick={exportCsv}>Export CSV</button>
        </div>
      )}
      {filters.map((f, i) => (
        <div className="chips" key={f.key}>
          <span className="chips-label">{f.label}</span>
          <button className={active[f.key] == null ? 'chip on' : 'chip'} onClick={() => { setActive(a => ({ ...a, [f.key]: null })); setPage(0); }}>All</button>
          {filterOptions[i].map(o => (
            <button key={o} className={active[f.key] === o ? 'chip on' : 'chip'} onClick={() => { setActive(a => ({ ...a, [f.key]: a[f.key] === o ? null : o })); setPage(0); }}>{o}</button>
          ))}
        </div>
      ))}
      <div className="table-wrap">
        <table className={dense ? 'dense' : ''}>
          <thead>
            <tr>
              {expand && <th className="dt-exp" />}
              {cols.map(c => (
                <th key={c.key} className={isNum(c.format) ? 'num' : ''} title={c.title} onClick={() => toggleSort(c.key)}>
                  {c.label}<span className="sort">{sort.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const key = rowKey ? rowKey(r) : pg * size + i;
              const isOpen = expand && open === key;
              return (
                <Fragment key={key}>
                  <tr className={(rowClass ? rowClass(r) || '' : '') + (expand ? ' clickable' : '') + (isOpen ? ' open' : '')}
                    onClick={expand ? e => { if (!e.target.closest('a,button,input,select,textarea')) setOpen(o => (o === key ? null : key)); } : undefined}>
                    {expand && <td className="dt-exp">{isOpen ? '▾' : '▸'}</td>}
                    {cols.map(c => {
                      const v = valueOf(c, r);
                      const flag = c.flag ? c.flag(r) : null;
                      const numeric = isNum(c.format);
                      const content = c.render ? c.render(r) : formats[c.format || 'text'](v);
                      return (
                        <td key={c.key} suppressHydrationWarning dir={numeric ? 'ltr' : 'auto'} className={(numeric ? 'num ' : '') + (flag ? 'flag-' + flag : '')}>
                          {c.bar && maxima[c.key] > 0 && Number(v) > 0
                            ? <span className="cellbar"><span style={{ width: `${(Number(v) / maxima[c.key]) * 100}%` }} /><b>{content}</b></span>
                            : content}
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && (
                    <tr className="dt-detail"><td colSpan={cols.length + 1}>{expand(r)}</td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {totalRow && (
            <tfoot>
              <tr>
                {expand && <td />}
                {cols.map((c, i) => (
                  <td key={c.key} className={isNum(c.format) ? 'num' : ''}>
                    {i === 0 ? `Total (${sorted.length})` : totalRow[c.key] != null ? formats[c.format || 'text'](totalRow[c.key]) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {sorted.length > size && (
        <div className="dt-pager">
          <button className="btn-ghost" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹ Prev</button>
          <span className="muted small">Page {pg + 1} of {pages}</span>
          <button className="btn-ghost" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next ›</button>
          <select value={size} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}>
            {[10, 25, 50, 100, 500].map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
