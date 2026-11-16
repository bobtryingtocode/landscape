// Shared helpers for the Landscape API: Supabase (accounts + credits), Stripe (billing), plans.
// No npm dependencies — everything goes through fetch so the repo deploys on Vercel with zero build.
const crypto = require('crypto');

const PLANS = {
  pack20:  { kind: 'pack', name: 'Landscape — 20 candidates',  amount: 500,  credits: 20 },
  pack40:  { kind: 'pack', name: 'Landscape — 40 candidates',  amount: 1000, credits: 40 },
  pack100: { kind: 'pack', name: 'Landscape — 100 candidates', amount: 2500, credits: 100 },
  starter: { kind: 'plan', name: 'Landscape Starter (100 candidates / month)', amount: 2000, credits: 100 },
  pro:     { kind: 'plan', name: 'Landscape Pro (220 candidates / month)',     amount: 4000, credits: 220 },
  max:     { kind: 'plan', name: 'Landscape Max (360 candidates / month)',     amount: 6000, credits: 360 },
};

const env = k => (process.env[k] || '').trim();
const need = k => { const v = env(k); if (!v) throw new Error(`${k} is not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.`); return v; };

// ---------- Supabase (service role, server side only) ----------
async function sb(path, opts = {}) {
  const url = need('SUPABASE_URL').replace(/\/$/, ''), key = need('SUPABASE_SERVICE_KEY');
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = t; }
  if (!r.ok) throw new Error(`Database error ${r.status}: ${typeof j === 'string' ? j.slice(0, 200) : (j && (j.message || j.hint || j.details)) || t.slice(0, 200)}`);
  return j;
}
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: args, prefer: 'return=representation' });

// Verify the browser's Supabase session token and return {id, email}.
async function userFromReq(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const url = need('SUPABASE_URL').replace(/\/$/, '');
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: need('SUPABASE_SERVICE_KEY'), Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? { id: u.id, email: (u.email || '').toLowerCase() } : null;
}
const isOwner = email => env('OWNER_EMAILS').toLowerCase().split(/[,\s]+/).filter(Boolean).includes((email || '').toLowerCase());

async function getProfile(user) {
  const rows = await sb(`profiles?user_id=eq.${user.id}&select=*`);
  if (rows && rows.length) return rows[0];
  const made = await sb('profiles', { method: 'POST', body: { user_id: user.id, email: user.email, plan: 'free', credits: Number(env('FREE_CREDITS') || 0) } });
  return made[0];
}
function publicProfile(p, user) {
  return { email: p.email, plan: p.plan, credits: isOwner(user.email) ? 999999 : p.credits, renews_at: p.renews_at, has_subscription: !!p.stripe_subscription_id, owner: isOwner(user.email) };
}

// ---------- Stripe (REST, form-encoded) ----------
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}
async function stripe(path, body) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${need('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe: ${(j.error && j.error.message) || r.status}`);
  return j;
}
function verifyStripeSignature(raw, header, secret) {
  const parts = Object.fromEntries((header || '').split(',').map(p => p.split('=').map(s => s.trim())));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch (_) { return false; }
}


// ---------- Apify (REST) ----------
async function apifyStart(actor, input, opts = {}) {
  const q = new URLSearchParams({ token: need('APIFY_TOKEN') });
  if (opts.timeout) q.set('timeout', String(opts.timeout));
  if (opts.maxTotalChargeUsd) q.set('maxTotalChargeUsd', String(opts.maxTotalChargeUsd));
  if (opts.memory) q.set('memory', String(opts.memory));
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Records source could not start (${r.status}): ${(j.error && j.error.message) || 'check APIFY_TOKEN'}`);
  return j.data; // {id, status, defaultDatasetId, ...}
}
async function apifyRun(runId) {
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${need('APIFY_TOKEN')}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Could not check the search (${r.status})`);
  return j.data;
}
async function apifyItems(datasetId, limit = 1000) {
  const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${need('APIFY_TOKEN')}&clean=true&format=json&limit=${limit}`);
  if (!r.ok) throw new Error(`Could not read the results (${r.status})`);
  return r.json();
}
// Start a run and wait for it inside one request (only for runs that finish in well under a minute).
async function apifyRunSync(actor, input, opts = {}) {
  const q = new URLSearchParams({ token: need('APIFY_TOKEN'), timeout: String(opts.timeout || 60), clean: 'true', format: 'json' });
  if (opts.maxTotalChargeUsd) q.set('maxTotalChargeUsd', String(opts.maxTotalChargeUsd));
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (r.status === 408) throw new Error('The records source took too long to answer. Try again in a minute.');
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Records source error (${r.status}): ${(j && j.error && j.error.message) || 'check APIFY_TOKEN'}`);
  return Array.isArray(j) ? j : [];
}

module.exports = { apifyStart, apifyRun, apifyItems, apifyRunSync, PLANS, env, need, sb, rpc, userFromReq, isOwner, getProfile, publicProfile, stripe, verifyStripeSignature };
