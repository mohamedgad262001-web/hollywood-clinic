/**
 * Hollywood Clinic — lead source capture + visitor tracking
 *
 * Add before </body> on every page of hollywoodclinics.net:
 *   <script src="/lead-source-capture.js" defer></script>
 *
 * What it does:
 * 1. When someone lands from an ad (?gclid=… or ?utm_…), it saves those values for 90 days.
 * 2. Every <form> gets hidden fields: gclid, utm_source, utm_medium, utm_campaign, utm_term, landing_page, ref.
 * 3. Every WhatsApp link (wa.me / api.whatsapp.com) gets a short reference added to the pre-filled message,
 *    e.g. "… [ref: G-7f3k2a]", so a WhatsApp lead can also be tied back to the exact keyword.
 * 4. window.HollywoodLeadSource() returns the saved values, for custom forms or booking widgets.
 * 5. Tracking (when TRACK_URL is set): page views, WhatsApp/call clicks and form submits are sent to the dashboard,
 *    and AS SOON AS A VISITOR TYPES A MOBILE NUMBER into any field it is sent as a lead — no submit needed.
 *    Mention this in the site's privacy notice.
 */
(function () {
  // ── Set this to your dashboard's address, e.g. 'https://hollywood-dashboard.vercel.app/api/track' ──
  var TRACK_URL = '';

  var KEY = 'hc_lead_src';
  var FIELDS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var DAYS = 90;

  function store(k, v, days) {
    try { localStorage.setItem(k, v); } catch (e) {}
    document.cookie = k + '=' + encodeURIComponent(v) + '; path=/; max-age=' + days * 86400 + '; SameSite=Lax';
  }
  function load(k) {
    try { var v = localStorage.getItem(k); if (v) return v; } catch (e) {}
    var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function read() {
    try {
      var v = JSON.parse(load(KEY) || 'null');
      if (v && (!v.expires || v.expires > Date.now())) return v;
    } catch (e) {}
    return null;
  }
  function save(v) {
    v.expires = Date.now() + DAYS * 86400000;
    store(KEY, JSON.stringify(v), DAYS);
  }

  function refCode(v) {
    var id = v.gclid || v.gbraid || v.wbraid;
    if (id) return 'G-' + id.slice(-8);
    if (v.utm_source) return 'U-' + (v.utm_source + '-' + (v.utm_campaign || '')).slice(0, 20);
    return null;
  }

  // 1. capture
  var params = new URLSearchParams(location.search);
  var fresh = {};
  var hasNew = false;
  FIELDS.forEach(function (f) { var x = params.get(f); if (x) { fresh[f] = x; hasNew = true; } });
  var src = read();
  if (hasNew) {
    fresh.landing_page = location.pathname;
    fresh.first_seen = new Date().toISOString();
    save(fresh);            // the latest ad click wins
    src = fresh;
  }
  if (src) {
    src.ref = refCode(src);
    window.HollywoodLeadSource = function () { return src; };
  }

  // 2. forms
  function fillForms() {
    if (!src) return;
    var keys = FIELDS.concat(['landing_page', 'ref']);
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (form) {
      keys.forEach(function (k) {
        if (!src[k]) return;
        var input = form.querySelector('input[name="' + k + '"]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = k;
          form.appendChild(input);
        }
        if (!input.value) input.value = src[k];
      });
    });
  }

  // 3. WhatsApp links
  function tagWhatsApp() {
    if (!src || !src.ref) return;
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"]'), function (a) {
      if (a.dataset.hcTagged) return;
      try {
        var u = new URL(a.href);
        var text = u.searchParams.get('text') || '';
        u.searchParams.set('text', (text ? text + ' ' : '') + '[ref: ' + src.ref + ']');
        a.href = u.toString();
        a.dataset.hcTagged = '1';
      } catch (e) {}
    });
  }

  function run() { fillForms(); tagWhatsApp(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  // pick up forms/links added later (popups, page builders)
  new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });

  // ───────────────────────── 5. Tracking ─────────────────────────
  if (!TRACK_URL) return;

  function rid() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  var vid = load('hc_vid');
  if (!vid || !/^[A-Za-z0-9_-]{8,64}$/.test(vid)) vid = rid();
  store('hc_vid', vid, 730);

  // session = 30 minutes of inactivity
  var sid, newSession = false;
  try {
    var s = JSON.parse(sessionStorage.getItem('hc_sid') || 'null');
    if (s && Date.now() - s.t < 30 * 60000) sid = s.id; else { sid = rid(); newSession = true; }
    sessionStorage.setItem('hc_sid', JSON.stringify({ id: sid, t: Date.now() }));
  } catch (e) { sid = rid(); newSession = true; }

  function send(event, extra) {
    var body = { v: vid, s: sid, e: event, page: location.pathname, title: document.title.slice(0, 200) };
    if (src) body.src = { gclid: src.gclid || src.gbraid || src.wbraid, ref: src.ref, utm_source: src.utm_source,
      utm_medium: src.utm_medium, utm_campaign: src.utm_campaign, utm_term: src.utm_term, landing_page: src.landing_page };
    if (newSession && document.referrer && document.referrer.indexOf(location.host) < 0) body.referrer = document.referrer.slice(0, 300);
    for (var k in extra) if (extra[k]) body[k] = extra[k];
    var json = JSON.stringify(body);
    try {
      // text/plain = no CORS preflight; sendBeacon survives page navigation
      if (navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, new Blob([json], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { fetch(TRACK_URL, { method: 'POST', body: json, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }

  send('pageview');

  // clicks on WhatsApp / call links
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/wa\.me|api\.whatsapp\.com|whatsapp:/i.test(href)) send('wa_click', { href: href.split('?')[0] });
    else if (/^tel:/i.test(href)) send('call_click', { href: href.slice(0, 40) });
  }, true);

  // ── phone number typed anywhere = lead ──
  var HINT = /phone|mobile|tel|whats|cell|number|هاتف|موبايل|جوال|رقم|تليفون|واتس/i;
  var NAME_HINT = /name|اسم/i;
  var SVC_HINT = /service|treatment|interest|خدمة|علاج/i;
  var sent = {};

  function digits(v) {
    return String(v || '')
      .replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; })
      .replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 1776; });
  }
  function phoneOf(v) {
    var raw = digits(v).trim();
    var d = raw.replace(/\D/g, '');
    if (/^(?:\+?20|0020|0)?1[0125]\d{8}$/.test(raw.replace(/[\s()-]/g, ''))) return raw;   // Egyptian mobile
    if (/^\+?[\d\s()-]{10,20}$/.test(raw) && d.length >= 10 && d.length <= 15 && !/^(\d)\1+$/.test(d)) return raw;
    return null;
  }
  function attrs(el) {
    return [el.name, el.id, el.placeholder, el.getAttribute('autocomplete'), el.getAttribute('aria-label'),
      el.labels && el.labels[0] ? el.labels[0].textContent : ''].join(' ');
  }
  function isPhoneField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (/password|email|hidden|checkbox|radio|date|search/i.test(el.type)) return false;
    return el.type === 'tel' || HINT.test(attrs(el));
  }
  function fieldInForm(form, re, skip) {
    if (!form) return '';
    var els = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el === skip || el.type === 'hidden' || el.type === 'password') continue;
      if (re.test(attrs(el)) && el.value && !/@/.test(el.value)) {
        return el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text || el.value : el.value;
      }
    }
    return '';
  }
  function context(el) {
    var form = el.form || (el.closest && el.closest('form'));
    return {
      name: fieldInForm(form, NAME_HINT, el).slice(0, 120),
      service: (fieldInForm(form, SVC_HINT, el) || document.title).slice(0, 120)
    };
  }
  function check(el, event) {
    if (!el || !('value' in el)) return;
    var ph = phoneOf(el.value);
    if (!ph || !(isPhoneField(el) || /^(?:\+?20|0020|0)?1[0125]\d{8}$/.test(digits(el.value).replace(/[\s()-]/g, '')))) return;
    var key = digits(ph).replace(/\D/g, '');
    var ctx = context(el);
    var sig = key + '|' + ctx.name;
    if (sent[sig] && event === 'phone') return;          // already sent this number (with this name)
    sent[sig] = 1;
    send(event || 'phone', { phone: ph, name: ctx.name, service: ctx.service });
  }

  var timer;
  document.addEventListener('input', function (e) {
    var el = e.target;
    clearTimeout(timer);
    timer = setTimeout(function () { check(el, 'phone'); }, 1200);   // complete number + short pause
  }, true);
  document.addEventListener('change', function (e) { check(e.target, 'phone'); }, true);
  document.addEventListener('focusout', function (e) { check(e.target, 'phone'); }, true);

  // form submit (with the phone, if there is one)
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var phoneEl = null;
    Array.prototype.forEach.call(form.querySelectorAll('input'), function (el) {
      if (!phoneEl && phoneOf(el.value) && (isPhoneField(el) || /^(?:\+?20|0020|0)?1[0125]\d{8}$/.test(digits(el.value).replace(/[\s()-]/g, '')))) phoneEl = el;
    });
    if (phoneEl) {
      var ctx = context(phoneEl);
      send('form_submit', { phone: phoneOf(phoneEl.value), name: ctx.name, service: ctx.service });
    } else send('form_submit');
  }, true);
})();
