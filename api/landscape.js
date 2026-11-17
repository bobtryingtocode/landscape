// Landscape API — runs on Vercel at /api/landscape.
// Free path (no login):  NH assessor cards from Vision/VGSI, public listing pages parsed for address + price.
// Paid path (login):     nationwide parcel + owner records from county assessor feeds via Apify, metered in credits (1 credit = 1 parcel record).
// Accounts, credits and search jobs live in Neon (Postgres); sign-in is a 6-digit emailed code.
// Owner data is public record, used for purchase inquiries only.
const L = require('./_lib');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };
const streetCache = new Map();
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const money = s => { if (s === null || s === undefined || s === '') return null; const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const norm = a => String(a || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------- Vision / VGSI assessor cards (free, NH and other Vision towns) ----------------
const slug = (town, st = 'nh') => town.toLowerCase().replace(/[^a-z]/g, '') + st.toLowerCase();
const span = (h, id) => { const m = h.match(new RegExp('id="MainContent_' + id + '"[^>]*>(.*?)</span>', 's')); return m ? strip(m[1]) : null; };
function table(h, id) {
  const m = h.match(new RegExp('id="MainContent_' + id + '".*?</table>', 's')); if (!m) return [];
  return [...m[0].matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(r => [...r[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(c => strip(c[1])));
}
async function fetchStreet(town, st, street) {
  const key = slug(town, st) + '|' + street.toUpperCase();
  const c = streetCache.get(key); if (c && Date.now() - c.at < 6 * 3600e3) return c.html;
  const r = await fetch(`https://gis.vgsi.com/${slug(town, st)}/Streets.aspx?Name=${encodeURIComponent(street.toUpperCase())}`, { headers: UA });
  if (!r.ok) throw new Error(`Assessor site returned ${r.status} for ${town}. This town may not use Vision (VGSI) — use "Find candidates nationwide".`);
  const html = await r.text(); streetCache.set(key, { at: Date.now(), html }); return html;
}
const parseStreet = html => [...html.matchAll(/<a href=['"]Parcel\.aspx\?pid=(\d+)['"]>([^<]*)</g)].map(m => ({ pid: m[1], address: strip(m[2]) }));
function howAcquired(owner, lastPrice) {
  const o = String(owner || '').toUpperCase();
  if (/ESTATE|HEIRS|ADMINISTRATOR|EXECUTOR/.test(o)) return 'inherit';
  if (/TRUST|TRUSTEE|REV TR|\bTR\b/.test(o)) return 'trust';
  if (/LLC|INC\b|CORP|\bLP\b|LTD|PROPERTIES|HOLDINGS|REALTY/.test(o)) return 'llc';
  if (lastPrice === 0) return 'family';
  if (lastPrice > 0) return 'purchase';
  return '';
}
async function parcel(town, st, pid) {
  const r = await fetch(`https://gis.vgsi.com/${slug(town, st)}/Parcel.aspx?pid=${pid}`, { headers: UA });
  if (!r.ok) throw new Error(`Assessor card ${pid} returned ${r.status}`);
  const h = await r.text();
  const sales = table(h, 'grdSales').slice(1).map(c => ({ owner: c[0], price: money(c[1]), book_page: c[3], instrument: c[4], date: c[5] })).filter(s => s.date && !s.date.startsWith('01/01/1900'));
  const values = table(h, 'grdHistoryValuesAsmt').slice(1).map(c => ({ year: c[0], improvements: money(c[1]), land: money(c[2]), total: money(c[3]) }));
  const owner = span(h, 'lblOwner') || span(h, 'lblGenOwner') || '';
  // Walk back through the sale history while the owner surname stays the same, so a trust transfer or
  // re-recorded deed doesn't hide how long the family has actually held the land.
  const key = x => (x || '').toUpperCase().replace(/[^A-Z ]/g, ' ').trim().split(/\s+/)[0] || '';
  let last = sales[0];
  for (const s of sales) { if (key(s.owner) && key(s.owner) === key(owner)) last = s; else break; }
  const bld = h.match(/id="MainContent_ctl\d+_lblBldArea"[^>]*>(.*?)<\/span>/s), yb = h.match(/id="MainContent_ctl\d+_lblYearBuilt"[^>]*>(.*?)<\/span>/s);
  const cns = Object.fromEntries(table(h, 'ctl\\d+_grdCns').slice(1).map(c => [c[0], c[1]]));
  return {
    pid, address: span(h, 'lblLocation'), mblu: span(h, 'lblMblu'), owner, co_owner: span(h, 'lblCoOwner'), owner_mail: span(h, 'lblAddr1'),
    assessed_total: money(span(h, 'lblGenAssessment')), assessed_land: money(span(h, 'lblLndAsmt')), acres: money(span(h, 'lblLndSize')),
    zone: span(h, 'lblZone'), use_code: span(h, 'lblUseCode'), use_desc: span(h, 'lblUseCodeDescription'),
    bld_area: bld ? money(strip(bld[1])) : null, year_built: yb ? money(strip(yb[1])) : null, beds: money(cns['Bedrooms']), baths: money(cns['Full Baths']), style: cns['Style'] || null, heat: cns['Heat Fuel'] || null,
    year_acquired: last && last.date ? parseInt(last.date.slice(-4)) : null, price_paid: last ? last.price : null, how_acquired: howAcquired(owner, last ? last.price : null),
    sales, values, source: `https://gis.vgsi.com/${slug(town, st)}/Parcel.aspx?pid=${pid}`
  };
}
function splitAddr(a) { const m = a.trim().toUpperCase().match(/^(\d+[A-Z]?)\s+(.+)$/); return m ? { num: m[1], street: m[2] } : { num: '', street: a.trim().toUpperCase() }; }

// ---------------- Generic listing-page scraper (replaces Zillow) ----------------
// Reads any public listings page (LandWatch, Realtor.com, Redfin, a brokerage site…) and pulls out
// address + asking price pairs. Most listing sites embed schema.org JSON-LD, which is the reliable path;
// a text pattern pass catches the rest.
function parseListings(html, pageUrl) {
  const out = [], seen = new Set();
  const add = l => { if (!l.address) return; const k = norm(l.address); if (seen.has(k)) return; seen.add(k); out.push(l); };
  const addrOf = o => {
    const a = o.address || (o.offers && o.offers.address) || (o.item && o.item.address) || null;
    if (!a) return null;
    if (typeof a === 'string') return { address: a, town: '', state: '', zip: '' };
    return { address: a.streetAddress || '', town: a.addressLocality || '', state: a.addressRegion || '', zip: a.postalCode || '' };
  };
  const priceOf = o => {
    const cand = [o.price, o.offers && o.offers.price, o.offers && o.offers.lowPrice, o.item && o.item.offers && o.item.offers.price, o.item && o.item.price];
    for (const c of cand) { const n = money(c); if (n) return n; }
    return null;
  };
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const a = addrOf(o), p = priceOf(o);
    if (a && a.address && p) {
      let acres = null; const lot = o.lotSize || (o.item && o.item.lotSize) || o.floorSize;
      if (lot && typeof lot === 'object') { const v = money(lot.value), u = String(lot.unitText || lot.unitCode || '').toLowerCase(); if (v) acres = /acre/.test(u) ? v : /ft|sqft|sq/.test(u) ? v / 43560 : null; }
      add({ ...a, ask: p, acres, url: o.url || (o.item && o.item.url) || o['@id'] || pageUrl, name: o.name || '' });
    }
    Object.values(o).forEach(walk);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch (_) { /* malformed block; keep going */ }
  }
  if (!out.length) {
    // Text fallback: "123 Some Road ... $250,000" within a short window.
    const text = strip(html);
    const re = /(\d{1,6}[A-Za-z]?\s+[A-Z][A-Za-z0-9'.\- ]{2,40}?\s(?:Rd|Road|St|Street|Ave|Avenue|Ln|Lane|Dr|Drive|Way|Hwy|Highway|Rt|Route|Trl|Trail|Ct|Court|Cir|Circle|Pl|Place|Blvd|Ter|Terrace|Path|Pike|Tpke|Turnpike))\b[^$]{0,160}\$([\d,]{4,})/g;
    for (const m of text.matchAll(re)) { const ask = money(m[2]); if (ask && ask >= 1000) add({ address: m[1].trim(), town: '', state: '', zip: '', ask, acres: null, url: pageUrl }); }
    const re2 = /\$([\d,]{4,})[^$]{0,160}?(\d{1,6}[A-Za-z]?\s+[A-Z][A-Za-z0-9'.\- ]{2,40}?\s(?:Rd|Road|St|Street|Ave|Avenue|Ln|Lane|Dr|Drive|Way|Hwy|Highway|Rt|Route|Trl|Trail|Ct|Court|Cir|Circle|Pl|Place|Blvd|Ter|Terrace|Path|Pike|Tpke|Turnpike))\b/g;
    for (const m of text.matchAll(re2)) { const ask = money(m[1]); if (ask && ask >= 1000) add({ address: m[2].trim(), town: '', state: '', zip: '', ask, acres: null, url: pageUrl }); }
  }
  return out;
}
async function listings(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Paste the full link to a listings page (it should start with https://).');
  const r = await fetch(url, { headers: { ...UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`That site answered ${r.status}. Some listing sites block automated reads — try a different page or source.`);
  const html = await r.text();
  const found = parseListings(html, url);
  if (!found.length) throw new Error('No listings with an address and price were found on that page. Try the page that lists results (not a map view).');
  return found;
}

// ---------------- Nationwide parcel + owner search via Apify (paid, metered) ----------------
// Records come from county assessor / state tax-roll feeds read by the Apify actor
// scrapebench/us-county-property-records-export (area exports, $0.02 a row) and, for single-address
// lookups outside its coverage, shelvick/county-property-records ($0.05 a record, 2,100+ counties).
// Runs take 1–2 minutes, so a search is started, then polled: start → poll → poll … → records.
const EXPORT_ACTOR = 'scrapebench~us-county-property-records-export';
const LOOKUP_ACTOR = 'shelvick~county-property-records';
const EXPORT_COST = 0.02, LOOKUP_COST = 0.05;
const USE_WORDS = {
  vacant: { preset: 'vacant_land' },
  farm_forest: { propertyUse: ['agricultur', 'farm', 'forest', 'timber', 'pasture', 'grazing', 'rural'] },
  single_family: { propertyUse: ['single family', 'single-family', 'sfr', 'one family', 'residential'] },
  residential: { propertyUse: ['residential', 'single family', 'condo', 'multi', 'duplex', 'townho'] },
  commercial: { propertyUse: ['commercial', 'retail', 'office', 'industrial', 'warehouse'] },
  any: {},
};
function exportInput(q, count, countOnly) {
  const st = String(q.state || '').trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(st)) throw new Error('Enter a two-letter state (for example FL or MA).');
  const where = String(q.zip || '').trim() || (q.city ? `${String(q.city).trim()}, ${st}` : q.county ? `${String(q.county).trim().replace(/\s+county$/i, '')}, ${st}` : st);
  const use = USE_WORDS[q.land_use || 'vacant'] || {};
  const inp = { areas: [where], maxResultsPerArea: count, includeHistory: true, countOnly: !!countOnly, ownerTypes: ['individual', 'trust', 'company'] };
  if (use.preset) inp.preset = use.preset;
  if (use.propertyUse) inp.propertyUse = use.propertyUse;
  if (q.absentee_only) inp.absentee = ['out_of_state', 'out_of_city'];
  if (q.owner_type && q.owner_type !== 'any') inp.ownerTypes = [q.owner_type];
  const minv = parseInt(q.min_value) || 0, maxv = parseInt(q.max_value) || 0;
  if (minv) inp.minValue = minv; if (maxv) inp.maxValue = maxv;
  if (q.held_since) inp.soldBefore = q.held_since;
  return inp;
}
function mapExportRow(d) {
  if (!d || d.notice_type || d.status === 'notice' || !d.parcel_id) return null;
  const acres = d.lot_acres != null ? Number(d.lot_acres) : (d.lot_sqft ? Number(d.lot_sqft) / 43560 : null);
  const sale = d.last_sale_date || (d.sale_history && d.sale_history[0] && d.sale_history[0].date) || null;
  const saleYear = sale ? parseInt(String(sale).slice(0, 4)) : null;
  const salePrice = d.last_sale_price != null ? money(d.last_sale_price) : (d.sale_history && d.sale_history[0] ? money(d.sale_history[0].price) : null);
  const useDesc = d.property_class_desc || d.property_class || '';
  const vacant = /vacant|land|lot|acre|agricult|farm|forest|timber|pasture/i.test(useDesc) || (!d.year_built && !d.building_sqft && (d.improvement_value === 0 || d.improvement_value == null));
  const absentee = typeof d.absentee_owner === 'boolean' ? d.absentee_owner : /out_of/.test(d.absentee_tier || '');
  return {
    address: d.situs_address || '', town: d.situs_city || '', state: d.state || '', zip: d.situs_zip || '', county: d.county || '',
    owner: [d.owner_name, d.owner_name_2].filter(Boolean).join(' & '), owner_type: d.owner_type || '',
    owner_mail: [d.mailing_address, d.mailing_city, d.mailing_state, d.mailing_zip].filter(Boolean).join(', '), absentee, absentee_tier: d.absentee_tier || '',
    acres: acres ? Math.round(acres * 100) / 100 : null, assessed_total: money(d.market_value) ?? money(d.assessed_value), assessed_land: money(d.land_value), assessed_improvements: money(d.improvement_value),
    land_use: useDesc, use_code: d.property_class || '', is_home: !vacant, year_built: money(d.year_built), sqft: money(d.building_sqft), beds: money(d.bedrooms),
    year_acquired: saleYear && saleYear > 1800 ? saleYear : null, price_paid: salePrice,
    how_acquired: d.owner_type === 'trust' ? 'trust' : d.owner_type === 'company' ? 'llc' : howAcquired(d.owner_name, salePrice),
    lat: d.latitude, lon: d.longitude, parcel_number: d.parcel_id || '', source: d.source_url || '', source_name: d.source || '',
    sales: (d.sale_history || []).map(s => ({ date: s.date, price: s.price, instrument: s.document })),
    notes: (d.field_notes || []).map(n => n.reason).filter(Boolean).slice(0, 3).join(' '),
  };
}
function mapLookupRow(d) {
  if (!d || d.status !== 'completed' || !d.parcel_id) return null;
  const c = d.characteristics || {};
  const salePrice = money(d.last_sale_price), saleYear = d.last_sale_date ? parseInt(String(d.last_sale_date).slice(0, 4)) : null;
  return {
    address: d.situs_address || '', town: c.city || '', state: d.state || '', county: d.county || '',
    owner: d.owner_name || '', owner_mail: d.mailing_address || '', absentee: !!d.absentee_owner,
    acres: c.lot_acres ?? (c.lot_sqft ? c.lot_sqft / 43560 : null), assessed_total: money(d.market_value) ?? money(d.assessed_value), assessed_land: money(d.land_value), assessed_improvements: money(d.improvement_value),
    land_use: c.property_class_desc || c.property_class || '', year_built: money(c.year_built), sqft: money(c.building_sqft), beds: money(c.bedrooms),
    year_acquired: saleYear && saleYear > 1800 ? saleYear : null, price_paid: salePrice, how_acquired: howAcquired(d.owner_name, salePrice),
    parcel_number: d.parcel_id, source: d.source_url || '', sales: (d.sale_history || []),
  };
}
const coverageCache = { at: 0, rows: null };
async function coverage() {
  if (coverageCache.rows && Date.now() - coverageCache.at < 24 * 3600e3) return coverageCache.rows;
  const items = await L.apifyRunSync(EXPORT_ACTOR, { listCoverage: true }, { timeout: 90, maxTotalChargeUsd: 0.05 });
  const rows = items.filter(r => r.state).map(r => ({ state: r.state, counties: r.counties, source: r.source, completeness: r.completeness, has_owner: (r.fields_available || []).includes('owner_name'), has_mail: (r.fields_available || []).includes('mailing_address'), has_acres: (r.fields_available || []).some(f => /lot_/.test(f)) }));
  coverageCache.at = Date.now(); coverageCache.rows = rows; return rows;
}
// ---------------- Accounts, credits, billing ----------------
async function requireUser(req) {
  const u = await L.userFromReq(req);
  if (!u) { const e = new Error('Sign in to use nationwide records and credits.'); e.status = 401; throw e; }
  return u;
}
async function spend(user, count, ref) {
  if (L.isOwner(user.email)) return { credits: 999999 };
  const row = await L.rpc('spend_credits', { p_user: user.id, p_amount: count, p_reason: 'nationwide_search', p_ref: ref || '' });
  if (!row || row.ok === false) { const e = new Error(`Not enough credits — this search needs ${count} and you have ${row ? row.credits : 0}. Buy a pack or pick a plan below.`); e.status = 402; throw e; }
  return row;
}
async function refund(user, count, ref) {
  if (L.isOwner(user.email) || !count) return;
  await L.rpc('add_credits', { p_user: user.id, p_amount: count, p_reason: 'refund_short_results', p_ref: ref || '' });
}
async function checkout(user, sku, origin, native) {
  const plan = L.PLANS[sku]; if (!plan) throw new Error('Unknown plan.');
  const prof = await L.getProfile(user);
  const base = (L.env('APP_URL') || origin || '').replace(/\/$/, '');
  const body = {
    mode: plan.kind === 'plan' ? 'subscription' : 'payment',
    success_url: `${base}/?paid=${sku}${native ? '&native=1' : ''}`, cancel_url: `${base}/?canceled=1${native ? '&native=1' : ''}`,
    client_reference_id: user.id, metadata: { user_id: user.id, sku, credits: plan.credits },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: plan.amount, product_data: { name: plan.name }, ...(plan.kind === 'plan' ? { recurring: { interval: 'month' } } : {}) } } },
    allow_promotion_codes: 'true',
  };
  if (prof.stripe_customer_id) body.customer = prof.stripe_customer_id; else body.customer_email = user.email;
  if (plan.kind === 'plan') body.subscription_data = { metadata: { user_id: user.id, sku } };
  const s = await L.stripe('checkout/sessions', body);
  return { url: s.url };
}
async function portal(user, origin) {
  const prof = await L.getProfile(user);
  if (!prof.stripe_customer_id) throw new Error('No subscription on file yet.');
  const s = await L.stripe('billing_portal/sessions', { customer: prof.stripe_customer_id, return_url: (L.env('APP_URL') || origin || '').replace(/\/$/, '') + '/' });
  return { url: s.url };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const town = (b.town || '').trim(), st = (b.state || 'NH').trim() || 'NH';
    const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : '');
    switch (b.action) {
      // ---- free: assessor cards ----
      case 'street': if (!town) return res.status(400).json({ error: 'town is required' }); return res.json({ parcels: parseStreet(await fetchStreet(town, st, b.street)) });
      case 'parcel': if (!town) return res.status(400).json({ error: 'town is required' }); return res.json(await parcel(town, st, String(b.pid)));
      case 'lookup': {
        if (!town) return res.status(400).json({ error: 'town is required' });
        const { num, street } = splitAddr(b.address || ''); const list = parseStreet(await fetchStreet(town, st, street)); const want = (num + ' ' + street).trim();
        const hit = list.find(p => p.address.toUpperCase() === want) || list.find(p => p.address.toUpperCase().startsWith(num + ' ') && p.address.toUpperCase().includes(street));
        if (!hit) return res.status(404).json({ error: 'No assessor card found for ' + want, candidates: list.slice(0, 20) });
        return res.json(await parcel(town, st, hit.pid));
      }
      // ---- free: listings from any public listings page ----
      case 'listings': return res.json({ listings: await listings(b.url) });
      // ---- account ----
      case 'login_start': return res.json(await L.startLogin(b.email));
      case 'login_verify': { const { token, profile } = await L.verifyLogin(b.email, b.code); return res.json({ token, me: L.publicProfile(profile, { email: profile.email }) }); }
      case 'logout': await L.logout(req); return res.json({ ok: true });
      case 'me': { const u = await requireUser(req); return res.json(L.publicProfile(await L.getProfile(u), u)); }
      case 'plans': return res.json({ plans: Object.entries(L.PLANS).map(([sku, p]) => ({ sku, kind: p.kind, name: p.name, price: p.amount / 100, credits: p.credits })) });
      case 'checkout': { const u = await requireUser(req); return res.json(await checkout(u, b.sku, origin, !!b.native)); }
      case 'portal': { const u = await requireUser(req); return res.json(await portal(u, origin)); }
      // ---- nationwide: coverage + free preview ----
      case 'coverage': return res.json({ coverage: await coverage() });
      case 'preview': {
        await requireUser(req);
        const items = await L.apifyRunSync(EXPORT_ACTOR, exportInput(b, 1, true), { timeout: 120, maxTotalChargeUsd: 0.05 });
        const notice = items.find(i => i.notice_type || i.notice); const cnt = items.find(i => i.count != null || i.matching != null || i.estimated_rows != null || i.total != null);
        const n = cnt ? (cnt.count ?? cnt.matching ?? cnt.estimated_rows ?? cnt.total) : null;
        return res.json({ count: n, basis: cnt && (cnt.count_basis || cnt.basis) || null, notice: notice ? notice.notice : null, notice_type: notice ? notice.notice_type : null, raw: items.slice(0, 3) });
      }
      // ---- paid: nationwide search, 1 credit per parcel record returned. start → poll ----
      case 'search_start': {
        const u = await requireUser(req);
        const count = Math.max(1, Math.min(100, parseInt(b.count) || 20));
        const input = exportInput(b, count, false);
        const ref = `job/${u.id.slice(0, 8)}/${Date.now()}`;
        await spend(u, count, ref);
        let run;
        try { run = await L.apifyStart(EXPORT_ACTOR, input, { timeout: 600, maxTotalChargeUsd: Math.round((count * EXPORT_COST + 0.1) * 100) / 100 }); }
        catch (e) { await refund(u, count, ref).catch(() => {}); throw e; }
        const params = JSON.stringify({ state: b.state, county: b.county, city: b.city, zip: b.zip, land_use: b.land_use, absentee_only: !!b.absentee_only, owner_type: b.owner_type, min_value: b.min_value, max_value: b.max_value });
        const job = await L.q`insert into searches (user_id, kind, run_id, dataset_id, status, reserved, ref, params) values (${u.id}, 'export', ${run.id}, ${run.defaultDatasetId}, 'running', ${count}, ${ref}, ${params}::jsonb) returning id`;
        return res.json({ job: job[0].id, status: 'running' });
      }
      case 'search_poll': {
        const u = await requireUser(req);
        const rows = await L.q`select * from searches where id = ${parseInt(b.job) || 0} and user_id = ${u.id}`; const job = rows && rows[0];
        if (!job) return res.status(404).json({ error: 'Search not found.' });
        if (job.status === 'done') return res.json({ status: 'done', parcels: job.result || [], charged: job.records, requested: job.reserved, notice: job.notice || null });
        if (job.status === 'failed') return res.status(502).json({ error: job.notice || 'That search failed and your credits were returned.' });
        const run = await L.apifyRun(job.run_id);
        if (['READY', 'RUNNING'].includes(run.status)) return res.json({ status: 'running', started: run.startedAt });
        if (run.status !== 'SUCCEEDED') {
          await refund(u, job.reserved, job.ref).catch(() => {});
          await L.q`update searches set status = 'failed', records = 0, notice = ${`The records source did not finish (${run.status}). Your ${job.reserved} credits were returned.`} where id = ${job.id}`;
          return res.status(502).json({ error: `The records source did not finish (${run.status}). Your ${job.reserved} credits were returned.` });
        }
        const items = await L.apifyItems(job.dataset_id || run.defaultDatasetId);
        const parcels = items.map(mapExportRow).filter(Boolean);
        const notice = items.find(i => i.notice_type && i.notice);
        const charged = Math.min(job.reserved, parcels.length);
        if (charged < job.reserved) await refund(u, job.reserved - charged, job.ref).catch(() => {});
        const noticeText = notice ? notice.notice : (parcels.length ? null : 'No parcels matched those filters in that area.');
        await L.q`update searches set status = 'done', records = ${charged}, result = ${JSON.stringify(parcels)}::jsonb, notice = ${noticeText} where id = ${job.id}`;
        const prof = await L.getProfile(u);
        return res.json({ status: 'done', parcels, charged, requested: job.reserved, notice: noticeText, credits: L.isOwner(u.email) ? 999999 : prof.credits });
      }
      // ---- paid: one address anywhere in the U.S. (1 credit if found) ----
      case 'lookup_us': {
        const u = await requireUser(req);
        const addr = String(b.address || '').trim(); if (!addr) return res.status(400).json({ error: 'address is required' });
        const ref = `lookup/${u.id.slice(0, 8)}/${Date.now()}`;
        await spend(u, 1, ref);
        let items;
        try { items = await L.apifyRunSync(LOOKUP_ACTOR, { addresses: [addr], includeHistory: true, maxRecords: 1 }, { timeout: 120, maxTotalChargeUsd: 0.1 }); }
        catch (e) { await refund(u, 1, ref).catch(() => {}); throw e; }
        const rec = items.map(mapLookupRow).filter(Boolean)[0];
        if (!rec) { await refund(u, 1, ref).catch(() => {}); const miss = items[0] || {}; return res.status(404).json({ error: miss.error || (miss.status === 'not_covered' ? 'That county is not covered yet. Your credit was returned.' : 'No record found for that address. Your credit was returned.') }); }
        return res.json(rec);
      }
      default: return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) { return res.status(e.status || 500).json({ error: String(e && e.message || e) }); }
};
module.exports.parseListings = parseListings;
module.exports.mapExportRow = mapExportRow;
module.exports.exportInput = exportInput;
