/**
 * Hollywood Clinic — Google Ads → Supabase daily sync
 *
 * Where: Google Ads → Tools → Bulk actions → Scripts → + (new script). Paste this whole file.
 * Schedule: Daily (e.g. 06:00). Run once manually first with DAYS_BACK = 90 to backfill, then set it back to 3.
 *
 * It sends campaign, ad group, keyword, search term, conversion-action and click (gclid) data
 * to Supabase through the ha_ingest_ads() function. Nothing in the ads account is changed: read-only.
 */

var CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',   // Supabase → Project Settings → API → Project URL
  SUPABASE_ANON_KEY: 'sb_publishable_...',            // Supabase → Project Settings → API Keys → Publishable key (or legacy anon key)
  INGEST_SECRET: 'YOUR-INGEST-SECRET',                // select value from ha_settings where key = 'ingest_secret';
  DAYS_BACK: 3,           // daily run re-syncs the last 3 days (conversions arrive late). Use 90 for the first run.
  CLICK_DAYS_BACK: 3,     // gclid → keyword map. Use 90 for the first run (Google keeps click data 90 days).
  CHUNK: 1000
};

function main() {
  var range = dateRange(CONFIG.DAYS_BACK);
  var where = " WHERE segments.date BETWEEN '" + range.from + "' AND '" + range.to + "'";

  // 1. Campaigns
  send('campaign_daily', query(
    'SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, ' +
    'campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, ' +
    'metrics.conversions_value, metrics.search_impression_share, metrics.search_top_impression_share, ' +
    'metrics.search_absolute_top_impression_share FROM campaign' + where,
    function (r) {
      return {
        date: r.segments.date, campaign_id: num(r.campaign.id), campaign_name: r.campaign.name,
        campaign_status: r.campaign.status, bidding: r.campaign.biddingStrategyType,
        budget: micros(r.campaignBudget && r.campaignBudget.amountMicros),
        impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks), cost: micros(r.metrics.costMicros),
        conversions: num(r.metrics.conversions), conv_value: num(r.metrics.conversionsValue),
        search_is: optNum(r.metrics.searchImpressionShare), search_top_is: optNum(r.metrics.searchTopImpressionShare),
        search_abs_top_is: optNum(r.metrics.searchAbsoluteTopImpressionShare)
      };
    }));

  // 2. Ad groups
  send('adgroup_daily', query(
    'SELECT segments.date, ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group' + where,
    function (r) {
      return {
        date: r.segments.date, ad_group_id: num(r.adGroup.id), ad_group_name: r.adGroup.name,
        ad_group_status: r.adGroup.status, campaign_id: num(r.campaign.id), campaign_name: r.campaign.name,
        impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks), cost: micros(r.metrics.costMicros),
        conversions: num(r.metrics.conversions)
      };
    }));

  // 3. Keywords
  send('keyword_daily', query(
    'SELECT segments.date, ad_group.id, ad_group.name, campaign.id, campaign.name, ad_group_criterion.criterion_id, ' +
    'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ' +
    'ad_group_criterion.quality_info.quality_score, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions FROM keyword_view' + where,
    function (r) {
      var c = r.adGroupCriterion;
      return {
        date: r.segments.date, ad_group_id: num(r.adGroup.id), criterion_id: num(c.criterionId),
        keyword: c.keyword && c.keyword.text, match_type: c.keyword && c.keyword.matchType, status: c.status,
        quality_score: c.qualityInfo ? optNum(c.qualityInfo.qualityScore) : null,
        ad_group_name: r.adGroup.name, campaign_id: num(r.campaign.id), campaign_name: r.campaign.name,
        impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks), cost: micros(r.metrics.costMicros),
        conversions: num(r.metrics.conversions)
      };
    }));

  // 4. Search terms
  send('search_term_daily', query(
    'SELECT segments.date, search_term_view.search_term, segments.keyword.info.text, ad_group.id, ad_group.name, ' +
    'campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
    'FROM search_term_view' + where,
    function (r) {
      return {
        date: r.segments.date, search_term: r.searchTermView.searchTerm,
        keyword: r.segments.keyword && r.segments.keyword.info ? r.segments.keyword.info.text : null,
        ad_group_id: num(r.adGroup.id), ad_group_name: r.adGroup.name, campaign_name: r.campaign.name,
        impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks), cost: micros(r.metrics.costMicros),
        conversions: num(r.metrics.conversions)
      };
    }));

  // 5. Conversions split by conversion action (Contacts vs Booked vs Qualified …)
  send('conversion_action_daily', query(
    'SELECT segments.date, campaign.id, segments.conversion_action_name, metrics.conversions, metrics.conversions_value ' +
    'FROM campaign' + where + ' AND metrics.conversions > 0',
    function (r) {
      return {
        date: r.segments.date, campaign_id: num(r.campaign.id), conversion_action: r.segments.conversionActionName,
        conversions: num(r.metrics.conversions), conv_value: num(r.metrics.conversionsValue)
      };
    }));

  // 6. Clicks (gclid → keyword). click_view only allows one day per query.
  for (var i = 1; i <= CONFIG.CLICK_DAYS_BACK; i++) {
    var day = dateRange(i).from;
    send('clicks', query(
      'SELECT click_view.gclid, click_view.keyword_info.text, click_view.keyword_info.match_type, segments.date, ' +
      'segments.device, campaign.id, campaign.name, ad_group.id, ad_group.name FROM click_view ' +
      "WHERE segments.date = '" + day + "'",
      function (r) {
        var k = r.clickView.keywordInfo || {};
        return {
          gclid: r.clickView.gclid, date: r.segments.date, device: r.segments.device,
          campaign_id: num(r.campaign.id), campaign_name: r.campaign.name,
          ad_group_id: num(r.adGroup.id), ad_group_name: r.adGroup.name,
          keyword: k.text || null, match_type: k.matchType || null
        };
      }));
  }
  Logger.log('Done.');
}

// ───────── helpers ─────────
function query(gaql, mapRow) {
  var out = [];
  var it = AdsApp.search(gaql);
  while (it.hasNext()) out.push(mapRow(it.next()));
  return out;
}

function send(table, rows) {
  Logger.log(table + ': ' + rows.length + ' rows');
  for (var i = 0; i < rows.length; i += CONFIG.CHUNK) {
    var body = { payload: { secret: CONFIG.INGEST_SECRET, table: table, rows: rows.slice(i, i + CONFIG.CHUNK) } };
    var res = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/rpc/ha_ingest_ads', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY },   // new sb_publishable_ keys go in the apikey header only
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      throw new Error(table + ' upload failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 500));
    }
  }
}

// yyyy-MM-dd for "daysBack" days ago … yesterday, in the account's time zone
function dateRange(daysBack) {
  var tz = AdsApp.currentAccount().getTimeZone();
  var now = new Date();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  return {
    from: fmt(new Date(now.getTime() - daysBack * 86400000)),
    to: fmt(new Date(now.getTime() - 86400000))
  };
}

function num(v) { return v === undefined || v === null || v === '' ? 0 : Number(v); }
function optNum(v) { return v === undefined || v === null || v === '' ? null : Number(v); }
function micros(v) { return v === undefined || v === null || v === '' ? null : Math.round(Number(v) / 10000) / 100; }
