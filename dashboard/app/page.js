import { loadDashboard } from '../lib/db';
import Dashboard from './components/Dashboard';

export const dynamic = 'force-dynamic';

const DAY = 86400000;
const iso = d => d.toISOString().slice(0, 10);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function Page({ searchParams }) {
  let from, to, range = null;
  if (isDate(searchParams?.from) && isDate(searchParams?.to)) {
    from = searchParams.from; to = searchParams.to;
    if (from > to) [from, to] = [to, from];
  } else {
    range = [7, 30, 90].includes(Number(searchParams?.range)) ? Number(searchParams.range) : 30;
    const yesterday = new Date(Date.now() - DAY);
    to = iso(yesterday);
    from = iso(new Date(yesterday.getTime() - (range - 1) * DAY));
  }
  // the same number of days right before, for the "vs previous period" deltas
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  const prevTo = iso(new Date(Date.parse(from) - DAY));
  const prevFrom = iso(new Date(Date.parse(from) - days * DAY));

  try {
    const data = await loadDashboard(from, to, prevFrom, prevTo);
    return <Dashboard data={data} from={from} to={to} range={range} days={days} now={Date.now()} />;
  } catch (e) {
    return (
      <main>
        <h1>Hollywood Clinic — Ads &amp; Leads</h1>
        <div className="notice">Couldn&apos;t load data: {String(e.message || e)}. Check DATABASE_URL and that schema.sql and dashboard_functions.sql were run.</div>
      </main>
    );
  }
}
