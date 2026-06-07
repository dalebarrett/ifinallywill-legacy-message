// ════════════════════════════════════════════════════════════════════════
// legacy-billing.js — Stripe + PayPal subscriptions, entitlements, discounts
//
// Source of truth: Stripe/PayPal hold prices, coupons, and subscriptions.
// A per-user mirror lives in Clerk privateMetadata.subscription (synced by
// webhooks) so the app can check entitlement instantly without an API call.
//
// Everything degrades gracefully without keys (like Resend/Twilio): checkout
// returns a clear "not configured" error and the rest of the app is unaffected.
// ════════════════════════════════════════════════════════════════════════

const { clerkClient } = require('@clerk/express');

const APP_URL = (process.env.APP_URL || 'https://legacy-message.vercel.app').replace(/\/$/, '');

// ─── Plan catalog ─────────────────────────────────────────────────────────
// Display/config lives here; the actual charge uses the Stripe Price ID (and
// PayPal plan ID) pulled from env, so pricing is managed in Stripe/PayPal.
const PLANS = [
  {
    id: 'free', name: 'Free', priceCents: 0, interval: null, badge: null,
    blurb: 'Write and safely store your legacy letter.',
    features: ['Write unlimited chapters', 'Voice & text', 'AI writing guide', 'Private cloud autosave'],
  },
  {
    id: 'premium_monthly', name: 'Premium', priceCents: 900, interval: 'month',
    stripePriceEnv: 'STRIPE_PRICE_PREMIUM_MONTHLY', paypalPlanEnv: 'PAYPAL_PLAN_PREMIUM_MONTHLY',
    blurb: 'The full vault — delivered to your people when it matters.', badge: 'Most popular',
    features: ['Everything in Free', 'Scheduled & life-event delivery', 'Executors & trusted contacts', "Dead-man's-switch", 'Audio/video message delivery', 'Recipient portal'],
  },
  {
    id: 'premium_annual', name: 'Premium (Annual)', priceCents: 7900, interval: 'year',
    stripePriceEnv: 'STRIPE_PRICE_PREMIUM_ANNUAL', paypalPlanEnv: 'PAYPAL_PLAN_PREMIUM_ANNUAL',
    blurb: 'Premium, billed yearly — two months free.', badge: 'Best value',
    features: ['Everything in Premium', 'Save 27% vs monthly'],
  },
  {
    id: 'lifetime', name: 'Lifetime', priceCents: 19900, interval: 'one_time',
    stripePriceEnv: 'STRIPE_PRICE_LIFETIME', paypalPlanEnv: null,
    blurb: 'Pay once. Your letter is kept and delivered, forever.', badge: null,
    features: ['Everything in Premium', 'One payment, no renewals', 'Lifetime storage & delivery'],
  },
];
function planById(id) { return PLANS.find((p) => p.id === id) || null; }
function stripePriceId(plan) { return plan && plan.stripePriceEnv ? process.env[plan.stripePriceEnv] || null : null; }
function paypalPlanId(plan) { return plan && plan.paypalPlanEnv ? process.env[plan.paypalPlanEnv] || null : null; }
function formatPrice(cents) {
  if (cents === 0) return 'Free';
  return '$' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}
function publicPlans() {
  return PLANS.map((p) => ({
    id: p.id, name: p.name, priceCents: p.priceCents, price: formatPrice(p.priceCents),
    interval: p.interval, badge: p.badge, blurb: p.blurb, features: p.features,
    stripeReady: !!stripePriceId(p), paypalReady: !!paypalPlanId(p),
  }));
}

// ─── Stripe client (lazy) ─────────────────────────────────────────────────
let _stripe = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
function stripeConfigured() { return !!process.env.STRIPE_SECRET_KEY; }
function paypalConfigured() { return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET); }

// ─── Entitlement: is this user premium right now? ─────────────────────────
function entitlement(meta) {
  const sub = (meta && meta.subscription) || {};
  const now = Date.now();
  // IFW will-grant (pushed by IFW or persisted from a pull) — premium, free.
  const g = meta && meta.ifwGrant;
  if (g && g.status === 'active' && g.willCustomer) {
    const ok = !g.currentPeriodEnd || new Date(g.currentPeriodEnd).getTime() > now - 3 * 86400000;
    if (ok) return { premium: true, plan: 'will_grant', status: 'active', source: g.source || 'will_grant' };
  }
  if (sub.compedUntil && new Date(sub.compedUntil).getTime() > now) {
    return { premium: true, plan: sub.plan || 'comp', status: 'comped', source: 'comp', since: sub.compedAt || null };
  }
  if (sub.plan === 'lifetime' && (sub.status === 'active' || sub.status === 'comped')) {
    return { premium: true, plan: 'lifetime', status: 'active', source: sub.provider || 'stripe' };
  }
  const activeish = sub.status === 'active' || sub.status === 'trialing';
  if (activeish && sub.plan && sub.plan !== 'free') {
    // 3-day grace past period end to survive webhook lag
    const ok = !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd).getTime() > now - 3 * 86400000;
    if (ok) return { premium: true, plan: sub.plan, status: sub.status, source: sub.provider || 'stripe', currentPeriodEnd: sub.currentPeriodEnd || null };
  }
  return { premium: false, plan: 'free', status: sub.status || 'none' };
}
// Enforcement is a single switch so it never accidentally paywalls pre-launch.
function billingEnforced() { return process.env.BILLING_ENFORCE === 'true'; }

