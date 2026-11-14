// Landscape API — runs on Vercel at /api/landscape.
// Free path (no login):  NH assessor cards from Vision/VGSI, public listing pages parsed for address + price.
// Paid path (login):     nationwide parcel + owner records from Regrid, metered in credits (1 credit = 1 parcel record).
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
  if (!r.ok) throw new Error(`Assessor site returned ${r.status} for ${town}. This town may not use Vision (VGSI) — use "Find candidates" for nationwide records.`);
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

// ---------------- Regrid nationwide parcel + owner search (paid, metered) ----------------
const LAND_USE = {
  vacant: '9000,9999',       // LBCS activity: no human activity / vacant & unclassifiable
  residential: '1000,1999',  // household activities (homes of all kinds)
  single_family: '1100,1199',
  farm_forest: '8000,8999',  // agriculture, forestry, natural resources
  commercial: '2000,2999',
  any: null,
};
const pathSlug = s => String(s || '').toLowerCase().replace(/\bcounty\b|\bparish\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function regridSearch(q) {
  const token = L.need('REGRID_TOKEN');
  const st = String(q.state || '').trim().toLowerCase(); if (!/^[a-z]{2}$/.test(st)) throw new Error('Enter a two-letter state (for example NH or TX).');
  const count = Math.max(1, Math.min(100, parseInt(q.count) || 20));
  const p = new URLSearchParams({ token, limit: String(count), return_geometry: 'false', return_stacked: 'false' });
  let used = 0;
  if (q.county) p.set('path', `/us/${st}/${pathSlug(q.county)}`);
  else { p.set(`fields[state2][eq]`, st.toUpperCase()); used++; }
  if (q.city) { p.set(`fields[scity][ilike]`, String(q.city).trim()); used++; }
  const minac = parseFloat(q.min_acres) || 0, maxac = parseFloat(q.max_acres) || 0;
  if (minac && maxac) { p.set('fields[ll_gisacre][between]', `${minac},${maxac}`); used++; }
  else if (minac) { p.set('fields[ll_gisacre][gte]', String(minac)); used++; }
  else if (maxac) { p.set('fields[ll_gisacre][lte]', String(maxac)); used++; }
  const lu = LAND_USE[q.land_use || 'vacant'];
  if (lu && used < 4) { p.set('fields[lbcs_activity][between]', lu); used++; }
  const r = await fetch(`https://app.regrid.com/api/v2/parcels/query?${p}`, { headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Regrid returned ${r.status}: ${(j && (j.error || j.message)) || 'check REGRID_TOKEN and the county name'}`);
  const feats = (j.parcels && j.parcels.features) || j.features || [];
  return feats.map(f => mapRegrid(f)).filter(x => x.address);
}
function mapRegrid(f) {
  const d = (f.properties && (f.properties.fields || f.properties)) || {};
  const situs = norm(d.address), mail = norm(d.mailadd);
  const absentee = !!(situs && mail && situs !== mail);
  const saleYear = d.saledate ? parseInt(String(d.saledate).slice(0, 4)) : null;
  const acres = money(d.ll_gisacre) ?? money(d.gisacre) ?? money(d.deeded_acres) ?? null;
  return {
    address: d.address || '', town: d.scity || '', state: d.state2 || '', zip: d.szip || '', county: d.county || '',
    owner: d.owner || '', owner_mail: [d.mailadd, d.mail_city, d.mail_state2, d.mail_zip].filter(Boolean).join(', '), absentee,
    acres: acres ? Math.round(acres * 100) / 100 : null, assessed_total: money(d.parval), assessed_land: money(d.landval), assessed_improvements: money(d.improvval),
    land_use: d.usedesc || d.lbcs_activity_desc || d.zoning_description || '', use_code: d.usecode || '', zone: d.zoning || '',
    year_built: money(d.yearbuilt), sqft: money(d.sqft), year_acquired: saleYear && saleYear > 1800 ? saleYear : null, price_paid: money(d.saleprice),
    how_acquired: howAcquired(d.owner, money(d.saleprice)), lat: d.lat, lon: d.lon, parcel_number: d.parcelnumb || '', regrid_id: d.ll_uuid || '',
    source: f.properties && f.properties.path ? `https://app.regrid.com${f.properties.path}` : 'https://app.regrid.com',
  };
}

// ---------------- Accounts, credits, billing ----------------
async function requireUser(req) {
  const u = await L.userFromReq(req);
  if (!u) { const e = new Error('Sign in to use nationwide records and credits.'); e.status = 401; throw e; }
  return u;
}
async function spend(user, count, ref) {
  if (L.isOwner(user.email)) return { credits: 999999 };
  const r = await L.rpc('spend_credits', { p_user: user.id, p_amount: count, p_reason: 'regrid_search', p_ref: ref || '' });
  const row = Array.isArray(r) ? r[0] : r;
  if (!row || row.ok === false) { const e = new Error(`Not enough credits — this search needs ${count} and you have ${row ? row.credits : 0}. Buy a pack or pick a plan below.`); e.status = 402; throw e; }
  return row;
}
async function refund(user, count, ref) {
  if (L.isOwner(user.email) || !count) return;
  await L.rpc('add_credits', { p_user: user.id, p_amount: count, p_reason: 'refund_short_results', p_ref: ref || '' });
}
async function checkout(user, sku, origin) {
  const plan = L.PLANS[sku]; if (!plan) throw new Error('Unknown plan.');
  const prof = await L.getProfile(user);
  const base = (L.env('APP_URL') || origin || '').replace(/\/$/, '');
  const body = {
    mode: plan.kind === 'plan' ? 'subscription' : 'payment',
    success_url: `${base}/?paid=${sku}`, cancel_url: `${base}/?canceled=1`,
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
      case 'me': { const u = await requireUser(req); return res.json(L.publicProfile(await L.getProfile(u), u)); }
      case 'plans': return res.json({ plans: Object.entries(L.PLANS).map(([sku, p]) => ({ sku, kind: p.kind, name: p.name, price: p.amount / 100, credits: p.credits })) });
      case 'checkout': { const u = await requireUser(req); return res.json(await checkout(u, b.sku, origin)); }
      case 'portal': { const u = await requireUser(req); return res.json(await portal(u, origin)); }
      // ---- paid: nationwide search, 1 credit per parcel record returned ----
      case 'regrid': {
        const u = await requireUser(req);
        const count = Math.max(1, Math.min(100, parseInt(b.count) || 20));
        const ref = `${b.state || ''}/${b.county || b.city || ''}/${Date.now()}`;
        const paid = await spend(u, count, ref);
        let rows;
        try { rows = await regridSearch({ ...b, count }); }
        catch (e) { await refund(u, count, ref).catch(() => {}); throw e; }
        if (rows.length < count) await refund(u, count - rows.length, ref).catch(() => {});
        const prof = await L.getProfile(u);
        try { await L.sb('searches', { method: 'POST', prefer: 'return=minimal', body: { user_id: u.id, params: { state: b.state, county: b.county, city: b.city, land_use: b.land_use, min_acres: b.min_acres, max_acres: b.max_acres }, records: rows.length } }); } catch (_) {}
        return res.json({ parcels: rows, charged: rows.length, credits: L.isOwner(u.email) ? 999999 : prof.credits, requested: count });
      }
      default: return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) { return res.status(e.status || 500).json({ error: String(e && e.message || e) }); }
};
module.exports.parseListings = parseListings;
module.exports.mapRegrid = mapRegrid;
