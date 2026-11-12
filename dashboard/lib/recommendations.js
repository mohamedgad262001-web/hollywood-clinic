// Recommendation engine: lead scoring, next best action per lead, and the ranked action plan.
// Pure functions (no I/O) so the plan recalculates instantly when the team updates a lead.

const HOUR = 3600000;
const div = (a, b) => (b ? a / b : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const egp = v => (v == null || !Number.isFinite(v) ? '—' : 'EGP ' + Math.round(v).toLocaleString('en-US'));
const pct = v => (v == null || !Number.isFinite(v) ? '—' : Math.round(v * 100) + '%');
const sum = (rows, k) => rows.reduce((s, r) => s + (Number(typeof k === 'function' ? k(r) : r[k]) || 0), 0);

export const STATUSES = ['new', 'contacted', 'qualified', 'booked', 'showed', 'paid', 'lost'];
export const RANK = { new: 0, contacted: 1, qualified: 2, booked: 3, showed: 4, paid: 5, lost: -1 };
export const TYPED_CHANNEL = 'website (phone typed)';

/** Egyptian phone → 20XXXXXXXXXX (same rule as ha_norm_phone in SQL) */
export function normPhone(raw) {
  const d = String(raw || '').replace(/[٠-٩]/g, c => c.charCodeAt(0) - 1632).replace(/\D/g, '');
  const m = d.match(/^(?:20|0)*(1\d{9})$/);
  if (m) return '20' + m[1];
  if (d.startsWith('00')) return d.slice(2);
  return d || null;
}

/** Service yardsticks from ha_dash_service_stats (180 days) */
export function serviceIndex(stats = []) {
  const map = {};
  let leads = 0, booked = 0, maxRevPerLead = 0;
  for (const s of stats) {
    const rec = { ...s, bookRate: div(s.booked, s.leads), revPerLead: div(s.revenue, s.leads) };
    map[s.service] = rec;
    leads += s.leads; booked += s.booked;
    if (s.leads >= 3 && rec.revPerLead > maxRevPerLead) maxRevPerLead = rec.revPerLead;
  }
  return { map, avgBookRate: div(booked, leads), maxRevPerLead };
}

/**
 * Score 0–100 = how likely and how valuable this lead is right now, plus what to do next.
 * Inputs: recency, service's historic booking rate & revenue, source, website engagement, CRM status, due follow-ups.
 */
export function scoreLead(l, svc, now = Date.now()) {
  const rank = l.status_rank ?? RANK[l.status] ?? 0;
  const ageH = (now - Date.parse(l.created_at)) / HOUR;
  const due = !!l.next_follow_up && Date.parse(l.next_follow_up) <= now;
  const why = [];
  let s = 0;

  if (ageH < 1) { s += 25; why.push('arrived < 1h ago'); }
  else if (ageH < 24) { s += 18; why.push('today'); }
  else if (ageH < 72) s += 10;
  else if (ageH < 168) s += 5;

  const st = svc.map[l.service || '(not set)'];
  if (st && st.leads >= 3) {
    const rel = svc.avgBookRate ? (st.bookRate || 0) / svc.avgBookRate : 1;
    s += Math.round(Math.min(15, 7.5 * rel));
    if (svc.maxRevPerLead) s += Math.round(10 * (st.revPerLead || 0) / svc.maxRevPerLead);
    if (rel >= 1.3) why.push('service books well');
  } else s += 8;

  s += { google: 10, referral: 10, organic: 8, meta: 6, social: 5 }[l.source] ?? 4;
  if (l.ad_keyword) s += 2;

  if (l.visits > 1) { s += 8; why.push(`${l.visits} visits`); }
  if (l.pageviews >= 4) { s += 5; why.push(`${l.pageviews} pages`); }
  if (l.wa_clicks) { s += 6; why.push('clicked WhatsApp'); }
  if (l.call_clicks) { s += 6; why.push('clicked call'); }
  if (l.form_submits) s += 4;
  if (l.channel === TYPED_CHANNEL) { s += 5; why.push('typed phone, did not send'); }

  if (rank === 2) s += 12; else if (rank === 1) s += 4;
  if (due) { s += 10; why.push('follow-up due'); }

  const score = rank < 0 ? 0 : clamp(Math.round(s), 0, 100);
  const temp = rank < 0 ? 'Lost' : rank >= 3 ? 'Won' : score >= 70 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold';

  let action, urgency;
  if (rank < 0) { action = '—'; urgency = 9; }
  else if (rank >= 5) { action = 'Ask for a review · offer next session'; urgency = 6; }
  else if (rank === 4) { action = 'Collect payment · offer a package'; urgency = 5; }
  else if (rank === 3) { action = 'Send appointment reminder'; urgency = 4; }
  else if (due) { action = 'Follow-up due — call now'; urgency = 1; }
  else if (rank === 2) { action = 'Book the appointment now'; urgency = 1; }
  else if (rank === 0 && l.channel === TYPED_CHANNEL && ageH < 72) { action = 'Call — typed phone but didn’t send'; urgency = 1; }
  else if (rank === 0 && ageH < 24) { action = 'Call now — fresh lead'; urgency = 1; }
  else if (rank === 0 && ageH < 72) { action = 'Call + WhatsApp today'; urgency = 2; }
  else if (rank === 0) { action = 'WhatsApp re-engagement offer'; urgency = 3; }
  else if (ageH > 48) { action = 'Send offer & propose a time slot'; urgency = 2; }
  else { action = 'Follow up within 24h'; urgency = 2; }

  return { ...l, score, temp, action, urgency, why, ageH, due };
}

/** Lead counts by Cairo weekday × hour */
const DOW = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export function leadHeatmap(leads) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const grid = DOW.map(() => Array.from({ length: 24 }, () => ({ leads: 0, booked: 0 })));
  for (const l of leads) {
    const parts = fmt.formatToParts(new Date(l.created_at));
    const wd = DOW.indexOf(parts.find(p => p.type === 'weekday')?.value);
    const h = Number(parts.find(p => p.type === 'hour')?.value) % 24;
    if (wd < 0 || Number.isNaN(h)) continue;
    grid[wd][h].leads += 1;
    if ((l.status_rank ?? 0) >= 3) grid[wd][h].booked += 1;
  }
  return { days: DOW, grid };
}

