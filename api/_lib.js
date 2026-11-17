// Shared helpers for the Landscape API: Neon (accounts, credits, sessions), email codes, Stripe, Apify, plans.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const PLANS = {
  pack20:  { kind: 'pack', name: 'Landscape — 20 candidates',  amount: 500,  credits: 20 },
  pack40:  { kind: 'pack', name: 'Landscape — 40 candidates',  amount: 1000, credits: 40 },
  pack100: { kind: 'pack', name: 'Landscape — 100 candidates', amount: 2500, credits: 100 },
  starter: { kind: 'plan', name: 'Landscape Starter (100 candidates / month)', amount: 2000, credits: 100 },
  pro:     { kind: 'plan', name: 'Landscape Pro (220 candidates / month)',     amount: 4000, credits: 220 },
  max:     { kind: 'plan', name: 'Landscape Max (360 candidates / month)',     amount: 6000, credits: 360 },
};
// Usage limits per account plan (per calendar day, server time). Credits still cap total volume; these stop bursts.
const LIMITS = {
  free:    { searches_per_day: 3,  previews_per_hour: 6,  lookups_per_day: 10 },
  starter: { searches_per_day: 10, previews_per_hour: 10, lookups_per_day: 30 },
  pro:     { searches_per_day: 20, previews_per_hour: 15, lookups_per_day: 60 },
  max:     { searches_per_day: 40, previews_per_hour: 20, lookups_per_day: 120 },
  owner:   { searches_per_day: 60, previews_per_hour: 30, lookups_per_day: 200 },
};
// Estimated cost of each call to the records source, in dollars (what the budget counts).
const COST = { export_row: 0.02, lookup_row: 0.05, run_overhead: 0.005 };
const SCHEMA_VERSION = 2;

const env = k => (process.env[k] || '').trim();
const need = k => { const v = env(k); if (!v) throw new Error(`${k} is not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.`); return v; };
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- Neon (Postgres over HTTP) ----------
// Vercel's Neon integration sets DATABASE_URL (and POSTGRES_URL). Either works.
let _sql = null, _schemaReady = null;
function sql() {
  if (_sql) return _sql;
  const url = env('DATABASE_URL') || env('POSTGRES_URL') || env('DATABASE_URL_UNPOOLED');
  if (!url) throw new Error('No database yet. In Vercel → Storage, add Neon to this project (it sets DATABASE_URL), then redeploy.');
  _sql = neon(url);
  return _sql;
}
// The schema file is idempotent; apply it once per warm instance so a fresh database just works.
async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const q = sql();
    const have = await q`select to_regclass('public.meta') as t`;
    if (have[0] && have[0].t) {
      const v = await q`select value from meta where key = 'schema_version'`;
      if (v[0] && Number(v[0].value) >= SCHEMA_VERSION) return;
    }
    const file = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    // Split on statement ends that are not inside a function body ($$ ... $$).
    const stmts = []; let buf = '', inBody = false;
    for (const line of file.split('\n')) {
      if (/^\s*--/.test(line) && !inBody) continue;
      buf += line + '\n';
      const dollars = (line.match(/\$\$/g) || []).length; if (dollars % 2 === 1) inBody = !inBody;
      if (!inBody && /;\s*$/.test(line)) { stmts.push(buf.trim()); buf = ''; }
    }
    for (const s of stmts) if (s) await q.query(s);
    await q`insert into meta (key, value) values ('schema_version', ${String(SCHEMA_VERSION)}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  })().catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}
// Tagged-template query with schema guarantee: const rows = await L.q`select ...`
async function q(strings, ...values) { await ensureSchema(); return sql()(strings, ...values); }
async function rpc(fn, args) {
  await ensureSchema();
  const rows = await sql().query(`select * from ${fn}($1, $2, $3, $4)`, [args.p_user, args.p_amount, args.p_reason, args.p_ref || '']);
  return rows[0];
}

// ---------- Accounts & sessions ----------
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const isOwner = email => env('OWNER_EMAILS').toLowerCase().split(/[,\s]+/).filter(Boolean).includes(normEmail(email));

async function userFromReq(req) {
  // Returns {id, email, plan}; plan feeds the per-plan limits.
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token || token.length < 20) return null;
  const rows = await q`select s.user_id, p.email, p.plan from sessions s join profiles p on p.user_id = s.user_id where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
  if (!rows.length) return null;
  q`update sessions set last_seen = now() where token_hash = ${sha256(token)}`.catch(() => {});
  return { id: rows[0].user_id, email: rows[0].email, plan: rows[0].plan };
}
async function getProfile(user) {
  const rows = await q`select * from profiles where user_id = ${user.id}`;
  return rows[0];
}
async function getOrCreateProfileByEmail(email) {
  const rows = await q`insert into profiles (email, credits) values (${email}, ${Number(env('FREE_CREDITS') || 0)}) on conflict (email) do update set updated_at = now() returning *`;
  return rows[0];
}
function publicProfile(p, user) {
  return { email: p.email, plan: p.plan, credits: isOwner(user.email) ? 999999 : p.credits, renews_at: p.renews_at, has_subscription: !!p.stripe_subscription_id, owner: isOwner(user.email) };
}

