// Stripe webhook — runs at /api/stripe-webhook. Adds credits when a pack is bought, and resets a
// subscriber's credits to their plan allowance on every monthly renewal (credits do not roll over).
// In Stripe → Developers → Webhooks, point an endpoint at https://<your-domain>/api/stripe-webhook with events:
//   checkout.session.completed, invoice.paid, customer.subscription.deleted
const L = require('./_lib');

module.exports.config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => { let d = ''; req.setEncoding('utf8'); req.on('data', c => { d += c; }); req.on('end', () => resolve(d)); req.on('error', reject); });
}
async function profileBy(field, value) {
  const rows = await L.sb(`profiles?${field}=eq.${encodeURIComponent(value)}&select=*`);
  return rows && rows[0];
}
async function setProfile(userId, patch) {
  await L.sb(`profiles?user_id=eq.${userId}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await rawBody(req);
  if (!L.verifyStripeSignature(raw, req.headers['stripe-signature'], L.need('STRIPE_WEBHOOK_SECRET'))) return res.status(400).json({ error: 'bad signature' });
  const ev = JSON.parse(raw);
  const o = ev.data && ev.data.object || {};
  try {
    // Idempotency: the same event can be delivered twice; the ledger's unique ref makes the second write a no-op.
    const ref = ev.id;
    if (ev.type === 'checkout.session.completed') {
      const userId = (o.metadata && o.metadata.user_id) || o.client_reference_id;
      const sku = o.metadata && o.metadata.sku; const plan = L.PLANS[sku];
      if (userId && plan) {
        if (o.customer) await setProfile(userId, { stripe_customer_id: o.customer });
        if (o.mode === 'payment') {
          await L.rpc('add_credits', { p_user: userId, p_amount: plan.credits, p_reason: `pack:${sku}`, p_ref: ref });
        } else if (o.mode === 'subscription') {
          await setProfile(userId, { plan: sku, stripe_subscription_id: o.subscription, renews_at: new Date(Date.now() + 30 * 864e5).toISOString() });
          await L.rpc('set_credits', { p_user: userId, p_amount: plan.credits, p_reason: `plan_start:${sku}`, p_ref: ref });
        }
      }
    } else if (ev.type === 'invoice.paid') {
      const subId = typeof o.subscription === 'string' ? o.subscription : (o.subscription && o.subscription.id);
      const reason = o.billing_reason || '';
      if (subId && /subscription_cycle|subscription_update/.test(reason)) {
        const prof = await profileBy('stripe_subscription_id', subId);
        const plan = prof && L.PLANS[prof.plan];
        if (prof && plan) {
          const end = (o.lines && o.lines.data && o.lines.data[0] && o.lines.data[0].period && o.lines.data[0].period.end) || null;
          await setProfile(prof.user_id, { renews_at: end ? new Date(end * 1000).toISOString() : null });
          await L.rpc('set_credits', { p_user: prof.user_id, p_amount: plan.credits, p_reason: `plan_renew:${prof.plan}`, p_ref: ref });
        }
      }
    } else if (ev.type === 'customer.subscription.deleted') {
      const prof = await profileBy('stripe_subscription_id', o.id);
      if (prof) await setProfile(prof.user_id, { plan: 'free', stripe_subscription_id: null, renews_at: null });
    }
    return res.json({ received: true });
  } catch (e) {
    // 500 makes Stripe retry later, which is what we want for a transient database error.
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
