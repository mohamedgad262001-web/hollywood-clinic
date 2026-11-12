# Hollywood Clinic — Ads & Leads Dashboard

One dashboard showing Google Ads spend next to the **real leads** in the clinic system, down to the keyword:
spend → clicks → leads → qualified → booked → paid, and the cost of each step per campaign, ad group and keyword.

```
Google Ads ──(daily Google Ads Script)──┐
                                        ├──► Supabase (ha_* tables) ──► Next.js dashboard on Vercel
Clinic Leads API ──(n8n, every 15 min)──┘
Website / WhatsApp links ──(gclid + ref code)──► leads ──► matched to the exact ad click & keyword
```

| Folder | What it is |
| --- | --- |
| `supabase/schema.sql` | Tables, ingest functions, security. Run first. |
| `supabase/dashboard_functions.sql` | The read functions the dashboard calls. Run second. |
| `google-ads-script/hollywood_ads_sync.js` | Paste into Google Ads → Scripts. No developer token needed. Read-only. |
| `n8n/hollywood_leads_sync.json` | Import into n8n: pulls leads + statuses from the clinic Leads API. |
| `website/lead-source-capture.js` | Add to hollywoodclinics.net: saves gclid/UTMs and passes them to forms and WhatsApp links. |
| `dashboard/` | The Next.js dashboard (deploy to Vercel). |

---

## 0. Which Supabase project? → "google crm leads" (pmkhssgutixnpdljkiie)

That project already stores every website / Google lead-form lead **with its gclid** in `public.google_leads`.
Run these in its SQL Editor, in this order:

1. `supabase/schema.sql`
2. `supabase/dashboard_functions.sql`
3. `supabase/clinic_sessions_sync.sql`
4. `supabase/google_leads_sync.sql` (copies existing leads now and new ones automatically; test rows are skipped;
   `status = converted` shows as *paid* with its `amount`; service comes from `welcome_messages` / `service_map`)