function bestWindow(heat) {
  // best 3-hour window across the week, and the best weekday
  const byHour = Array.from({ length: 24 }, (_, h) => heat.grid.reduce((s, row) => s + row[h].leads, 0));
  let best = 0, bestH = 0;
  for (let h = 0; h < 24; h++) {
    const v = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
    if (v > best) { best = v; bestH = h; }
  }
  const byDay = heat.grid.map(row => row.reduce((s, c) => s + c.leads, 0));
  const total = byDay.reduce((a, b) => a + b, 0);
  const d = byDay.indexOf(Math.max(...byDay));
  const hh = h => String(h % 24).padStart(2, '0') + ':00';
  return { total, window: `${hh(bestH)}–${hh(bestH + 3)}`, windowShare: div(best, total), day: heat.days[d], dayShare: div(byDay[d], total) };
}

const list = (rows, label, sub, n = 8) => rows.slice(0, n).map(r => ({ label: label(r), sub: sub(r) }));

/**
 * The action plan: every recommendation is { id, priority: 'high'|'medium'|'low', area, title, why, steps[], impact, items[], tab }
 * plus `best`: what is working best right now.
 */
export function buildPlan(d) {
  const { kpis: k = {}, prevKpis, campaigns = [], keywords = [], searchTerms = [], leads = [], svc, tracking,
    landingPages = [], days = 30, heat } = d;
  const actions = [];
  const best = [];
  const add = a => actions.push(a);
  const now = Date.now();
  const cost = k.cost || 0;

  const open = leads.filter(l => l.status_rank >= 0 && l.status_rank <= 2);
  const inRange = leads.filter(l => l.in_range);
  const person = l => `${l.name || 'No name'} · ${l.phone || ''}`;
  const meta = l => [l.service, l.source, l.ad_keyword && `“${l.ad_keyword}”`].filter(Boolean).join(' · ');

  // ── Follow-up (money already paid for, waiting on a call) ──
  const fresh = open.filter(l => l.status_rank === 0 && l.ageH < 24 && l.channel !== TYPED_CHANNEL).sort((a, b) => b.score - a.score);
  if (fresh.length) add({
    id: 'fresh', priority: 'high', area: 'Follow-up', tab: 'Leads CRM',
    title: `Call ${fresh.length} new lead${fresh.length > 1 ? 's' : ''} from the last 24 hours`,
    why: 'Leads called within 5 minutes book several times more often than leads called after an hour. Every hour of delay costs bookings.',
    steps: ['Call in score order (highest first)', 'No answer → send the WhatsApp template and set a follow-up for 2 hours later', 'Mark each one as contacted in Leads CRM'],
    impact: `${fresh.length} warm leads`, items: list(fresh, person, l => `score ${l.score} · ${meta(l)}`)
  });

  const typed = open.filter(l => l.status_rank === 0 && l.channel === TYPED_CHANNEL && l.ageH < 72).sort((a, b) => b.score - a.score);
  if (typed.length) add({
    id: 'typed', priority: 'high', area: 'Follow-up', tab: 'Leads CRM',
    title: `${typed.length} visitor${typed.length > 1 ? 's' : ''} typed a phone number but didn’t send the form`,
    why: 'They were interested enough to start — something stopped them (price doubt, a question, distraction). A quick call recovers many of them.',
    steps: ['Call: “We saw you were asking about … — can I help you book?”', 'Offer the next available slot', 'If the same form is often left unfinished, shorten it'],
    impact: `${typed.length} recoverable leads`, items: list(typed, person, l => `score ${l.score} · ${l.landing_page || meta(l)}`)
  });

  const dueList = open.filter(l => l.due).sort((a, b) => Date.parse(a.next_follow_up) - Date.parse(b.next_follow_up));
  if (dueList.length) add({
    id: 'due', priority: 'high', area: 'Follow-up', tab: 'Leads CRM',
    title: `${dueList.length} follow-up${dueList.length > 1 ? 's are' : ' is'} due`,
    why: 'You promised these people a call back. Missing it is the fastest way to lose a warm lead.',
    steps: ['Call each one now', 'Update status and set the next follow-up'],
    impact: `${dueList.length} promised calls`, items: list(dueList, person, l => `due ${new Date(l.next_follow_up).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`)
  });

  const qualified = open.filter(l => l.status_rank === 2 && !l.due).sort((a, b) => b.score - a.score);
  if (qualified.length) add({
    id: 'qualified', priority: 'high', area: 'Sales', tab: 'Leads CRM',
    title: `${qualified.length} qualified lead${qualified.length > 1 ? 's' : ''} not booked yet`,
    why: 'They are interested and fit — the only missing step is a date. These are the closest to revenue.',
    steps: ['Offer two concrete time slots (not “when suits you?”)', 'Send the location pin and price on WhatsApp', 'Set a follow-up for tomorrow if they hesitate'],
    impact: `${qualified.length} near-bookings`, items: list(qualified, person, meta)
  });

  const stale = open.filter(l => l.status_rank === 0 && l.ageH >= 72 && !l.due);
  if (stale.length) add({
    id: 'stale', priority: stale.length >= 10 ? 'high' : 'medium', area: 'Follow-up', tab: 'Leads CRM',
    title: `${stale.length} lead${stale.length > 1 ? 's were' : ' was'} never contacted (3+ days old)`,
    why: `You paid for these leads (≈ ${egp(div(cost, k.google_leads))} each from Google) and nobody has reached them yet.`,
    steps: ['Send one WhatsApp re-engagement message with a limited-time offer', 'Mark non-responders as lost after 2 attempts so the list stays clean', 'Check who is responsible for first contact — this should be zero'],
    impact: `≈ ${egp(stale.length * (div(cost, k.google_leads) || 0))} of lead cost at risk`,
    items: list(stale.sort((a, b) => b.score - a.score), person, l => `${Math.round(l.ageH / 24)} days · ${meta(l)}`)
  });

  // Speed to lead
  const contactedTimes = inRange.filter(l => l.contacted_at).map(l => (Date.parse(l.contacted_at) - Date.parse(l.created_at)) / HOUR).filter(h => h >= 0).sort((a, b) => a - b);
  if (contactedTimes.length >= 5) {
    const med = contactedTimes[Math.floor(contactedTimes.length / 2)];
    if (med > 1) add({
      id: 'speed', priority: med > 4 ? 'high' : 'medium', area: 'Sales',
      title: `Typical time to first contact is ${med < 24 ? med.toFixed(1) + ' hours' : Math.round(med / 24) + ' days'}`,
      why: 'Target is under 15 minutes during working hours. Slow first contact is the most common reason paid leads don’t book.',
      steps: ['Turn on instant notifications for new leads (Telegram/WhatsApp)', 'Assign one person per shift to new leads only', 'Use the “Call now” list in Leads CRM'],
      impact: 'Higher lead → booking rate', items: []
    });
  }

  // Booking rate
  const gl = k.google_leads || 0;
  const bookRate = div(k.booked, gl);
  if (gl >= 10 && bookRate != null && bookRate < 0.2) add({
    id: 'bookrate', priority: 'high', area: 'Sales',
    title: `Only ${pct(bookRate)} of Google leads book an appointment`,
    why: `A healthy clinic converts 25–40% of real leads. Before raising ad spend, fixing follow-up gives more bookings for the same ${egp(cost)}.`,
    steps: ['Review 10 lost leads: why didn’t they book? (price, location, no answer, just asking)', 'Write a short call script with the top 3 objections answered', 'Track every outcome in Leads CRM so this number can be trusted'],
    impact: `Each +10 pts ≈ +${Math.round(gl * 0.1)} bookings / period`, items: []
  });

  // ── Ads: waste, scale, negatives, quality ──
  const avgCpl = div(cost, k.google_leads);
  const avgCpq = div(cost, k.qualified);
  const tracking_ok = gl > 0;

  const pause = keywords.filter(r => r.clicks >= 15 && !r.leads && (r.ads_conversions || 0) < 1).sort((a, b) => b.cost - a.cost);
  if (pause.length) {
    const waste = sum(pause, 'cost');
    add({
      id: 'pause', priority: waste > cost * 0.05 ? 'high' : 'medium', area: 'Ads', tab: 'Keywords',
      title: `Pause or fix ${pause.length} keyword${pause.length > 1 ? 's' : ''} with clicks but no leads`,
      why: `${egp(waste)} (${pct(div(waste, cost))} of spend) went to keywords with 15+ clicks and not a single lead or conversion.`,
      steps: ['Pause the top ones, or switch broad → phrase match', 'Check their search terms for irrelevant queries', 'Check the landing page matches the keyword'],
      impact: `Save ≈ ${egp(waste / days * 30)} / month`, items: list(pause, r => r.keyword, r => `${egp(r.cost)} · ${r.clicks} clicks · ${r.campaign_name}`)
    });
  }

  const scale = keywords.filter(r => tracking_ok
    ? (r.qualified >= 2 && avgCpq && r.cost / r.qualified < avgCpq * 0.8) || (r.leads >= 3 && avgCpl && r.cost / r.leads < avgCpl * 0.7)
    : (r.ads_conversions >= 2 && k.ads_conversions && r.cost / r.ads_conversions < (cost / k.ads_conversions) * 0.7))
    .sort((a, b) => (div(a.cost, a.leads || a.ads_conversions) || 1e9) - (div(b.cost, b.leads || b.ads_conversions) || 1e9));
  if (scale.length) add({
    id: 'scale', priority: 'medium', area: 'Ads', tab: 'Keywords',
    title: `Scale ${scale.length} keyword${scale.length > 1 ? 's' : ''} that bring leads cheaply`,
    why: `These bring leads well below your average cost (${egp(tracking_ok ? avgCpl : div(cost, k.ads_conversions))}). More budget here = more leads at the same cost.`,
    steps: ['Raise bids 15–20% (or the target CPA) on these', 'Make sure their campaign is not limited by budget', 'Add close variants as new phrase/exact keywords'],
    impact: 'More leads at below-average cost',
    items: list(scale, r => r.keyword, r => tracking_ok ? `${r.leads} leads · ${egp(div(r.cost, r.leads))}/lead · ${r.qualified} qualified` : `${r.ads_conversions} conv. · ${egp(div(r.cost, r.ads_conversions))} each`)
  });

  const negatives = searchTerms.filter(r => r.clicks >= 3 && !r.ads_conversions).sort((a, b) => b.cost - a.cost);
  if (negatives.length) {
    const waste = sum(negatives, 'cost');
    add({
      id: 'negatives', priority: waste > cost * 0.05 ? 'high' : 'medium', area: 'Ads', tab: 'Search terms',
      title: `Review ${negatives.length} search terms for negative keywords`,
      why: `${egp(waste)} went to searches with 3+ clicks and no conversion. Irrelevant ones (jobs, free, courses, other cities, DIY) should be negatives.`,
      steps: ['Open Search terms tab → red rows', 'Add irrelevant words as negative keywords (phrase match) at account level', 'Repeat weekly'],
      impact: `Up to ${egp(waste / days * 30)} / month`, items: list(negatives, r => r.search_term, r => `${egp(r.cost)} · ${r.clicks} clicks`)
    });
  }

  const lowQs = keywords.filter(r => r.quality_score && r.quality_score <= 4 && r.cost > cost * 0.02).sort((a, b) => b.cost - a.cost);
  if (lowQs.length) add({
    id: 'qs', priority: 'low', area: 'Ads', tab: 'Keywords',
    title: `${lowQs.length} keyword${lowQs.length > 1 ? 's have' : ' has'} Quality Score ≤ 4`,
    why: 'Low Quality Score means you pay more per click than competitors for the same position.',
    steps: ['Put the keyword in the ad headline', 'Send it to a page about exactly that service', 'Split it into its own ad group if it shares one with unrelated keywords'],
    impact: 'Lower CPC', items: list(lowQs, r => r.keyword, r => `QS ${r.quality_score} · ${egp(r.cost)}`)
  });

  // ── Budget ──
  for (const c of campaigns) {
    const daily = c.cost / days;
    const util = div(daily, c.budget);
    const cpl = div(c.cost, c.leads);
    const good = tracking_ok ? (c.leads >= 3 && avgCpl && cpl <= avgCpl) : (c.ads_conversions >= 3 && k.ads_conversions && c.cost / c.ads_conversions <= cost / k.ads_conversions);
    if (good && util >= 0.85 && (c.search_is == null || c.search_is < 0.8)) add({
      id: 'budget-up-' + c.campaign_id, priority: 'medium', area: 'Budget', tab: 'Campaigns',
      title: `Raise the budget of “${c.campaign_name}”`,
      why: `It spends ${pct(util)} of its daily budget and shows for only ${pct(c.search_is)} of searches, while its cost per lead (${egp(tracking_ok ? cpl : div(c.cost, c.ads_conversions))}) is at or below average.`,
      steps: [`Increase daily budget from ${egp(c.budget)} to ≈ ${egp(c.budget * 1.25)}`, 'Re-check cost per lead after 7 days'],
      impact: 'More leads at the same cost per lead', items: []
    });
    const bad = tracking_ok && c.cost > cost * 0.1 && ((c.leads === 0) || (avgCpl && cpl > avgCpl * 1.5));
    if (bad) add({
      id: 'budget-down-' + c.campaign_id, priority: c.leads === 0 ? 'high' : 'medium', area: 'Budget', tab: 'Campaigns',
      title: c.leads === 0 ? `“${c.campaign_name}” spent ${egp(c.cost)} with no real leads` : `“${c.campaign_name}” costs ${pct(div(cpl, avgCpl) - 1)} more per lead than average`,
      why: `It takes ${pct(div(c.cost, cost))} of spend. Moving part of it to campaigns with cheaper leads gives more leads for the same money.`,
      steps: ['Cut its budget 20–30%', 'Review its keywords and search terms', 'Move the saved budget to the best campaign'],
      impact: `≈ ${egp(c.cost * 0.25 / days * 30)} / month to re-invest`, items: []
    });
  }

  // ── Tracking health ──
  const unknown = inRange.filter(l => ['unknown', 'website'].includes(l.source)).length;
  if (inRange.length >= 10 && unknown / inRange.length > 0.3) add({
    id: 'unknown', priority: 'medium', area: 'Tracking',
    title: `${pct(unknown / inRange.length)} of leads have no known source`,
    why: 'Without the source you cannot tell which ads pay off, so budget decisions are guesses.',
    steps: ['Make sure lead-source-capture.js is on every page', 'Check Google Ads auto-tagging is ON', 'Pass the [ref: …] code from WhatsApp into the lead'],
    impact: 'Reliable cost per lead', items: []
  });
  if (!tracking || !tracking.visitors) add({
    id: 'tracking', priority: 'medium', area: 'Tracking',
    title: 'Turn on website visitor tracking',
    why: 'Tracking turns every phone number typed on the site into a lead (even without submitting) and shows which pages and sources produce leads.',
    steps: ['Set TRACK_URL in website/lead-source-capture.js to this dashboard’s /api/track', 'Upload it and add the script tag before </body> on every page', 'Visit the site, type a test number, and check the Tracking tab'],
    impact: 'Capture abandoned leads', items: []
  });
  const paidNoValue = inRange.filter(l => l.status_rank >= 5 && !l.value).length;
  if (paidNoValue >= 3) add({
    id: 'value', priority: 'low', area: 'Tracking',
    title: `${paidNoValue} paid leads have no amount`,
    why: 'Revenue and ROAS are understated, so profitable campaigns look worse than they are.',
    steps: ['Make sure the clinic “Done” webhook sends the net amount', 'Or enter the value on the lead'],
    impact: 'True ROAS', items: []
  });

  // ── What’s working best ──
  const svcRows = Object.values(svc.map).filter(s => s.leads >= 5 && s.service !== '(not set)');
  const bestSvc = [...svcRows].sort((a, b) => (b.bookRate || 0) - (a.bookRate || 0))[0];
  const topRevSvc = [...svcRows].sort((a, b) => (b.revPerLead || 0) - (a.revPerLead || 0))[0];
  const worstSvc = [...svcRows].sort((a, b) => (a.bookRate || 0) - (b.bookRate || 0))[0];
  if (bestSvc) best.push({ label: 'Best-booking service', value: bestSvc.service, sub: `${pct(bestSvc.bookRate)} of ${bestSvc.leads} leads book` });
  if (topRevSvc && topRevSvc.revPerLead) best.push({ label: 'Most revenue per lead', value: topRevSvc.service, sub: `${egp(topRevSvc.revPerLead)} per lead` });
  if (topRevSvc && topRevSvc.revPerLead && svc.avgBookRate) add({
    id: 'svc-push', priority: 'medium', area: 'Growth',
    title: `Push “${topRevSvc.service}” harder`,
    why: `It earns ${egp(topRevSvc.revPerLead)} per lead and ${pct(topRevSvc.bookRate)} of its leads book (clinic average ${pct(svc.avgBookRate)}).`,
    steps: ['Give its campaign/ad group budget priority', 'Make sure it has its own landing page and ad copy', 'Mention it in follow-up messages to leads of related services'],
    impact: 'Highest value per lead', items: []
  });
  if (worstSvc && bestSvc && worstSvc !== bestSvc && (worstSvc.bookRate || 0) < (svc.avgBookRate || 0) * 0.5) add({
    id: 'svc-weak', priority: 'low', area: 'Growth',
    title: `“${worstSvc.service}” leads rarely book (${pct(worstSvc.bookRate)})`,
    why: 'Either the price/offer doesn’t match what the ads promise, or these leads need a different follow-up.',
    steps: ['Listen to 5 calls with these leads', 'Show price range in the ad to filter out bargain hunters, or create a special offer'],
    impact: 'Less wasted follow-up time', items: []
  });

  const kwBest = keywords.filter(r => r.leads >= 2).sort((a, b) => div(a.cost, a.leads) - div(b.cost, b.leads))[0];
  if (kwBest) best.push({ label: 'Cheapest lead keyword', value: kwBest.keyword, sub: `${kwBest.leads} leads · ${egp(div(kwBest.cost, kwBest.leads))} each` });
  const campBest = campaigns.filter(c => c.leads >= 2).sort((a, b) => div(a.cost, a.leads) - div(b.cost, b.leads))[0];
  if (campBest) best.push({ label: 'Best campaign', value: campBest.campaign_name, sub: `${egp(div(campBest.cost, campBest.leads))} per lead · ${campBest.booked} booked` });

  const byCh = {};
  for (const l of inRange) {
    const key = l.channel || 'other';
    byCh[key] = byCh[key] || { n: 0, b: 0 };
    byCh[key].n += 1; if (l.status_rank >= 3) byCh[key].b += 1;
  }
  const chBest = Object.entries(byCh).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].b / b[1].n - a[1].b / a[1].n)[0];
  if (chBest) best.push({ label: 'Best-booking channel', value: chBest[0], sub: `${pct(chBest[1].b / chBest[1].n)} of ${chBest[1].n} leads book` });

  if (heat) {
    const w = bestWindow(heat);
    if (w.total >= 15) {
      best.push({ label: 'Peak lead time (Cairo)', value: `${w.day} · ${w.window}`, sub: `${pct(w.windowShare)} of leads arrive in this 3-hour window` });
      add({
        id: 'hours', priority: 'low', area: 'Growth',
        title: `Most leads arrive ${w.window} and on ${w.day}s`,
        why: `${pct(w.windowShare)} of leads come in that 3-hour window and ${pct(w.dayShare)} on ${w.day}s.`,
        steps: ['Have someone answering calls/WhatsApp in that window', 'In Google Ads, add a +10–20% bid adjustment for those hours (ad schedule)', 'Consider lower bids in hours with almost no leads'],
        impact: 'Faster replies at peak, cheaper clicks off-peak', items: []
      });
    }
  }

  const lpBest = landingPages.filter(r => r.sessions >= 20).map(r => ({ ...r, rate: div(r.phone_leads + r.wa_sessions, r.sessions) })).sort((a, b) => b.rate - a.rate);
  if (lpBest.length) {
    best.push({ label: 'Best landing page', value: lpBest[0].landing_page, sub: `${pct(lpBest[0].rate)} of sessions leave a phone or open WhatsApp` });
    const worst = lpBest[lpBest.length - 1];
    if (lpBest.length >= 3 && worst.rate < lpBest[0].rate * 0.4 && worst.sessions >= 50) add({
      id: 'lp', priority: 'medium', area: 'Growth', tab: 'Tracking',
      title: `Landing page ${worst.landing_page} converts poorly`,
      why: `Only ${pct(worst.rate)} of its ${worst.sessions} sessions leave a phone or open WhatsApp, vs ${pct(lpBest[0].rate)} on ${lpBest[0].landing_page}.`,
      steps: ['Copy what works from the best page (headline, offer, WhatsApp button above the fold)', 'Point ads to the best-converting page for the same service'],
      impact: 'More leads from the same traffic', items: []
    });
  }

  // Period comparison headline
  if (prevKpis && prevKpis.google_leads && gl) {
    const prevCpl = div(prevKpis.cost, prevKpis.google_leads);
    if (avgCpl && prevCpl && avgCpl > prevCpl * 1.25) add({
      id: 'cpl-up', priority: 'medium', area: 'Ads',
      title: `Cost per lead rose ${pct(avgCpl / prevCpl - 1)} vs the previous period`,
      why: `${egp(prevCpl)} → ${egp(avgCpl)}. Usually caused by a new broad keyword, a changed bid strategy, or a weaker landing page.`,
      steps: ['Compare the Campaigns tab with the previous period', 'Check recent changes in Google Ads change history'],
      impact: 'Back to previous efficiency', items: []
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => order[a.priority] - order[b.priority]);
  return { actions, best };
}