// Sign-in code: 6 digits, 10 minutes, 5 tries, at most 5 codes per address per hour.
async function startLogin(email) {
  email = normEmail(email);
  if (!validEmail(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  const recent = await q`select count(*)::int as n from login_codes where email = ${email} and created_at > now() - interval '1 hour'`;
  if (recent[0].n >= 5) throw Object.assign(new Error('Too many codes requested for this address. Try again in an hour.'), { status: 429 });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await q`update login_codes set used_at = now() where email = ${email} and used_at is null`;
  await q`insert into login_codes (email, code_hash, expires_at) values (${email}, ${sha256(email + ':' + code)}, now() + interval '10 minutes')`;
  const sent = await sendCode(email, code);
  // With no mail provider configured yet, the owner can still get in: the code comes back in the response.
  if (!sent && !isOwner(email)) throw Object.assign(new Error('Sign-in emails are not switched on yet. The site owner needs to add RESEND_API_KEY in Vercel.'), { status: 503 });
  return { sent, dev_code: !sent ? code : undefined };
}
async function verifyLogin(email, code) {
  email = normEmail(email); code = String(code || '').replace(/\D/g, '');
  if (!validEmail(email) || code.length !== 6) throw Object.assign(new Error('Enter the 6-digit code from the email.'), { status: 400 });
  const rows = await q`select id, code_hash, attempts from login_codes where email = ${email} and used_at is null and expires_at > now() order by created_at desc limit 1`;
  const row = rows[0];
  if (!row) throw Object.assign(new Error('That code expired. Request a new one.'), { status: 400 });
  if (row.attempts >= 5) { await q`update login_codes set used_at = now() where id = ${row.id}`; throw Object.assign(new Error('Too many tries. Request a new code.'), { status: 429 }); }
  if (row.code_hash !== sha256(email + ':' + code)) { await q`update login_codes set attempts = attempts + 1 where id = ${row.id}`; throw Object.assign(new Error('That code is not right. Check the email and try again.'), { status: 400 }); }
  await q`update login_codes set used_at = now() where id = ${row.id}`;
  const prof = await getOrCreateProfileByEmail(email);
  const token = crypto.randomBytes(32).toString('base64url');
  await q`insert into sessions (token_hash, user_id, expires_at) values (${sha256(token)}, ${prof.user_id}, now() + interval '90 days')`;
  return { token, profile: prof };
}
async function logout(req) {
  const h = req.headers.authorization || ''; const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (token) await q`delete from sessions where token_hash = ${sha256(token)}`;
}

// ---------- Email (Resend) ----------
async function sendCode(email, code) {
  const key = env('RESEND_API_KEY'); if (!key) return false;
  const from = env('MAIL_FROM') || 'Landscape <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: `${code} is your Landscape sign-in code`,
      text: `Your Landscape sign-in code is ${code}. It works for 10 minutes.\n\nIf you didn't request it, you can ignore this email.`,
      html: `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><p style="color:#555">Your Landscape sign-in code</p><p style="font-size:34px;letter-spacing:6px;font-weight:700;margin:8px 0 16px">${code}</p><p style="color:#555">It works for 10 minutes. If you didn't request it, ignore this email.</p></div>` }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Could not send the email (${r.status}): ${t.slice(0, 160)}`); }
  return true;
}


// ---------- Guardrails: environment switch, dollar budgets, per-user limits ----------
const vercelEnv = () => env('VERCEL_ENV') || 'development';
const isProd = () => vercelEnv() === 'production';
function budgets() {
  // Production must opt in with a budget; preview/dev get a small default so testing can't run away either.
  const monthly = Number(env('APIFY_MONTHLY_BUDGET_USD') || (isProd() ? 0 : 10));
  const daily = Number(env('APIFY_DAILY_BUDGET_USD') || Math.max(1, monthly / 4));
  return { monthly, daily };
}
function nationwideEnabled() {
  if (!env('APIFY_TOKEN')) return { ok: false, why: 'APIFY_TOKEN is not set for this environment.' };
  if (isProd() && env('NATIONWIDE_ENABLED') !== 'true') return { ok: false, why: 'Nationwide search is not switched on in production yet (set NATIONWIDE_ENABLED=true and APIFY_MONTHLY_BUDGET_USD).' };
  if (isProd() && !(budgets().monthly > 0)) return { ok: false, why: 'Set APIFY_MONTHLY_BUDGET_USD before enabling nationwide search in production.' };
  return { ok: true };
}
async function spend(kind, sinceSql) {
  const rows = await q`select coalesce(sum(cost_usd), 0)::float as usd, count(*)::int as n from usage_events where created_at >= ${sinceSql}::timestamptz and (${kind}::text is null or kind = ${kind})`;
  return rows[0];
}
const startOfMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
const startOfDay = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); };
async function usageSummary() {
  const [m, d] = await Promise.all([spend(null, startOfMonth()), spend(null, startOfDay())]);
  const b = budgets();
  const running = await q`select count(*)::int as n from searches where status = 'running' and created_at > now() - interval '1 hour'`;
  const byKind = await q`select kind, count(*)::int as n, coalesce(sum(cost_usd),0)::float as usd, coalesce(sum(records),0)::int as records from usage_events where created_at >= ${startOfMonth()}::timestamptz group by kind order by usd desc`;
  const topUsers = await q`select p.email, count(*)::int as n, coalesce(sum(u.cost_usd),0)::float as usd from usage_events u join profiles p on p.user_id = u.user_id where u.created_at >= ${startOfMonth()}::timestamptz group by p.email order by usd desc limit 10`;
  return { env: vercelEnv(), enabled: nationwideEnabled(), budget: b, month: { usd: m.usd, calls: m.n }, today: { usd: d.usd, calls: d.n }, running: running[0].n, by_kind: byKind, top_users: topUsers, limits: LIMITS, cost: COST };
}
// Throws a friendly error when a call must not go ahead. `estimate` is the worst-case dollars this call can cost.
async function guard(user, kind, estimate) {
  const en = nationwideEnabled();
  if (!en.ok) throw Object.assign(new Error(isOwner(user.email) ? en.why : 'Nationwide search is not available right now.'), { status: 503 });
  const b = budgets();
  const [m, d] = await Promise.all([spend(null, startOfMonth()), spend(null, startOfDay())]);
  if (b.monthly > 0 && m.usd + estimate > b.monthly) { await alertBudget('monthly', m.usd, b.monthly).catch(() => {}); throw Object.assign(new Error(isOwner(user.email) ? `Monthly data budget reached ($${m.usd.toFixed(2)} of $${b.monthly}). Raise APIFY_MONTHLY_BUDGET_USD to continue.` : 'The records service has reached its monthly limit. Please try again after the 1st, or contact support.'), { status: 503 }); }
  if (b.daily > 0 && d.usd + estimate > b.daily) { await alertBudget('daily', d.usd, b.daily).catch(() => {}); throw Object.assign(new Error(isOwner(user.email) ? `Daily data budget reached ($${d.usd.toFixed(2)} of $${b.daily}).` : 'The records service has reached its daily limit. Please try again tomorrow.'), { status: 503 }); }
  const plan = isOwner(user.email) ? 'owner' : (user.plan || 'free'); const lim = LIMITS[plan] || LIMITS.free;
  if (kind === 'search') {
    const running = await q`select count(*)::int as n from searches where user_id = ${user.id} and status = 'running' and created_at > now() - interval '30 minutes'`;
    if (running[0].n >= 1) throw Object.assign(new Error('You already have a search running — wait for it to finish.'), { status: 429 });
    const today = await q`select count(*)::int as n from usage_events where user_id = ${user.id} and kind = 'search' and created_at >= ${startOfDay()}::timestamptz`;
    if (today[0].n >= lim.searches_per_day) throw Object.assign(new Error(`Daily limit reached: ${lim.searches_per_day} searches a day on your plan. It resets at midnight UTC.`), { status: 429 });
  }
  if (kind === 'preview') {
    const hr = await q`select count(*)::int as n from usage_events where user_id = ${user.id} and kind = 'preview' and created_at > now() - interval '1 hour'`;
    if (hr[0].n >= lim.previews_per_hour) throw Object.assign(new Error(`Too many previews this hour (${lim.previews_per_hour} max on your plan).`), { status: 429 });
  }
  if (kind === 'lookup') {
    const today = await q`select count(*)::int as n from usage_events where user_id = ${user.id} and kind = 'lookup' and created_at >= ${startOfDay()}::timestamptz`;
    if (today[0].n >= lim.lookups_per_day) throw Object.assign(new Error(`Daily limit reached: ${lim.lookups_per_day} owner lookups a day on your plan.`), { status: 429 });
  }
  // Warn the owner once a day when 80% of the month is gone.
  if (b.monthly > 0 && m.usd + estimate > 0.8 * b.monthly) alertBudget('monthly-80', m.usd, b.monthly).catch(() => {});
}
async function recordUsage(user, kind, cost, records = 0, jobId = null) {
  const rows = await q`insert into usage_events (user_id, kind, job_id, records, cost_usd, env) values (${user ? user.id : null}, ${kind}, ${jobId}, ${records}, ${Number(cost.toFixed(4))}, ${vercelEnv()}) returning id`;
  return rows[0].id;
}
async function settleUsage(eventId, cost, records) {
  await q`update usage_events set cost_usd = ${Number(cost.toFixed(4))}, records = ${records} where id = ${eventId}`;
}
async function alertBudget(which, used, limit) {
  const owners = env('OWNER_EMAILS').split(/[,\s]+/).filter(Boolean); if (!owners.length || !env('RESEND_API_KEY')) return;
  const key = `alert:${which}:${new Date().toISOString().slice(0, 10)}`;
  const sent = await q`insert into meta (key, value) values (${key}, 'sent') on conflict (key) do nothing returning key`;
  if (!sent.length) return;
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('MAIL_FROM') || 'Landscape <onboarding@resend.dev>', to: owners, subject: `Landscape: ${which} data budget at $${used.toFixed(2)} of $${limit} (${vercelEnv()})`, text: `The records source (Apify) has used $${used.toFixed(2)} of the $${limit} ${which.replace('-80', '')} budget in ${vercelEnv()}. Searches stop when the budget is reached. Adjust APIFY_MONTHLY_BUDGET_USD / APIFY_DAILY_BUDGET_USD in Vercel if that is intended.` }) }).catch(() => {});
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
async function stripe(p, body) {
  const r = await fetch(`https://api.stripe.com/v1/${p}`, { method: 'POST', headers: { Authorization: `Bearer ${need('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
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
  const qs = new URLSearchParams({ token: need('APIFY_TOKEN') });
  if (opts.timeout) qs.set('timeout', String(opts.timeout));
  if (opts.maxTotalChargeUsd) qs.set('maxTotalChargeUsd', String(opts.maxTotalChargeUsd));
  if (opts.memory) qs.set('memory', String(opts.memory));
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Records source could not start (${r.status}): ${(j.error && j.error.message) || 'check APIFY_TOKEN'}`);
  return j.data;
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
async function apifyRunSync(actor, input, opts = {}) {
  const qs = new URLSearchParams({ token: need('APIFY_TOKEN'), timeout: String(opts.timeout || 60), clean: 'true', format: 'json' });
  if (opts.maxTotalChargeUsd) qs.set('maxTotalChargeUsd', String(opts.maxTotalChargeUsd));
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (r.status === 408) throw new Error('The records source took too long to answer. Try again in a minute.');
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Records source error (${r.status}): ${(j && j.error && j.error.message) || 'check APIFY_TOKEN'}`);
  return Array.isArray(j) ? j : [];
}

module.exports = { PLANS, LIMITS, COST, env, need, vercelEnv, isProd, budgets, nationwideEnabled, usageSummary, guard, recordUsage, settleUsage, q, rpc, ensureSchema, userFromReq, isOwner, getProfile, publicProfile, startLogin, verifyLogin, logout, stripe, verifyStripeSignature, apifyStart, apifyRun, apifyItems, apifyRunSync };