// ─── Clerk metadata helpers ───────────────────────────────────────────────
async function getMeta(userId) {
  const u = await clerkClient.users.getUser(userId);
  return { user: u, meta: u.privateMetadata || {} };
}
async function setSubscription(userId, sub) {
  const { meta } = await getMeta(userId);
  meta.subscription = { ...(meta.subscription || {}), ...sub, updatedAt: new Date().toISOString() };
  await clerkClient.users.updateUserMetadata(userId, { privateMetadata: meta });
  return meta.subscription;
}

// ─── Stripe: get-or-create a customer tied to the Clerk user ──────────────
async function ensureStripeCustomer(userId, user) {
  const s = stripe();
  const { meta } = await getMeta(userId);
  if (meta.subscription && meta.subscription.stripeCustomerId) return meta.subscription.stripeCustomerId;
  const email = user.emailAddresses?.[0]?.emailAddress;
  const customer = await s.customers.create({
    email,
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
    metadata: { clerkUserId: userId },
  });
  await setSubscription(userId, { stripeCustomerId: customer.id });
  return customer.id;
}

// ─── Stripe: Checkout Session for a plan ──────────────────────────────────
async function createCheckout({ userId, user, planId, promoCode }) {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  const plan = planById(planId);
  if (!plan || plan.id === 'free') throw new Error('Invalid plan');
  const priceId = stripePriceId(plan);
  if (!priceId) throw new Error(`No Stripe price configured for "${plan.name}" (set ${plan.stripePriceEnv}).`);

  const customer = await ensureStripeCustomer(userId, user);
  const mode = plan.interval === 'one_time' ? 'payment' : 'subscription';
  const params = {
    mode,
    customer,
    client_reference_id: userId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL}/?billing=success`,
    cancel_url: `${APP_URL}/?billing=cancelled`,
    allow_promotion_codes: !promoCode, // show the field, OR apply one we were given
    metadata: { clerkUserId: userId, planId: plan.id, app: 'legacy' },
  };
  if (mode === 'subscription') params.subscription_data = { metadata: { clerkUserId: userId, planId: plan.id, app: 'legacy' } };
  if (promoCode) {
    const promos = await s.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
    if (!promos.data.length) throw new Error('That discount code is not valid.');
    params.discounts = [{ promotion_code: promos.data[0].id }];
    delete params.allow_promotion_codes;
  }
  const session = await s.checkout.sessions.create(params);
  return { url: session.url, id: session.id };
}

// ─── Stripe: Billing Portal (manage / cancel) ─────────────────────────────
async function createPortal({ userId, user }) {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  const customer = await ensureStripeCustomer(userId, user);
  const session = await s.billingPortal.sessions.create({ customer, return_url: `${APP_URL}/` });
  return { url: session.url };
}

// ─── Stripe: map a subscription/checkout object → our plan id ─────────────
function planIdFromStripe(obj) {
  if (obj.metadata && obj.metadata.planId) return obj.metadata.planId;
  const priceId = obj.items?.data?.[0]?.price?.id;
  if (priceId) {
    const p = PLANS.find((pl) => stripePriceId(pl) === priceId);
    if (p) return p.id;
  }
  return 'premium_monthly';
}

// ─── Stripe: webhook → sync to Clerk ──────────────────────────────────────
function verifyStripeEvent(rawBody, signature) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) throw new Error('Stripe webhook not configured');
  return s.webhooks.constructEvent(rawBody, signature, secret);
}
async function clerkUserIdForCustomer(customerId) {
  const s = stripe();
  try {
    const c = await s.customers.retrieve(customerId);
    return (c && c.metadata && c.metadata.clerkUserId) || null;
  } catch {
    return null;
  }
}
async function handleStripeEvent(event) {
  const s = stripe();
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.clerkUserId);
      if (!userId) break;
      if (obj.mode === 'payment') {
        // one-time (lifetime)
        await setSubscription(userId, { provider: 'stripe', plan: obj.metadata?.planId || 'lifetime', status: 'active', stripeCustomerId: obj.customer });
      } else if (obj.subscription) {
        const sub = await s.subscriptions.retrieve(obj.subscription);
        await syncStripeSubscription(userId, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = (obj.metadata && obj.metadata.clerkUserId) || (await clerkUserIdForCustomer(obj.customer));
      if (userId) await syncStripeSubscription(userId, obj);
      break;
    }
    case 'invoice.payment_failed': {
      const userId = await clerkUserIdForCustomer(obj.customer);
      if (userId) await setSubscription(userId, { status: 'past_due' });
      break;
    }
    default:
      break;
  }
  return { handled: true, type: event.type };
}
async function syncStripeSubscription(userId, sub) {
  const status = sub.status === 'canceled' ? 'canceled' : sub.status;
  await setSubscription(userId, {
    provider: 'stripe',
    plan: planIdFromStripe(sub),
    status,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  });
}

// ─── Discount codes (Stripe coupons + promotion codes) ────────────────────
async function listDiscountCodes() {
  const s = stripe();
  if (!s) return [];
  const promos = await s.promotionCodes.list({ limit: 50 });
  return promos.data.map((pc) => ({
    id: pc.id, code: pc.code, active: pc.active,
    percentOff: pc.coupon?.percent_off || null, amountOff: pc.coupon?.amount_off || null,
    maxRedemptions: pc.max_redemptions || null, timesRedeemed: pc.times_redeemed || 0,
    expiresAt: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
  }));
}
async function createDiscountCode({ code, percentOff, amountOff, maxRedemptions, durationMonths }) {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  const couponParams = {};
  if (percentOff) couponParams.percent_off = Number(percentOff);
  else if (amountOff) { couponParams.amount_off = Math.round(Number(amountOff) * 100); couponParams.currency = 'usd'; }
  else throw new Error('Provide a percent or amount off');
  couponParams.duration = durationMonths ? 'repeating' : 'once';
  if (durationMonths) couponParams.duration_in_months = Number(durationMonths);
  const coupon = await s.coupons.create(couponParams);
  const promoParams = { coupon: coupon.id };
  if (code) promoParams.code = code.toUpperCase();
  if (maxRedemptions) promoParams.max_redemptions = Number(maxRedemptions);
  const promo = await s.promotionCodes.create(promoParams);
  return { id: promo.id, code: promo.code };
}
async function deactivateDiscountCode(promoId) {
  const s = stripe();
  if (!s) throw new Error('Stripe is not configured');
  await s.promotionCodes.update(promoId, { active: false });
  return { ok: true };
}

// ─── PayPal (REST over fetch; no SDK) ─────────────────────────────────────
function paypalBase() {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID, sec = process.env.PAYPAL_SECRET;
  if (!id || !sec) throw new Error('PayPal not configured');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal auth failed');
  return (await r.json()).access_token;
}
async function createPaypalSubscription({ userId, planId }) {
  const plan = planById(planId);
  const ppPlan = paypalPlanId(plan);
  if (!ppPlan) throw new Error(`No PayPal plan configured for "${plan ? plan.name : planId}".`);
  const token = await paypalToken();
  const r = await fetch(`${paypalBase()}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan_id: ppPlan,
      custom_id: userId,
      application_context: { brand_name: 'Legacy Message', return_url: `${APP_URL}/?billing=success`, cancel_url: `${APP_URL}/?billing=cancelled` },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('PayPal: ' + (data.message || r.status));
  const approve = (data.links || []).find((l) => l.rel === 'approve');
  return { url: approve ? approve.href : null, id: data.id };
}
async function handlePaypalWebhook(body) {
  const event = body.event_type;
  const res = body.resource || {};
  const userId = res.custom_id || (res.subscriber && res.subscriber.custom_id);
  if (!userId) return { handled: false };
  if (event === 'BILLING.SUBSCRIPTION.ACTIVATED' || event === 'BILLING.SUBSCRIPTION.CREATED') {
    await setSubscription(userId, { provider: 'paypal', plan: 'premium_monthly', status: 'active', paypalSubscriptionId: res.id });
  } else if (event === 'BILLING.SUBSCRIPTION.CANCELLED' || event === 'BILLING.SUBSCRIPTION.EXPIRED' || event === 'BILLING.SUBSCRIPTION.SUSPENDED') {
    await setSubscription(userId, { status: 'canceled' });
  } else if (event === 'PAYMENT.SALE.COMPLETED') {
    await setSubscription(userId, { status: 'active' });
  }
  return { handled: true, type: event };
}

module.exports = {
  PLANS, planById, formatPrice, publicPlans, stripePriceId, paypalPlanId,
  stripe, stripeConfigured, paypalConfigured,
  entitlement, billingEnforced,
  getMeta, setSubscription,
  createCheckout, createPortal,
  verifyStripeEvent, handleStripeEvent, syncStripeSubscription,
  listDiscountCodes, createDiscountCode, deactivateDiscountCode,
  createPaypalSubscription, handlePaypalWebhook,
  APP_URL,
};