Skip `website_leads_sync.sql` and `patient_sessions_sync.sql` (those tables aren't in this project).

### Or: a separate, new Supabase project for the dashboard
Create a new project, then run in ITS SQL Editor: `schema.sql`, `dashboard_functions.sql`, `clinic_sessions_sync.sql`,
then `pull_from_old_project.sql` (fill in the old project's pooler host and database password at the top).
It reads the old project's `google_leads` every 10 minutes (read-only) and changes nothing there.

## 1. Supabase (10 min)

1. Open the Supabase project → **SQL Editor** → run `supabase/schema.sql`, then `supabase/dashboard_functions.sql`.
2. Get the ingest secret (used by the Ads script and n8n):
   ```sql
   select value from ha_settings where key = 'ingest_secret';
   ```
3. Note from **Project Settings → API Keys**: the Project URL and the **Publishable key** (`sb_publishable_…`). It replaces the old `anon` key; either works. Never put the secret key (`sb_secret_…`) in the script or n8n.
4. Note from **Project Settings → Database → Connection string → Transaction pooler** (port 6543): the `DATABASE_URL` for the dashboard.

Security: all `ha_*` tables have RLS on with no policies, so the anon key can't read anything. The anon key can only call
the two ingest functions, and they reject any call without the secret. The dashboard reads with the database connection string, server-side only.

## 2. Google Ads Script (10 min)

1. Google Ads (Hollywood account) → **Tools → Bulk actions → Scripts → +**.
2. Paste `google-ads-script/hollywood_ads_sync.js`. Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `INGEST_SECRET`.
3. **First run:** set `DAYS_BACK: 90` and `CLICK_DAYS_BACK: 90`, authorise, then click **Run**. The log shows rows per table.
4. Set both back to `3`, save, and schedule the script **Daily** (e.g. 6 am).

It syncs: campaigns (budget, bidding, impression share), ad groups, keywords (with Quality Score), search terms,
conversions split by conversion action, and every ad click's **gclid → keyword** (that's what links a lead to its keyword).

## 3. Website: capture where each lead came from (15 min)

Right now we don't know whether leads carry their source. This step makes sure they do.

1. Upload `website/lead-source-capture.js` to the site and add it before `</body>` on every page:
   ```html
   <script src="/lead-source-capture.js" defer></script>
   ```
2. **Forms:** the script adds hidden fields `gclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `landing_page` and `ref` to every form.
   Make sure the form handler forwards them to the clinic Leads API (or stores them with the lead).
3. **WhatsApp:** every wa.me link gets a code added to the pre-filled message, e.g. `… [ref: G-7f3k2a9x]`.
   In the n8n WhatsApp workflow, read that code from the first message and save it on the lead as `ref`
   (or leave it in the message text: `ha_ingest_leads` also finds `[ref: …]` inside the lead's raw data).
4. In Google Ads → **Admin → Account settings → Auto-tagging** must be ON (it adds the gclid).

## 4a. Website leads (bookings + contact form): no n8n needed

If the website's `bookings` and `contact_messages` tables are in the **same Supabase project** as the dashboard:

1. Run `supabase/website_leads_sync.sql` in the SQL Editor. It adds source columns (gclid, utm_*, ref) to both tables,
   copies every existing lead into the dashboard, and keeps new ones and status changes in sync automatically through a trigger.
2. In the website code that saves a booking or contact message to Supabase, add the source fields to the insert:
   ```js
   const src = (window.HollywoodLeadSource && window.HollywoodLeadSource()) || {};
   await supabase.from('bookings').insert({
     full_name, phone, treatment, preferred_date, preferred_time, email, message,   // existing fields
     gclid: src.gclid || null, utm_source: src.utm_source || null, utm_medium: src.utm_medium || null,
     utm_campaign: src.utm_campaign || null, utm_term: src.utm_term || null, ref: src.ref || null,
     landing_page: src.landing_page || null
   });
   ```
   Do the same for `contact_messages`.
3. If the admin dashboard updates `bookings.status` (e.g. confirmed / done / cancelled), the dashboard follows it:
   confirmed → booked, done → showed, paid → paid, cancelled → lost.

The existing Telegram alert workflow is not affected.

## 4b. Clinic sessions → booked / paid (from the clinic panel webhooks)

The clinic panel already sends a **Confirmation** webhook (session approved) and a **Done** webhook (session done, with the net amount).
Sending a copy of each to the dashboard turns a lead into *booked* and then *paid* (with revenue), matched by phone number.

1. Run `supabase/clinic_sessions_sync.sql` in the SQL Editor (after the other SQL files).
   If you ever re-run `schema.sql`, run `clinic_sessions_sync.sql` again afterwards.
2. In n8n, open the workflow with the **Confirmation webhook** (`/webhook/wa-confirmation`).
   Copy the contents of `n8n/session_confirmed_to_dashboard_node.json`, click the canvas and press Ctrl+V.
   Connect **Confirmation webhook** → this new node, as a second line next to the existing one, so both run.
   Fill in the publishable key and the ingest secret.
3. In the workflow that receives the clinic's **Done** webhook (the review-collection one), paste
   `n8n/session_done_to_dashboard_node.json` the same way and connect it straight from that webhook node.
4. Save both workflows. The node is set to *continue on error*, so a dashboard problem never blocks the WhatsApp messages.

## 4c. n8n: sync leads from a clinic "list leads" API (only if one exists)

1. n8n → **Import from file** → `n8n/hollywood_leads_sync.json`.
2. Open the **Config** node and fill in the clinic Leads API URL and token, plus the Supabase URL, anon key and ingest secret.
3. Run once and check the last node's output says `{"ok": true, "rows": N}`. Then activate the workflow.
4. If the clinic API uses different field names, edit the `pick(...)` lists in **Map to dashboard rows**.
   Statuses are mapped to: `new → contacted → qualified → booked → showed → paid` (or `lost`), and Arabic status words are handled too.

> Needed from the clinic API: an endpoint that **lists** leads (with id, created date, name, phone, service, status,
> and ideally gclid/utm/ref and the paid amount). The workflow requests `?from=YYYY-MM-DD` to re-sync the last 7 days
> so status changes come through. Adjust the query parameter if the API uses another name.

## 5. Dashboard on Vercel (10 min)

1. Push the `dashboard/` folder to a GitHub repo (or `vercel deploy` from inside it).
2. In Vercel → Project → **Settings → Environment Variables** add:
   - `DATABASE_URL`: the Supabase transaction-pooler connection string
   - `DASHBOARD_USER` / `DASHBOARD_PASSWORD`: the login for the dashboard (it shows patient names and phones)
3. Deploy. Local run: `cp .env.example .env.local`, fill it in, `npm install && npm run dev`.

## 6. Visitor tracking, lead CRM & recommendations

1. Run `supabase/tracking_and_recommendations.sql` **last** in the SQL Editor (re-run it whenever you re-run an older SQL file).
2. In `website/lead-source-capture.js` set `TRACK_URL` to `https://<your-dashboard>/api/track`, upload it and include it on every page.
3. Optional: set `TRACK_ALLOWED_ORIGINS` in Vercel (see `.env.example`).

A phone number typed into any field on the site becomes a lead immediately (channel *website (phone typed)*), no submit or booking needed.
The same phone arriving again within 30 days enriches the existing lead instead of duplicating it. Mention this in the site's privacy notice.

- **Action plan:** ranked to-dos (who to call now, follow-ups due, keywords to pause/scale, negatives, budget moves, best service/hours/landing page).
- **Leads CRM:** every lead scored 0–100 with a next action; update status, notes and follow-up times from the dashboard (stored in `crm_*` columns).
- **Tracking:** visitors, phone capture rate, WhatsApp/call clicks, traffic sources, landing pages.

### What's on the dashboard

- **KPIs:** spend, clicks, Google "conversions" (shown greyed out, since most are contact-button clicks), real Google leads, qualified, booked, paid, revenue and ROAS, each with its cost per step.
- **Overview:** daily spend vs real leads, the Google lead funnel, what Google counts as a conversion, campaigns at a glance.
- **Campaigns / Ad groups / Keywords:** every metric plus real leads, qualified, booked and paid, with cost per lead and per qualified lead. The **Advice** column flags *Scale* (cost per qualified well below average), *Watch*, and *Pause?* (15+ clicks with no lead and no conversion). Sortable and filterable.
- **Search terms:** top 500 by cost. Red = 3+ clicks and no conversion (negative-keyword candidates), green = converting.
- **Leads:** by source × service (Google vs Meta vs unknown), and the latest 200 leads with the keyword each one came from.

Until leads carry a gclid or ref code, the "real leads" columns stay empty and the advice falls back to Google's conversions. The dashboard says so on screen.
