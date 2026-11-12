// One catch-all function = one serverless function (Hobby plan friendly). Routes registered below.
import { timingSafeEqual, createHmac, randomInt, randomBytes } from 'node:crypto';
import { sql, init } from '../lib/db.js';
import * as M from '../lib/mollie.js';
import { email as sendEmail, notifyPaid, notifyReady, notifyAccepted, notifyRefund, notifyMerchantNew, notifyDisputeOpened, notifyDisputeResult, notifyAdminComplaint, notifyAdminRefund, pushTest, customerCodeHtml, merchantLinkHtml } from '../lib/notify.js';
import { slots, catAvailable, priceLine, totals, londonNow, toMins, discountFor, gross, refundAmount, FEE_RATE, REDUCED_FEE_RATE } from '../public/pricing.js';
import { ask, systemPrompt } from '../lib/support.js';
import { cleanAllergens, cleanDietary } from '../public/allergens.js';
import { ticket } from '../lib/ticket.js';
import * as W from '../lib/wallet.js';
import * as Q from '../lib/scanq.js';
import * as D from '../lib/desk.js';

const { BASE_URL, SESSION_SECRET, VAPID_PUBLIC_KEY } = process.env;
// Three sites share this one deployment: customers (BASE_URL = app.placemyorder.online), cafés (MERCHANT_URL) and the owner (ADMIN_URL). Unset = path-based (/m/, /admin/) on BASE_URL.
const MURL = (process.env.MERCHANT_URL || BASE_URL + '/m').replace(/\/$/, ''), AURL = (process.env.ADMIN_URL || BASE_URL + '/admin').replace(/\/$/, '');
const CK = process.env.COOKIE_DOMAIN ? `; Domain=${process.env.COOKIE_DOMAIN}` : ''; // e.g. .placemyorder.online so a café signed in on merchant.* is also signed in on admin.*
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const str = (s, n) => String(s ?? '').trim().slice(0, n);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const gbp = (p) => '£' + (p / 100).toFixed(2);

// ---------- session (HMAC-signed cookie) ----------
const mac = (b) => createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
const sign = (o) => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b}.${mac(b)}`; };
function verify(s) {
  const [b, h] = (s || '').split('.');
  if (!b || !h || h.length !== mac(b).length || !timingSafeEqual(Buffer.from(h), Buffer.from(mac(b)))) return null;
  const o = JSON.parse(Buffer.from(b, 'base64url')); return o.exp > Date.now() ? o : null;
}
const cookie = (req, k) => (req.headers.cookie || '').split('; ').map((c) => c.split('=')).find(([n]) => n === k)?.[1];
const setSession = (res, id) => res.setHeader('Set-Cookie', `sid=${id ? sign({ m: id, exp: Date.now() + 30 * 864e5 }) : ''}; HttpOnly; Secure; SameSite=Lax; Path=/${CK}; Max-Age=${id ? 2592000 : 0}`);

// Customer accounts: email + 6-digit emailed code -> signed 'cid' cookie. Favourites and loyalty stamps belong to the account email.
const who = (req) => verify(cookie(req, 'cid'))?.c || null;
const setCust = (res, email) => res.setHeader('Set-Cookie', `cid=${email ? sign({ c: email, exp: Date.now() + 365 * 864e5 }) : ''}; HttpOnly; Secure; SameSite=Lax; Path=/${CK}; Max-Age=${email ? 31536000 : 0}`);

// ---------- helpers ----------
const merchantById = async (id) => (await sql`select * from merchants where id=${id}`)[0];
const viewer = (req) => verify(cookie(req, 'sid'))?.m; // signed-in café (same browser can also use the customer app)
const isTest = (m, req) => !!m.test_mode && viewer(req) === m.id; // test mode: this café's own session sees its store and places fake orders
async function connected(id, req) {
  const m = (await sql`select * from merchants where id=${+id || 0}`)[0];
  return m && (m.mollie_profile || isTest(m, req)) ? m : undefined;
}
// hygiene rating below 4 (0-3, or Scotland's "Improvement Required") = hidden from customers; unrated places are allowed
const lowRated = (b) => /^[0-3]$/.test(b.fhrs_rating || '') || /^improvement required$/i.test(b.fhrs_rating || '');
// "Off-hand service fee to customer": prices are raised so the café nets its menu price after the platform fee
const adj = (m, it) => (m.pass_fee ? { ...it, price_pence: gross(it.price_pence, rateFor(m)), options: (it.options || []).map((g) => ({ ...g, choices: g.choices.map((c) => ({ ...c, price: gross(c.price || 0, rateFor(m)) })) })) } : it);
async function geocode(pc) {
  const j = await (await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc.replace(/\s/g, '')))).json();
  if (!j.result) throw bad('Postcode not found');
  return { lat: j.result.latitude, lng: j.result.longitude };
}
const km = (a, b, c, d) => { const r = (x) => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const LOY = { enabled: false, name: 'Loyalty card', needed: 8, type: 'percent', value: 100, cap: 500, item: null, category: null, extras: false, earn: 'order', earnCats: [] }; // extras: free item also covers paid extras; earn: 'order' (1 stamp) or 'item' (1 per item, optionally only from earnCats) // type: percent | fixed | product (a free menu item)
const loyOut = (c) => ({ ...LOY, ...(c || {}) });
const pubCafe = (m) => ({
  id: m.id, name: m.name, color: m.color, vat: m.vat_registered,
  logo: m.logo ? `/api/cafes/${m.id}/logo?v=${m.logo.length}` : null, profileId: m.mollie_profile, testmode: M.TEST,
  sitin: m.allow_sitin !== false, loyalty: loyOut(m.loyalty),
});
const branchesOf = (mid) => sql`select * from branches where merchant_id=${mid} order by sort, id`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const rateFor = (m) => (m.fee_pct != null ? Number(m.fee_pct) / 100 : m.reduced_until && new Date(m.reduced_until) > new Date() ? REDUCED_FEE_RATE : FEE_RATE); // an admin override beats the referral rate
// Temporary closures / special hours covering today override a branch's normal hours.
function eff(b, cl = []) {
  const t = today(), c = cl.filter((x) => x.branch_id === b.id && x.from_date <= t && x.to_date >= t).sort((p, q) => q.id - p.id)[0];
  if (!c) return b;
  return c.kind === 'hours' ? { ...b, open_time: c.open_time, close_time: c.close_time, special: c.note || `Special hours today: ${c.open_time}–${c.close_time}` }
    : { ...b, open_time: '00:00', close_time: '00:00', closed: c.note || 'Closed today' };
}
const closuresOf = (mid) => sql`select * from branch_closures where merchant_id=${mid} and to_date >= ${today()} order by from_date, id`;
const rvOut = (rv, id) => { const r = rv.find((x) => x.branch_id === id); return { n: r?.n || 0, avg: r && r.n >= 10 ? Math.round(r.a * 10) / 10 : null }; }; // average only shown from 10 reviews
const hygiene = (b) => (b.fhrs_id ? { id: b.fhrs_id, rating: b.fhrs_rating, date: b.fhrs_date } : null);
const pubBranch = (b, off = [], cl = [], rv = []) => {
  const e = eff(b, cl);
  return { off: { items: off.filter((r) => r.branch_id === b.id && r.kind === 'item').map((r) => r.ref_id), cats: off.filter((r) => r.branch_id === b.id && r.kind === 'cat').map((r) => r.ref_id) },
    id: b.id, name: b.name, address: b.address, lat: b.lat, lng: b.lng, paused: b.paused, open_time: e.open_time, close_time: e.close_time, closed: e.closed || null, special: e.special || null,
    upcoming: cl.filter((x) => x.branch_id === b.id && x.from_date > today()).slice(0, 3).map((x) => ({ from: x.from_date, to: x.to_date, kind: x.kind, note: x.note, open: x.open_time, close: x.close_time })),
    estimate: !!b.printer_on, hygiene: hygiene(b), reviews: rvOut(rv, b.id), ...slots(e) };
};
// Food Standards Agency hygiene rating, linked automatically: match on postcode + similar name, then re-check at most every 14 days.
// ponytail: linked lazily when a café page is opened; a branch with no match is retried every 14 days.
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function refreshFhrs(b, name) {
  if ((b.fhrs_checked && Date.now() - new Date(b.fhrs_checked) < 14 * 864e5) || (!b.fhrs_id && !(b.postcode && norm(name)))) return;
  const get = (p) => fetch('https://api.ratings.food.gov.uk/' + p, { headers: { 'x-api-version': '2', accept: 'application/json' }, signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null));
  let e;
  if (b.fhrs_id) e = await get('Establishments/' + b.fhrs_id);
  else {
    const j = await get(`Establishments?name=${encodeURIComponent(name)}&address=${encodeURIComponent(b.postcode)}&pageSize=10`); if (!j) return;
    const pc = norm(b.postcode), n = norm(name);
    e = (j.establishments || []).find((x) => norm(x.PostCode) === pc && norm(x.BusinessName) && (norm(x.BusinessName).includes(n) || n.includes(norm(x.BusinessName))));
    if (!e) { await sql`update branches set fhrs_checked=now() where id=${b.id}`; return; }
  }
  if (!e) return;
  const date = (e.RatingDate || '').slice(0, 10);
  Object.assign(b, { fhrs_id: e.FHRSID, fhrs_rating: String(e.RatingValue ?? ''), fhrs_date: date, fhrs_name: e.BusinessName, fhrs_checked: new Date() });
  await sql`update branches set fhrs_id=${e.FHRSID},fhrs_rating=${b.fhrs_rating},fhrs_date=${date},fhrs_name=${e.BusinessName || ''},fhrs_checked=now() where id=${b.id}`;
}
// 6-digit random order numbers (retry on the rare clash)
async function insertOrder(f) {
  for (let i = 0; i < 8; i++) {
    const num = 100000 + randomInt(900000);
    if ((await sql`select 1 from orders where num=${num}`).length) continue;
    return (await sql`insert into orders (num,merchant_id,branch_id,status,customer_name,customer_email,pickup_time,asap,items,subtotal,tip,vat,total,fee,service,allergy,discount,offer_code,reward_used,account,test)
      values (${num},${f.m},${f.branch},'awaiting_payment',${f.name},${f.email},${f.pick},${f.asap},${JSON.stringify(f.lines)}::jsonb,${f.subtotal},${f.tip},${f.vat},${f.total},${f.fee},
      ${f.service},${JSON.stringify(f.allergy)}::jsonb,${f.discount},${f.offer},${f.reward},${f.account},${!!f.test}) returning id,total`)[0];
  }
  throw bad('Please try again');
}
async function getOrder(id) {
  const o = UUID.test(id) && (await sql`select * from orders where id=${id}::uuid`)[0];
  if (!o) throw bad('Order not found', 404);
  return o;
}

const FAIL = {
  invalid_card_number: 'The card number isn’t valid – check it and try again.', invalid_cvv: 'The security code (CVV) wasn’t right – check it and try again.',
  invalid_card_holder_name: 'The name on the card wasn’t accepted.', invalid_card_type: 'That type of card isn’t accepted – try a different card.', card_expired: 'That card has expired.',
  inactive_card: 'That card isn’t active – contact your bank or try another card.', insufficient_funds: 'There weren’t enough funds on that card.', card_declined: 'Your card was declined – try another card.',
  refused_by_issuer: 'Your bank declined the payment – try another card or contact your bank.', possible_fraud: 'Your bank flagged this payment – try another card or contact them.',
  authentication_failed: 'Your bank’s security check (3-D Secure) didn’t pass – please try again.', authentication_abandoned: 'The bank’s security check wasn’t completed – please try again.',
  authentication_required: 'Your bank needs extra verification – please try again.', authentication_unavailable_acs: 'Your bank’s security check is unavailable right now – try again shortly or use another card.',
};
const failMsg = (reason, status) => FAIL[reason] || (status === 'expired' ? 'The payment timed out – please try again.' : status === 'canceled' ? 'The payment was cancelled.' : 'The payment didn’t go through – please try again or use another card.');
// Mollie request errors -> something a customer can act on (details stay in the logs)
const payError = (e) => bad(/token/i.test(e.message) ? 'Your card details timed out – please re-enter them and try again.' : e.mollie ? 'We couldn’t take that payment. Check your details or try another card.' : e.message);

// Everything that follows a successful payment: offer use, loyalty stamp/reward, referral reward on a café's first paid order.
async function afterPaid(n, m) {
  if (n.test) return; // fake order: no offers, stamps or referral rewards
  if (n.offer_code) await sql`update offers set used=used+1 where merchant_id=${n.merchant_id} and code=${n.offer_code}`;
  const L = loyOut(m.loyalty);
  if (L.enabled && n.account) { // stamps belong to the signed-in account that placed the order
    if (n.reward_used) await sql`update loyalty set stamps=greatest(stamps-${L.needed},0) where merchant_id=${m.id} and email=${n.account}`;
    else {
      let k = 1; // stamps earned: one per order, or one per item (optionally only items from one category)
      if (L.earn === 'item') { const its = await sql`select id, category_id from items where merchant_id=${m.id}`; const ec = L.earnCats?.length ? L.earnCats : L.earnCat ? [L.earnCat] : []; k = n.items.reduce((a, l) => a + (!ec.length || ec.includes(its.find((i) => i.id === l.id)?.category_id) ? l.qty : 0), 0); }
      if (k > 0) {
        await sql`insert into loyalty (merchant_id,email,stamps) values (${m.id},${n.account},${k}) on conflict (merchant_id,email) do update set stamps=loyalty.stamps+${k}`;
        await sql`update orders set stamped=true, stamps_earned=${k} where id=${n.id}::uuid`;
      }
    }
  }
  if (!m.first_paid) {
    const [c] = await sql`update merchants set first_paid=true where id=${m.id} and not first_paid returning referred_by`;
    if (c?.referred_by) { // both cafés get the reduced fee for 30 days; rewards stack by extending the end date
      const [r] = await sql`insert into referrals (referred,referrer) values (${m.id},${c.referred_by}) on conflict do nothing returning referred`;
      if (r) await sql`update merchants set reduced_until = greatest(coalesce(reduced_until, now()), now()) + interval '30 days' where id in (${m.id}, ${c.referred_by})`;
    }
  }
}
async function markPaid(o, m) {
  const [n] = await sql`update orders set status='pending', updated_at=now() where id=${o.id}::uuid and status='awaiting_payment' returning *`;
  if (n) {
    let now = !!n.asap; // ASAP orders alert the kitchen at once; scheduled ones wait until pickup time minus prep time (see housekeeping)
    if (!now) {
      const br = (await sql`select prep_minutes, extra_minutes from branches where id=${n.branch_id}`)[0] || {};
      const [r] = await sql`update orders set alert_at=((created_at at time zone 'Europe/London')::date + ${n.pickup_time}::time) at time zone 'Europe/London' - make_interval(mins => ${(br.prep_minutes || 0) + (br.extra_minutes || 0)})
        where id=${n.id}::uuid returning alert_at <= now() as due`;
      now = !!r?.due; if (now) await sql`update orders set alerted=true where id=${n.id}::uuid`; // already due: alert now, not again later
    }
    await Promise.allSettled([notifyPaid(n, m, now), afterPaid(n, m), W.pushUpdate(n.id)]).then((r) => r.forEach((x) => x.status === 'rejected' && console.error('markPaid', x.reason))); } // only the request that wins the update does this
  return n;
}

// Pull the truth from Mollie (used by webhook AND status polling, so a late webhook never strands an order).
async function settle(o) {
  if (o.status !== 'awaiting_payment' || !o.payment_id) return { o };
  const m = await merchantById(o.merchant_id); if (!m) return { o }; // café account deleted
  const pay = await M.api(m, `/payments/${o.payment_id}`);
  if (pay.status === 'paid') return { o: (await markPaid(o, m)) || await getOrder(o.id) };
  const failed = ['failed', 'canceled', 'expired'].includes(pay.status);
  return { o, failed, reason: failed ? failMsg(pay.details?.failureReason, pay.status) : null };
}

// Shared refund: items = [{ i, qty }] (line index in the order) or null for everything left. Partial refunds keep the order open; the platform fee is never returned.
async function doRefund(o, mer, items) {
  const done = o.refunded_items || {}, left = o.items.map((l, i) => l.qty - (done[i] || 0));
  const pick = items || left.map((q, i) => ({ i, qty: q })).filter((x) => x.qty > 0), seen = new Set();
  if (!pick.length) throw bad('Nothing left to refund');
  for (const x of pick) {
    if (!Number.isInteger(x.i) || !Number.isInteger(x.qty) || x.i < 0 || x.i >= o.items.length || x.qty < 1 || x.qty > left[x.i] || seen.has(x.i)) throw bad('Choose items that can still be refunded');
    seen.add(x.i);
  }
  const next = { ...done }; pick.forEach((x) => { next[x.i] = (next[x.i] || 0) + x.qty; });
  const all = o.items.every((l, i) => (next[i] || 0) >= l.qty), amount = refundAmount(o, pick, all), was = o.refunded || 0;
  const [n] = await sql`update orders set refunded=refunded+${amount}, refunded_items=${JSON.stringify(next)}::jsonb, status=${all ? 'refunded' : o.status}, updated_at=now()
    where id=${o.id}::uuid and refunded=${was} and status=${o.status} returning *`; // claim first: no double refunds
  if (!n) throw bad('Order already changed');
  try {
    if (amount > 0 && o.payment_id && !o.test) await M.api(mer, `/payments/${o.payment_id}/refunds`, { method: 'POST', body: { amount: M.amt(amount), description: `Order #${o.num} ${all ? 'refunded' : 'part-refunded'}`, ...(M.TEST && { testmode: true }) } });
  } catch (e) {
    await sql`update orders set refunded=${was}, refunded_items=${JSON.stringify(done)}::jsonb, status=${o.status}, updated_at=now() where id=${o.id}::uuid`; // refund failed: put it back
    throw e;
  }
  if (all && n.account) { // fully refunded: give back the stamps they earned, or the stamps a reward used
    if (n.stamped) await sql`update loyalty set stamps=greatest(stamps-${n.stamps_earned || 1},0) where merchant_id=${n.merchant_id} and email=${n.account}`;
    if (n.reward_used) await sql`update loyalty set stamps=stamps+${loyOut(mer.loyalty).needed} where merchant_id=${n.merchant_id} and email=${n.account}`;
  }
  await notifyRefund(n, mer, amount); await W.pushUpdate(n.id);
  return n;
}
const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
async function saveImgs(did, arr) {
  const ids = [];
  for (const d of (Array.isArray(arr) ? arr : []).slice(0, 3)) {
    if (typeof d !== 'string' || d.length > 900000 || !IMG.test(d)) throw bad('Photos must be JPEG, PNG or WebP and under about 600 KB each');
    const [, mime, b64] = /^data:(image\/\w+);base64,(.*)$/.exec(d), id = (await sql`insert into dispute_imgs (dispute_id,data,status) values (${did}::uuid,${d},'queued') returning id`)[0].id;
    const r = await Q.submit({ kind: 'dispute', ref: id, buf: Buffer.from(b64, 'base64'), mime }); // VirusTotal queue (3 files a minute): the photo is only shown once it is clean
    if (r.status === 'flagged') { await sql`delete from dispute_imgs where id=${id}`; throw bad('That photo was flagged by our virus check, so it can’t be uploaded.'); }
    if (r.status !== 'queued') await sql`update dispute_imgs set status='clean' where id=${id}`;
    ids.push(id);
  }
  return ids;
}
const addMsg = async (did, who, body, imgs = []) => { await sql`insert into dispute_msgs (dispute_id,who,body,imgs) values (${did}::uuid,${who},${str(body, 1500)},${JSON.stringify(imgs)}::jsonb)`; };
const disputeOut = async (d) => ({ id: d.id, status: d.status, reason: d.reason, items: d.items, created_at: d.created_at, due_at: d.due_at, responded_at: d.responded_at, resolved_at: d.resolved_at,
  msgs: await (async () => {
    const st = new Map((await sql`select id, status from dispute_imgs where dispute_id=${d.id}::uuid`).map((r) => [r.id, r.status])); // photos are shown only after the virus check
    return (await sql`select who, body, imgs, created_at from dispute_msgs where dispute_id=${d.id}::uuid order by id`).map((m) => ({ ...m, imgs: m.imgs.filter((i) => st.get(i) === 'clean'), pending: m.imgs.filter((i) => st.get(i) === 'queued').length }));
  })() });

// Timed jobs, run opportunistically (kitchen + order polling, throttled) and by the daily cron:
// 1) scheduled orders: alert the kitchen at pickup time minus prep time; 2) disputes the café hasn't answered in 7 days are refunded automatically.
// ponytail: no always-on worker on Hobby – ping /api/cron/housekeeping every minute (cron-job.org) if you want alerts with no device open.
let lastHK = 0;
async function housekeeping(force) {
  if (!force && Date.now() - lastHK < 20000) return; lastHK = Date.now();
  await Q.processQueue().catch((e) => console.error('scan queue', e.message)); // VirusTotal queue, max 3 files a minute
  const due = await sql`update orders set alerted=true where alert_at is not null and not alerted and alert_at <= now() and status in ('pending','accepted') returning *`;
  for (const o of due) { const m = await merchantById(o.merchant_id); if (m) await notifyMerchantNew(o, m).catch((e) => console.error('alert', e)); }
  const ds = await sql`select * from disputes where status='open' and responded_at is null and due_at <= now()`;
  for (const d of ds) {
    try {
      const o = await getOrder(d.order_id), mer = await merchantById(d.merchant_id);
      if (mer && o.status !== 'refunded') await doRefund(o, mer, d.items);
      await sql`update disputes set status='auto_refunded', resolved_at=now() where id=${d.id}::uuid and status='open'`;
      await addMsg(d.id, 'system', 'The café didn’t respond within 7 days, so this refund was granted automatically.');
      if (mer) await notifyDisputeResult(d, o, mer, 'auto');
    } catch (e) { console.error('auto refund', d.id, e.message); }
  }
}

// ---------- routing ----------
const routes = [];
const route = (method, path, fn, auth) => {
  const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push([method, re, keys, fn, auth]);
};
const json = (res, code, data) => res.status(code).json(data);

export default async function handler(req, res) {
  try {
    await init();
    const url = new URL(req.url, 'http://x');
    for (const [method, re, keys, fn, auth] of routes) {
      const hit = method === req.method && re.exec(url.pathname); if (!hit) continue;
      const ctx = { req, res, who: () => who(req), q: url.searchParams, body: req.body || {}, p: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(hit[i + 1])])) };
      if (auth && !(ctx.m = verify(cookie(req, 'sid'))?.m)) return json(res, 401, { error: 'Please sign in' });
      const out = await fn(ctx);
      return res.writableEnded ? undefined : json(res, 200, out ?? { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.code === '23505') e = bad('That email is already registered');
    if (!e.status) console.error(e);
    json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}

// ================= PUBLIC (customer) =================
// Apple Pay domain verification: paste the file Mollie gives you into the APPLE_PAY_DOMAIN_FILE env var.
route('GET', '/.well-known/apple-developer-merchantid-domain-association', ({ res }) => {
  if (!process.env.APPLE_PAY_DOMAIN_FILE) throw bad('Not configured', 404);
  res.setHeader('Content-Type', 'text/plain'); res.end(process.env.APPLE_PAY_DOMAIN_FILE);
});
route('GET', '/api/config', () => ({ vapid: VAPID_PUBLIC_KEY, appUrl: BASE_URL, merchantUrl: MURL, adminUrl: AURL }));

route('GET', '/api/cafes', async ({ q }) => {
  const [lat, lng] = [parseFloat(q.get('lat')), parseFloat(q.get('lng'))];
  const term = (q.get('q') || '').trim().toLowerCase();
  let all = await sql`select b.*, m.name as mname, m.color, m.logo, m.vat_registered from branches b join merchants m on m.id=b.merchant_id where m.mollie_profile is not null`;
  await Promise.allSettled(all.filter((r) => !r.fhrs_checked).slice(0, 6).map((r) => refreshFhrs(r, r.mname))); // rate new places before listing them
  all = all.filter((r) => !lowRated(r));
  const cl = await sql`select * from branch_closures where to_date >= ${today()}`, rv = await sql`select branch_id, count(*)::int n, avg(stars)::float a from reviews group by 1`;
  const count = {}; all.forEach((r) => { count[r.merchant_id] = (count[r.merchant_id] || 0) + 1; });
  // ponytail: haversine in JS – fine to a few thousand cafés; move to PostGIS/earthdistance beyond that.
  return all.filter((r) => !term || (r.mname + ' ' + r.name).toLowerCase().includes(term))
    .map((r) => ({ id: r.merchant_id, branchId: r.id, name: r.mname, branch: r.name, many: count[r.merchant_id] > 1, address: r.address, color: r.color, paused: r.paused, vat: r.vat_registered, closed: eff(r, cl).closed || null, special: eff(r, cl).special || null, estimate: !!r.printer_on, hygiene: r.fhrs_rating || null, reviews: rvOut(rv, r.id),
      logo: r.logo ? `/api/cafes/${r.merchant_id}/logo?v=${r.logo.length}` : null, lat: r.lat, lng: r.lng, ...slots(eff(r, cl)), km: isNaN(lat) || r.lat == null ? null : km(lat, lng, r.lat, r.lng) }))
    .filter((c) => term || c.km === null || c.km < 30).sort((a, b) => (a.km ?? 0) - (b.km ?? 0)).slice(0, 80);
});

route('GET', '/api/cafes/:id/logo', async ({ p, res, req }) => {
  const m = await connected(p.id, req); const mt = m?.logo?.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!mt) throw bad('No logo', 404);
  res.setHeader('Content-Type', mt[1]); res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(Buffer.from(mt[2], 'base64'));
});

route('GET', '/api/cafes/:id', async ({ p, req }) => {
  const m = await connected(p.id, req); if (!m) throw bad('Café not found', 404);
  const [cats, items] = await Promise.all([
    sql`select * from categories where merchant_id=${m.id} order by sort, id`,
    sql`select * from items where merchant_id=${m.id} order by id`]);
  const off = await sql`select branch_id, kind, ref_id from branch_off where branch_id in (select id from branches where merchant_id=${m.id})`;
  const brs = await branchesOf(m.id), [cl, rv, offers] = await Promise.all([closuresOf(m.id), sql`select branch_id, count(*)::int n, avg(stars)::float a from reviews where merchant_id=${m.id} group by 1`,
    sql`select 1 from offers where merchant_id=${m.id} and active limit 1`]);
  await Promise.allSettled(brs.map((b) => refreshFhrs(b, m.name)));
  const shown = brs.filter((b) => !lowRated(b)); if (!shown.length) throw bad('Café not found', 404);
  const pc = pubCafe(m); if (pc.loyalty.type === 'product') pc.loyalty.itemName = (pc.loyalty.category ? cats.find((c) => c.id === pc.loyalty.category) : items.find((i) => i.id === pc.loyalty.item))?.name || null;
  return { ...pc, test: isTest(m, req), offers: offers.length > 0, branches: shown.map((b) => pubBranch(b, off, cl, rv)), categories: cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id).map((i) => ({ ...adj(m, i), merchant_id: undefined })) })) };
});

async function findOffer(mid, code, subtotal) {
  const o = (await sql`select * from offers where merchant_id=${mid} and code=${str(code, 20).toUpperCase()}`)[0];
  if (!o || !o.active || (o.expires_at && new Date(o.expires_at) < new Date()) || (o.max_uses && o.used >= o.max_uses)) throw bad('That offer code isn’t valid');
  if (subtotal < o.min_spend) throw bad(`Spend ${gbp(o.min_spend)} or more to use this code`);
  return o;
}
const stampsOf = async (mid, em) => (await sql`select stamps from loyalty where merchant_id=${mid} and email=${em}`)[0]?.stamps || 0;

route('POST', '/api/orders', async ({ body: b, who, req }) => {
  const m = await connected(b.cafeId, req); if (!m) throw bad('Café not found', 404);
  const branches = await branchesOf(m.id);
  const br = b.branchId ? branches.find((x) => x.id === +b.branchId) : branches.length === 1 ? branches[0] : null;
  if (!br) throw bad('Choose which branch to collect from');
  if (lowRated(br)) throw bad('This café isn’t available right now', 404);
  if (br.paused) throw bad('This café has paused new orders – please try again shortly');
  const e = eff(br, await closuresOf(m.id)); if (e.closed) throw bad(e.closed);
  const t = slots(e);
  const pick = b.pickup === 'asap' ? t.asap : t.slots.includes(b.pickup) ? b.pickup : null;
  if (!pick) throw bad('That pickup time is no longer available');
  const name = str(b.name, 60), email = str(b.email, 120);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Please enter your name and a valid email');
  const tipPct = Number.isInteger(b.tipPct) && b.tipPct >= 0 && b.tipPct <= 30 ? b.tipPct : 5;
  const service = b.service === 'sitin' && m.allow_sitin !== false ? 'sitin' : 'takeaway', allergy = cleanAllergens(b.allergy);

  const [rawItems, cats] = await Promise.all([sql`select * from items where merchant_id=${m.id}`, sql`select * from categories where merchant_id=${m.id}`]);
  const items = rawItems.map((i) => adj(m, i)), test = isTest(m, req);
  const offRows = await sql`select kind, ref_id from branch_off where branch_id=${br.id}`;
  const offItems = new Set(offRows.filter((r) => r.kind === 'item').map((r) => r.ref_id)), offCats = new Set(offRows.filter((r) => r.kind === 'cat').map((r) => r.ref_id));
  const { dow } = londonNow(), pm = toMins(pick);
  const lines = []; let subtotal = 0;
  for (const l of b.items || []) {
    const it = items.find((i) => i.id === +l.id), qty = Math.floor(+l.qty);
    if (!it || !it.available || offItems.has(it.id) || offCats.has(it.category_id)) throw bad('An item in your basket isn’t available at this branch');
    if (!(qty >= 1 && qty <= 20)) throw bad('Invalid quantity');
    const cat = cats.find((c) => c.id === it.category_id);
    if (cat && !catAvailable(cat, dow, pm)) throw bad(`${it.name} isn't available at ${pick}`);
    let pl; try { pl = priceLine(it, l.sel); } catch (x) { throw bad(`${it.name}: ${x.message}`); }
    const sel = Object.fromEntries(it.options.map((g, gi) => [gi, (l.sel?.[gi] || []).map(Number)])); // kept so "order again" can rebuild the exact choices
    lines.push({ id: it.id, name: it.name, qty, unit: pl.unit, opts: pl.names, sel }); subtotal += pl.unit * qty;
  }
  if (!lines.length) throw bad('Your basket is empty');

  // discount: either a loyalty reward or an offer code – never both. Applies to the food, not the tip.
  let discount = 0, offer = null, reward = false; const d = who();
  if (b.useReward) {
    if (!d) throw bad('Sign in (Settings) to use your loyalty reward');
    const L = loyOut(m.loyalty); if (!L.enabled) throw bad('This café doesn’t have a loyalty card');
    const held = (await sql`select count(*)::int n from orders where merchant_id=${m.id} and account=${d} and reward_used and status='awaiting_payment' and created_at > now() - interval '30 minutes'`)[0].n;
    if ((await stampsOf(m.id, d)) - held * L.needed < L.needed) throw bad('You haven’t earned a reward yet');
    if (L.type === 'product') { // the reward is one free <item>: it must be in the basket; options are still paid for
      const target = L.category ? cats.find((c) => c.id === L.category) : items.find((i) => i.id === L.item); if (!target) throw bad('This reward is no longer available');
      const pool = lines.filter((l) => (L.category ? items.find((i) => i.id === l.id)?.category_id === L.category : l.id === L.item)).map((l) => (L.extras ? l.unit : items.find((i) => i.id === l.id).price_pence));
      if (!pool.length) throw bad(L.category ? `Add something from ${target.name} to your basket to claim your reward` : `Add a ${target.name} to your basket to claim your reward`);
      discount = Math.min(L.category && L.cap ? Math.min(Math.max(...pool), L.cap) : Math.max(...pool), subtotal); // priciest eligible item (up to the cap, for a category)
    } else discount = discountFor(L.type, L.value, subtotal, L.cap);
    reward = true;
  } else if (str(b.offer, 20)) {
    const o = await findOffer(m.id, b.offer, subtotal); discount = discountFor(o.kind, o.value, subtotal); offer = o.code;
  }
  const tipPence = Number.isInteger(b.tipPence) && b.tipPence >= 0 && b.tipPence <= 10000 ? b.tipPence : null; // custom tip, max £100
  const x = totals(subtotal - discount, tipPct, m.vat_registered, tipPence, rateFor(m));
  const created = await insertOrder({ m: m.id, branch: br.id, name, email, pick, asap: b.pickup === 'asap', lines, subtotal, tip: x.tip, vat: x.vat, total: x.total, fee: x.fee, service, allergy, discount, offer, reward, account: d, test });
  return { ...created, discount, wallet: test ? null : W.info(created.id) }; // lets the client hand the order to Wallet via Apple Pay
});

// Check an offer code against a basket total (final validation happens again when the order is placed)
route('POST', '/api/offers/check', async ({ body: b, req }) => {
  const m = await connected(b.cafeId, req); if (!m) throw bad('Café not found', 404);
  const sub = Math.max(0, Math.floor(+b.subtotal) || 0), o = await findOffer(m.id, b.code, sub);
  return { code: o.code, discount: discountFor(o.kind, o.value, sub), label: o.kind === 'percent' ? `${o.value}% off` : `${gbp(o.value)} off` };
});
route('GET', '/api/loyalty', async ({ q, who, req }) => {
  const m = await connected(q.get('cafe'), req); if (!m) throw bad('Café not found', 404);
  const L = loyOut(m.loyalty), stamps = L.enabled && who() ? await stampsOf(m.id, who()) : 0;
  return { ...L, stamps, reward: L.enabled && stamps >= L.needed };
});

// Sign in: email -> 6-digit code (10 min, 5 tries, one request a minute per email).
const codeHash = (email, code) => mac(email + ':' + code);
route('POST', '/api/me/code', async ({ body: b }) => {
  const email = str(b.email, 120).toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email');
  if ((await sql`select 1 from customer_codes where email=${email} and sent_at > now() - interval '60 seconds'`).length) throw bad('A code was just sent – check your email, or wait a minute to ask again');
  const code = String(randomInt(1e6)).padStart(6, '0');
  await sql`insert into customer_codes (email,code_hash,expires_at,tries,sent_at) values (${email},${codeHash(email, code)},now() + interval '10 minutes',0,now())
    on conflict (email) do update set code_hash=excluded.code_hash, expires_at=excluded.expires_at, tries=0, sent_at=now()`;
  await sendEmail(email, `${code} is your Docket sign-in code`, customerCodeHtml(code));
});
route('POST', '/api/me/verify', async ({ body: b, res }) => {
  const email = str(b.email, 120).toLowerCase(), code = str(b.code, 6).replace(/\D/g, '');
  const [r] = await sql`update customer_codes set tries=tries+1 where email=${email} and expires_at > now() and tries < 5 returning code_hash`;
  const h = Buffer.from(codeHash(email, code)), g = Buffer.from(r?.code_hash || '');
  if (!r || h.length !== g.length || !timingSafeEqual(h, g)) throw bad('That code isn’t right or has expired');
  await sql`delete from customer_codes where email=${email}`;
  await sql`insert into customers (email) values (${email}) on conflict do nothing`;
  setCust(res, email);
});
route('POST', '/api/me/logout', ({ res }) => setCust(res, null));

// Favourite cafés and items are stored on the server against the signed-in account. Input is rebuilt field by field (rendered back into pages).
const hex6 = /^#[0-9a-f]{6}$/i;
route('GET', '/api/me', async ({ who }) => {
  const email = who(); if (!email) return { email: null };
  const r = (await sql`select favs, fav_cafes from customers where email=${email}`)[0];
  return { email, favs: r?.favs || [], favCafes: r?.fav_cafes || [] };
});
route('PUT', '/api/me', async ({ body: b, who }) => {
  const email = who(); if (!email) throw bad('Sign in to save favourites', 401);
  const arr = (a) => (Array.isArray(a) ? a.slice(0, 100) : []);
  const favs = arr(b.favs).map((f) => ({ cafeId: +f.cafeId, cafeName: str(f.cafeName, 80), itemId: +f.itemId, name: str(f.name, 80), label: str(f.label, 200),
    sel: Object.fromEntries(Object.entries(f.sel || {}).slice(0, 10).map(([k, v]) => [String(+k | 0), (Array.isArray(v) ? v : []).slice(0, 30).map(Number).filter(Number.isInteger)])) })).filter((f) => f.cafeId > 0 && f.itemId > 0 && f.name);
  const favCafes = [...new Map(arr(b.favCafes).map((c) => ({ id: +c.id, branchId: c.branchId == null ? null : +c.branchId, name: str(c.name, 80), branch: str(c.branch, 80), many: !!c.many, address: str(c.address, 200),
    color: hex6.test(c.color) ? c.color : '#14161B', logo: /^\/api\/cafes\/\d+\/logo(\?v=\d+)?$/.test(c.logo || '') ? c.logo : null })).filter((c) => c.id > 0 && c.name).map((c) => [c.branchId ?? 'm' + c.id, c])).values()]; // one saved entry per branch (branch ids are unique)
  await sql`insert into customers (email,favs,fav_cafes) values (${email},${JSON.stringify(favs)}::jsonb,${JSON.stringify(favCafes)}::jsonb)
    on conflict (email) do update set favs=excluded.favs, fav_cafes=excluded.fav_cafes, updated_at=now()`;
});

route('POST', '/api/orders/:id/pay', async ({ p, body: b }) => {
  let o = await getOrder(p.id);
  if (o.status === 'awaiting_payment' && o.payment_id) ({ o } = await settle(o)); // an earlier attempt may actually have gone through
  if (o.status !== 'awaiting_payment') throw bad('This order is already paid');
  const m = await merchantById(o.merchant_id);
  if (o.test || o.total === 0) { await markPaid(o, m); return { checkoutUrl: null }; } // test order, or fully covered by a reward / offer // fully covered by a reward / offer
  if (!b.cardToken && !b.applePayToken) throw bad('Missing payment details');
  let pay;
  try {
    pay = await M.api(m, '/payments', {
      method: 'POST',
      body: {
        amount: M.amt(o.total), description: `${m.name} order #${o.num}`.slice(0, 100),
        redirectUrl: `${BASE_URL}/?order=${o.id}`, webhookUrl: `${BASE_URL}/api/webhook/mollie`,
        method: b.applePayToken ? 'applepay' : 'creditcard',
        ...(b.applePayToken ? { applePayPaymentToken: b.applePayToken } : { cardToken: b.cardToken }),
        // Platform's cut (5%, or 2.5% during a referral reward): taken from the merchant's settlement, NOT added to the customer's total.
        ...(o.fee > 0 && { applicationFee: { amount: M.amt(o.fee), description: 'Platform fee' } }),
        metadata: { orderId: o.id }, profileId: m.mollie_profile, ...(M.TEST && { testmode: true }),
      },
    });
  } catch (e) { throw payError(e); }
  await sql`update orders set payment_id=${pay.id} where id=${o.id}::uuid`;
  return { checkoutUrl: pay._links?.checkout?.href || null }; // 3-D Secure redirect if required
});

route('POST', '/api/applepay/session', async ({ body: b, req }) => {
  const m = await connected(b.cafeId, req); if (!m) throw bad('Café not found', 404);
  return M.api(m, '/wallets/applepay/sessions', { method: 'POST', body: { domain: new URL(BASE_URL).host, validationUrl: b.validationUrl, profileId: m.mollie_profile } });
});

route('GET', '/api/orders/:id', async ({ p }) => {
  await housekeeping().catch((e) => console.error('housekeeping', e));
  const { o, failed, reason } = await settle(await getOrder(p.id));
  const m = (await merchantById(o.merchant_id)) || { id: o.merchant_id, name: 'Closed café', color: null }, brs = await branchesOf(m.id), br = brs.find((x) => x.id === o.branch_id) || brs[0];
  const { customer_email, push_sub, account, payment_id, fee, merchant_id, branch_id, printed_at, stamped, ...pub } = o;
  const review = (await sql`select stars, comment from reviews where order_id=${o.id}::uuid`)[0] || null;
  const stale = Date.now() - new Date(o.created_at) > 45 * 60e3; // printer cafés never tick orders off, so allow a review after a while
  const dp = (await sql`select * from disputes where order_id=${o.id}::uuid order by created_at desc limit 1`)[0];
  return { ...pub, dispute: dp ? await disputeOut(dp) : null, failed, reason, wallet: W.enabled() && !o.test, review, canReview: !review && (o.status === 'completed' || (br?.printer_on && stale && ['pending', 'accepted', 'ready'].includes(o.status))),
    estimate: !!br?.printer_on, cafe: { id: m.id, branchId: br?.id, name: m.name + (brs.length > 1 ? ' · ' + br.name : ''), color: m.color, address: br?.address || '', vat_number: m.vat_number } };
});
route('POST', '/api/orders/:id/review', async ({ p, body: b }) => {
  const o = await getOrder(p.id), br = (await sql`select printer_on from branches where id=${o.branch_id}`)[0];
  const ok = o.status === 'completed' || (br?.printer_on && Date.now() - new Date(o.created_at) > 45 * 60e3 && ['pending', 'accepted', 'ready'].includes(o.status));
  if (!ok) throw bad('You can review an order once it’s been collected');
  const stars = Number(b.stars); if (!Number.isInteger(stars) || stars < 0 || stars > 5) throw bad('Choose between 0 and 5 stars');
  const [r] = await sql`insert into reviews (order_id,merchant_id,branch_id,stars,comment) values (${o.id}::uuid,${o.merchant_id},${o.branch_id},${stars},${str(b.comment, 280)}) on conflict do nothing returning order_id`;
  if (!r) throw bad('You’ve already reviewed this order');
});

// ---- Apple Wallet order tracking (web service Apple calls; see lib/wallet.js)
const walletAuthed = (req, id) => { const a = Buffer.from(req.headers.authorization || ''), b = Buffer.from('AppleOrder ' + W.authToken(id)); return a.length === b.length && timingSafeEqual(a, b); };
async function orderPackage(o) {
  const m = await merchantById(o.merchant_id); if (!m) throw bad('Not found', 404);
  const brs = await branchesOf(m.id), br = brs.find((x) => x.id === o.branch_id) || brs[0];
  return W.buildPackage(W.orderJson(o, m, br, brs.length > 1, !!br?.printer_on));
}
const sendPackage = (res, o, buf) => { res.setHeader('Content-Type', 'application/vnd.apple.finance.order'); res.setHeader('Last-Modified', new Date(o.updated_at || o.created_at).toUTCString()); res.status(200).end(buf); };
const WS = '/api/wallet/v1';
route('POST', `${WS}/devices/:dev/registrations/:type/:oid`, async ({ req, res, p, body }) => {
  if (!W.enabled() || p.type !== W.TYPE) throw bad('Not found', 404);
  const o = await getOrder(p.oid); if (!walletAuthed(req, o.id) || !body.pushToken) return res.status(401).end();
  console.log('wallet register', p.dev.slice(-6), p.oid);
  const [r] = await sql`insert into wallet_regs (device,order_id,push_token) values (${str(p.dev, 100)},${o.id}::uuid,${str(body.pushToken, 200)})
    on conflict (device,order_id) do update set push_token=excluded.push_token returning (xmax=0) as fresh`;
  res.status(r.fresh ? 201 : 200).end();
});
route('DELETE', `${WS}/devices/:dev/registrations/:type/:oid`, async ({ req, res, p }) => {
  const o = await getOrder(p.oid); if (!walletAuthed(req, o.id)) return res.status(401).end();
  await sql`delete from wallet_regs where device=${p.dev} and order_id=${o.id}::uuid`; res.status(200).end();
});
route('GET', `${WS}/devices/:dev/registrations/:type`, async ({ res, q, p }) => {
  const ms = Number(q.get('ordersModifiedSince')) || 0; console.log('wallet list', p.dev.slice(-6), ms);
  const rows = await sql`select o.id, o.updated_at from wallet_regs r join orders o on o.id=r.order_id where r.device=${p.dev} and o.updated_at > to_timestamp(${ms} / 1000.0)`;
  if (!rows.length) return res.status(204).end();
  res.status(200).json({ orderIdentifiers: rows.map((r) => r.id), lastModified: String(Math.max(...rows.map((r) => +new Date(r.updated_at)))) });
});
route('GET', `${WS}/orders/:type/:oid`, async ({ req, res, p }) => {
  if (!W.enabled() || p.type !== W.TYPE) throw bad('Not found', 404);
  const o = await getOrder(p.oid); if (!walletAuthed(req, o.id)) return res.status(401).end();
  const since = Date.parse(req.headers['if-modified-since'] || ''); console.log('wallet fetch', p.oid, req.headers['if-modified-since'] || '-');
  if (since && Math.floor(+new Date(o.updated_at) / 1000) <= Math.floor(since / 1000)) return res.status(304).end();
  sendPackage(res, o, await orderPackage(o));
});
route('POST', `${WS}/log`, ({ body }) => { console.log('wallet log', JSON.stringify(body.logs || body).slice(0, 2000)); });
// "Add to Apple Wallet" for card payments (the order id is an unguessable UUID)
route('GET', '/api/orders/:id/wallet', async ({ res, p }) => {
  if (!W.enabled()) throw bad('Wallet tracking is not set up', 404);
  const o = await getOrder(p.id); sendPackage(res, o, await orderPackage(o));
});

route('POST', '/api/orders/:id/push', async ({ p, body }) => {
  if (!body.sub?.endpoint) throw bad('Invalid subscription');
  await sql`update orders set push_sub=${JSON.stringify(body.sub)}::jsonb where id=${(await getOrder(p.id)).id}::uuid`;
});

route('POST', '/api/webhook/mollie', async ({ body }) => { // Mollie posts id=tr_xxx; we re-fetch, so forged calls are harmless
  const [o] = await sql`select * from orders where payment_id=${str(body.id, 40)}`;
  if (o) await settle(o);
});

// ---- thermal printers (Star CloudPRNT). Printer is pointed at {BASE_URL}/api/print/{branch token} and polls for tickets.
const printBranch = async (token) => { const b = (await sql`select * from branches where printer_token=${str(token, 60)} and printer_on`)[0]; if (!b) throw bad('Unknown printer', 404); return b; };
route('POST', '/api/print/:token', async ({ p }) => {
  const b = await printBranch(p.token);
  const o = (await sql`select id from orders where branch_id=${b.id} and printed_at is null and status in ('pending','accepted','ready','completed') and not test and (alert_at is null or alert_at <= now()) and created_at > now() - interval '3 hours' order by created_at limit 1`)[0];
  return o ? { jobReady: true, mediaTypes: ['text/plain'], jobToken: o.id } : { jobReady: false };
});
route('GET', '/api/print/:token', async ({ p, q, res }) => {
  const b = await printBranch(p.token), o = await getOrder(q.get('token'));
  if (o.branch_id !== b.id) throw bad('Not found', 404);
  const m = await merchantById(b.merchant_id), many = (await branchesOf(m.id)).length > 1;
  res.setHeader('Content-Type', 'text/plain; charset=us-ascii'); res.end(ticket(o, m, b, many));
});
route('DELETE', '/api/print/:token', async ({ p, q }) => { // printer confirms with code=200OK once the ticket is out
  const b = await printBranch(p.token);
  if (/^2/.test(q.get('code') || '') && UUID.test(q.get('token') || '')) await sql`update orders set printed_at=now() where id=${q.get('token')}::uuid and branch_id=${b.id}`;
});

// ================= MERCHANT =================
const TERMS_VERSION = '3'; // bump when public/terms/index.html changes materially
const ME = '(logo_pending is not null) as logo_pending,fee_pct,pass_fee,test_mode,terms_at,terms_version,id,email,name,address,postcode,color,vat_registered,vat_number,prep_minutes,extra_minutes,paused,open_time,close_time,logo,mollie_profile,allow_sitin,loyalty,referral_code,reduced_until,first_paid';
const meOut = (m) => ({ ...m, logo: m.logo ? `/api/cafes/${m.id}/logo?v=${m.logo.length}` : null, mollie: !!m.mollie_profile, mollie_profile: undefined });

// Passwordless: emailed link carries a signed 15-min token (replayable inside the window on purpose –
// single-use links get burned by email security scanners that pre-click them).
route('POST', '/api/m/login', async ({ body: b }) => {
  const email = str(b.email, 120).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email');
  const t = { e: email, exp: Date.now() + 15 * 60e3 };
  if (!(await sql`select 1 from merchants where email=${email}`).length) { // new café: validate signup details now
    const name = str(b.name, 80), pc = str(b.postcode, 10).toUpperCase();
    if (!name || !pc) throw bad('No account for that email – register your café first');
    Object.assign(t, { n: name, pc, ...(await geocode(pc)) });
    if (str(b.ref, 10)) { // referred by another café
      const r = (await sql`select id from merchants where referral_code=${str(b.ref, 10).toUpperCase()}`)[0];
      if (!r) throw bad('That referral code wasn’t found'); t.r = r.id;
    }
  }
  await sendEmail(email, 'Your Docket sign-in link', merchantLinkHtml(`${MURL.replace(/\/m$/, '')}/api/m/verify?t=${sign(t)}`));
});
route('GET', '/api/m/verify', async ({ q, res }) => {
  const t = verify(q.get('t'));
  if (!t?.e) { res.redirect(302, MURL + '/?expired=1'); return; }
  const [m] = await sql`insert into merchants (email,name,postcode,lat,lng,referred_by,referral_code) values (${t.e},${t.n || 'My café'},${t.pc || ''},${t.lat ?? null},${t.lng ?? null},${t.r ?? null},upper(substr(md5(random()::text || ${t.e}),1,6)))
    on conflict (email) do update set email=excluded.email returning id`;
  await sql`insert into branches (merchant_id,name,address,postcode,lat,lng,open_time,close_time,prep_minutes,extra_minutes,paused)
    select id,'Main',address,postcode,lat,lng,open_time,close_time,prep_minutes,extra_minutes,paused from merchants m where m.id=${m.id} and not exists (select 1 from branches b where b.merchant_id=m.id)`;
  setSession(res, m.id);
  res.redirect(302, MURL + '/');
});
route('POST', '/api/m/logout', ({ res }) => setSession(res, 0));
// Delete the café account and everything the café put on the platform. Orders stay: they're transaction records (payments, VAT, refunds).
route('DELETE', '/api/m/account', async ({ m, res, body: b }) => {
  const me = await merchantById(m);
  if (str(b.email, 120).toLowerCase() !== me.email.toLowerCase()) throw bad('Type your account email to confirm');
  if ((await sql`select 1 from orders where merchant_id=${m} and (status in ('pending','accepted','ready') or (status='awaiting_payment' and created_at > now() - interval '1 hour')) limit 1`).length || (await sql`select 1 from disputes where merchant_id=${m} and status='open' limit 1`).length) throw bad('Finish or refund your open orders and resolve open disputes first');
  await sql.transaction([
    sql`delete from branch_off where branch_id in (select id from branches where merchant_id=${m})`,
    sql`delete from branches where merchant_id=${m}`, sql`delete from items where merchant_id=${m}`, sql`delete from categories where merchant_id=${m}`,
    sql`delete from dispute_imgs where dispute_id in (select id from disputes where merchant_id=${m})`, sql`delete from dispute_msgs where dispute_id in (select id from disputes where merchant_id=${m})`, sql`delete from disputes where merchant_id=${m}`,
    sql`delete from offers where merchant_id=${m}`, sql`delete from loyalty where merchant_id=${m}`,
    sql`delete from reviews where merchant_id=${m}`, sql`delete from branch_closures where merchant_id=${m}`, sql`delete from merchant_push where merchant_id=${m}`,
    sql`delete from referrals where referred=${m} or referrer=${m}`, sql`update merchants set referred_by=null where referred_by=${m}`,
    sql`delete from merchants where id=${m}`]);
  setSession(res, 0);
}, true);
const adminEmails = () => (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
async function meFull(m) {
  const me = meOut((await sql.query(`select ${ME} from merchants where id=$1`, [m]))[0]);
  const [branches, closures, c, ref] = await Promise.all([branchesOf(m), closuresOf(m),
    sql`select (select count(*) from categories where merchant_id=${m})::int cats, (select count(*) from items where merchant_id=${m})::int items, (select count(*) from merchant_push where merchant_id=${m})::int push`,
    sql`select count(*)::int n from referrals where referrer=${m}`]);
  const b0 = branches[0] || {}, done = (k, label, ok) => ({ k, label, done: !!ok });
  return { ...me, terms: { accepted: !!me.terms_at, current: me.terms_version === TERMS_VERSION, version: TERMS_VERSION }, terms_at: undefined, terms_version: undefined, loyalty: loyOut(me.loyalty), branches: branches.map((x) => ({ ...x, hidden: lowRated(x) })), closures, is_admin: adminEmails().includes(me.email.toLowerCase()),
    referral: { code: me.referral_code, link: `${MURL}/?ref=${me.referral_code}`, count: ref[0].n, reduced_until: me.reduced_until },
    checklist: [done('address', 'Add your address and postcode', b0.address && b0.postcode), done('logo', 'Upload your logo', me.logo), done('terms', 'Agree to the Merchant Terms', me.terms_at), done('mollie', 'Connect Mollie to get paid', me.mollie),
      done('menu', 'Add a category and your first item', c[0].cats && c[0].items), done('push', 'Turn on new-order notifications', c[0].push),
      done('order', 'Take your first order', me.first_paid)] };
}
route('GET', '/api/m/me', ({ m }) => meFull(m), true);
route('POST', '/api/m/terms', async ({ m, body: b }) => { // agreeing is a prerequisite for connecting Mollie (= launching the store)
  if (b.accept !== true || b.version !== TERMS_VERSION) throw bad('Please read and agree to the current Merchant Terms');
  await sql`update merchants set terms_at=now(), terms_version=${TERMS_VERSION} where id=${m}`;
  return meFull(m);
}, true);

route('PUT', '/api/m/me', async ({ m, body: b }) => {
  const cur = await merchantById(m), n = { ...cur };
  for (const k of ['name', 'address', 'vat_number']) if (typeof b[k] === 'string') n[k] = b[k].trim().slice(0, 120);
  if (/^#[0-9a-f]{6}$/i.test(b.color)) n.color = b.color;
  for (const k of ['vat_registered', 'paused', 'allow_sitin', 'pass_fee', 'test_mode']) if (typeof b[k] === 'boolean') n[k] = b[k];
  for (const k of ['prep_minutes', 'extra_minutes']) if (Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= 120) n[k] = b[k];
  for (const k of ['open_time', 'close_time']) if (TIME.test(b[k])) n[k] = b[k];
  if (typeof b.logo === 'string' && b.logo.length < 4e5 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo)) {
    if (b.logo !== cur.logo) {
      const [, mime, b64] = /^data:(image\/\w+);base64,(.*)$/.exec(b.logo), r = await Q.submit({ kind: 'logo', ref: m, buf: Buffer.from(b64, 'base64'), mime });
      if (r.status === 'flagged') throw bad('That file was flagged by our virus check, so it can’t be uploaded.');
      if (r.status === 'queued') await sql`update merchants set logo_pending=${b.logo} where id=${m}`; // goes live when the virus check finishes
      else n.logo = b.logo;
    }
  }
  if (b.postcode && str(b.postcode, 10).toUpperCase() !== cur.postcode) { n.postcode = str(b.postcode, 10).toUpperCase(); Object.assign(n, await geocode(n.postcode)); }
  if (!n.name) throw bad('Name required');
  if (n.name !== cur.name) await sql`update branches set fhrs_id=null,fhrs_name=null,fhrs_rating=null,fhrs_date=null,fhrs_checked=null where merchant_id=${m}`;
  await sql`update merchants set name=${n.name},address=${n.address},postcode=${n.postcode},lat=${n.lat},lng=${n.lng},logo=${n.logo},color=${n.color},
    vat_registered=${n.vat_registered},vat_number=${n.vat_number},prep_minutes=${n.prep_minutes},extra_minutes=${n.extra_minutes},
    paused=${n.paused},open_time=${n.open_time},close_time=${n.close_time},allow_sitin=${n.allow_sitin !== false},pass_fee=${n.pass_fee === true},test_mode=${n.test_mode === true} where id=${m}`;
  return meFull(m);
}, true);

// ---- branches: same account, menu and brand; each has its own address, hours, prep time and pause switch
const BR_TEXT = ['name', 'address'];
async function branchPatch(cur, b) {
  const n = { ...cur };
  for (const k of BR_TEXT) if (typeof b[k] === 'string') n[k] = b[k].trim().slice(0, 120);
  for (const k of ['paused']) if (typeof b[k] === 'boolean') n[k] = b[k];
  for (const k of ['prep_minutes', 'extra_minutes']) if (Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= 120) n[k] = b[k];
  for (const k of ['open_time', 'close_time']) if (TIME.test(b[k])) n[k] = b[k];
  if (b.postcode && str(b.postcode, 10).toUpperCase() !== cur.postcode) { n.postcode = str(b.postcode, 10).toUpperCase(); Object.assign(n, await geocode(n.postcode)); }
  if (!n.name) throw bad('Branch name required');
  if (!n.postcode) throw bad('Postcode required');
  return n;
}
route('POST', '/api/m/branches', async ({ m, body: b }) => {
  if ((await branchesOf(m)).length >= 50) throw bad('Branch limit reached');
  const n = await branchPatch({ name: '', address: '', postcode: '', open_time: '07:00', close_time: '17:00', prep_minutes: 10, extra_minutes: 0, paused: false }, b);
  await sql`insert into branches (merchant_id,name,address,postcode,lat,lng,open_time,close_time,prep_minutes,extra_minutes,paused) values (${m},${n.name},${n.address},${n.postcode},${n.lat},${n.lng},${n.open_time},${n.close_time},${n.prep_minutes},${n.extra_minutes},${n.paused})`;
  return meFull(m);
}, true);
route('PUT', '/api/m/branches/:id', async ({ m, p, body: b }) => {
  const cur = (await sql`select * from branches where id=${+p.id} and merchant_id=${m}`)[0]; if (!cur) throw bad('Branch not found', 404);
  const n = await branchPatch(cur, b);
  if (n.postcode !== cur.postcode) await sql`update branches set fhrs_id=null,fhrs_name=null,fhrs_rating=null,fhrs_date=null,fhrs_checked=null where id=${cur.id}`; // re-match hygiene rating at the new address
  await sql`update branches set name=${n.name},address=${n.address},postcode=${n.postcode},lat=${n.lat},lng=${n.lng},open_time=${n.open_time},close_time=${n.close_time},prep_minutes=${n.prep_minutes},extra_minutes=${n.extra_minutes},paused=${n.paused} where id=${cur.id}`;
  return meFull(m);
}, true);
// Menu is shared; each branch can switch individual items or whole categories off. body: { kind: 'item'|'cat', ref, off }
route('POST', '/api/m/branches/:id/off', async ({ m, p, body: b }) => {
  const br = (await sql`select id from branches where id=${+p.id} and merchant_id=${m}`)[0]; if (!br) throw bad('Branch not found', 404);
  const kind = b.kind === 'cat' ? 'cat' : 'item', ref = +b.ref;
  const own = kind === 'cat' ? await sql`select 1 from categories where id=${ref} and merchant_id=${m}` : await sql`select 1 from items where id=${ref} and merchant_id=${m}`;
  if (!own.length) throw bad('Not found', 404);
  if (b.off) await sql`insert into branch_off (branch_id,kind,ref_id) values (${br.id},${kind},${ref}) on conflict do nothing`;
  else await sql`delete from branch_off where branch_id=${br.id} and kind=${kind} and ref_id=${ref}`;
}, true);
route('DELETE', '/api/m/branches/:id', async ({ m, p }) => {
  const all = await branchesOf(m); if (all.length < 2) throw bad('You need at least one branch');
  if ((await sql`select 1 from orders where branch_id=${+p.id} and merchant_id=${m} and status in ('pending','accepted','ready')`).length) throw bad('Finish or refund this branch’s open orders first');
  await sql`delete from branches where id=${+p.id} and merchant_id=${m}`;
  await sql`delete from branch_off where branch_id=${+p.id}`;
  return meFull(m);
}, true);

// ---- temporary closures & special hours (today-only overrides of a branch's normal hours; dates are London YYYY-MM-DD)
route('POST', '/api/m/branches/:id/closures', async ({ m, p, body: b }) => {
  const br = (await sql`select id from branches where id=${+p.id} and merchant_id=${m}`)[0]; if (!br) throw bad('Branch not found', 404);
  const kind = b.kind === 'hours' ? 'hours' : 'closed', from = str(b.from_date, 10), to = str(b.to_date, 10) || from;
  if (!DATE.test(from) || !DATE.test(to) || to < from) throw bad('Choose a valid date range');
  if (to < today()) throw bad('That date has already passed');
  if (kind === 'hours' && (!TIME.test(b.open_time) || !TIME.test(b.close_time) || b.open_time >= b.close_time)) throw bad('Opening time must be before closing time');
  await sql`insert into branch_closures (merchant_id,branch_id,from_date,to_date,kind,open_time,close_time,note) values (${m},${br.id},${from},${to},${kind},${kind === 'hours' ? b.open_time : null},${kind === 'hours' ? b.close_time : null},${str(b.note, 80)})`;
  return meFull(m);
}, true);
route('DELETE', '/api/m/closures/:id', async ({ m, p }) => { await sql`delete from branch_closures where id=${+p.id} and merchant_id=${m}`; return meFull(m); }, true);

// ---- thermal printer per branch: body { on?: bool, regen?: bool }
route('POST', '/api/m/branches/:id/printer', async ({ m, p, body: b }) => {
  const br = (await sql`select * from branches where id=${+p.id} and merchant_id=${m}`)[0]; if (!br) throw bad('Branch not found', 404);
  const on = typeof b.on === 'boolean' ? b.on : !!br.printer_on, token = on && (!br.printer_token || b.regen) ? randomBytes(18).toString('base64url') : br.printer_token;
  await sql`update branches set printer_on=${on}, printer_token=${token} where id=${br.id}`;
  return meFull(m);
}, true);
route('POST', '/api/m/orders/:id/reprint', async ({ m, p }) => { await sql`update orders set printed_at=null where id=${(await getOrder(p.id)).id}::uuid and merchant_id=${m}`; }, true);

// ---- offer codes
const offerOut = (o) => ({ ...o, expires_at: o.expires_at ? new Date(o.expires_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) : null });
route('GET', '/api/m/offers', async ({ m }) => (await sql`select * from offers where merchant_id=${m} order by id desc`).map(offerOut), true);
route('POST', '/api/m/offers', async ({ m, body: b }) => {
  const code = str(b.code, 20).toUpperCase(), kind = b.kind === 'fixed' ? 'fixed' : 'percent', value = Math.floor(+b.value), min = Math.floor(+b.min_spend) || 0;
  if (!/^[A-Z0-9]{3,20}$/.test(code)) throw bad('Codes are 3–20 letters or numbers');
  if (!(value >= 1 && value <= (kind === 'percent' ? 100 : 10000))) throw bad(kind === 'percent' ? 'Choose a percentage from 1 to 100' : 'Choose an amount up to £100');
  const max = Math.floor(+b.max_uses) > 0 ? Math.floor(+b.max_uses) : null, exp = DATE.test(b.expires || '') ? b.expires : null;
  try {
    await sql`insert into offers (merchant_id,code,kind,value,min_spend,max_uses,expires_at) values (${m},${code},${kind},${value},${Math.max(0, min)},${max},(${exp}::date + 1)::timestamp at time zone 'Europe/London')`;
  } catch (e) { if (e.code === '23505') throw bad('You already have a code with that name'); throw e; }
}, true);
route('PUT', '/api/m/offers/:id', async ({ m, p, body: b }) => { await sql`update offers set active=${!!b.active} where id=${+p.id} and merchant_id=${m}`; }, true);
route('DELETE', '/api/m/offers/:id', async ({ m, p }) => { await sql`delete from offers where id=${+p.id} and merchant_id=${m}`; }, true);

// ---- loyalty card config
route('PUT', '/api/m/loyalty', async ({ m, body: b }) => {
  const cur = loyOut((await merchantById(m)).loyalty), n = { ...cur };
  if (typeof b.enabled === 'boolean') n.enabled = b.enabled;
  if (typeof b.extras === 'boolean') n.extras = b.extras;
  if (b.earn === 'order' || b.earn === 'item') n.earn = b.earn;
  if (Array.isArray(b.earnCats)) {
    const ids = [...new Set(b.earnCats.map(Number).filter(Number.isInteger))].slice(0, 50);
    if ((await sql`select id from categories where merchant_id=${m} and id = any(${ids})`).length !== ids.length) throw bad('Choose categories from your menu');
    n.earnCats = ids; delete n.earnCat;
  }
  if (typeof b.name === 'string' && b.name.trim()) n.name = b.name.trim().slice(0, 30);
  if (Number.isInteger(b.needed) && b.needed >= 2 && b.needed <= 30) n.needed = b.needed;
  if (['percent', 'fixed', 'product'].includes(b.type)) n.type = b.type;
  if (b.item != null) { if (!(await sql`select 1 from items where id=${+b.item} and merchant_id=${m}`).length) throw bad('Choose an item from your menu'); n.item = +b.item; n.category = null; }
  if (b.category != null) { if (!(await sql`select 1 from categories where id=${+b.category} and merchant_id=${m}`).length) throw bad('Choose a category from your menu'); n.category = +b.category; n.item = null; }
  if (n.type !== 'product' && Number.isInteger(b.value) && b.value >= 1 && b.value <= (n.type === 'percent' ? 100 : 10000)) n.value = b.value;
  if (n.enabled && n.type === 'product' && !n.item && !n.category) throw bad('Choose the free item or category for your loyalty card');
  if (Number.isInteger(b.cap) && b.cap >= 0 && b.cap <= 10000) n.cap = b.cap;
  if (n.type === 'percent' && n.value > 100) n.value = 100;
  await sql`update merchants set loyalty=${JSON.stringify(n)}::jsonb where id=${m}`;
  return meFull(m);
}, true);

// ---- reviews (merchants see everything; customers only see an average once there are 10)
route('GET', '/api/m/reviews', async ({ m }) => {
  const rows = await sql`select r.order_id, r.stars, r.comment, r.created_at, o.num, b.name as branch from reviews r join orders o on o.id=r.order_id left join branches b on b.id=r.branch_id where r.merchant_id=${m} order by r.created_at desc limit 100`;
  const [t] = await sql`select count(*)::int n, coalesce(avg(stars),0)::float avg from reviews where merchant_id=${m}`;
  return { n: t.n, avg: Math.round(t.avg * 10) / 10, shown: t.n >= 10, rows };
}, true);

// ---- admin dashboard (signed in as a café whose email is listed in ADMIN_EMAILS)
const PAID = "status in ('pending','accepted','ready','completed') and not test";
const adminOnly = async (m) => { const me = await merchantById(m); if (!adminEmails().includes(me.email.toLowerCase())) throw bad('Not allowed', 403); };
route('GET', '/api/admin/overview', async ({ m }) => {
  await adminOnly(m);
  const [all] = await sql.query(`select count(*)::int orders, coalesce(sum(total),0)::int gmv, coalesce(sum(fee),0)::int fees from orders where ${PAID}`);
  const [d30] = await sql.query(`select count(*)::int orders, coalesce(sum(total),0)::int gmv, coalesce(sum(fee),0)::int fees from orders where ${PAID} and created_at > now() - interval '30 days'`);
  const [c] = await sql`select count(*)::int cafes, count(*) filter (where mollie_profile is not null)::int live, count(*) filter (where reduced_until > now())::int reduced from merchants`;
  const daily = await sql.query(`select to_char(created_at at time zone 'Europe/London','YYYY-MM-DD') d, count(*)::int orders, sum(total)::int gmv from orders where ${PAID} and created_at > now() - interval '30 days' group by 1 order by 1`);
  return { all, d30, cafes: c, daily };
}, true);
route('GET', '/api/admin/cafes', async ({ m }) => {
  await adminOnly(m);
  return sql.query(`select m.id, m.name, m.email, m.created_at, (m.mollie_profile is not null) live, m.reduced_until, m.fee_pct::float fee_pct, m.referral_code, m.referred_by,
    (select count(*) from branches b where b.merchant_id=m.id)::int branches, coalesce(o.orders,0) orders, coalesce(o.gmv,0) gmv, coalesce(o.fees,0) fees, coalesce(r.n,0) reviews, r.a avg
    from merchants m left join (select merchant_id, count(*)::int orders, sum(total)::int gmv, sum(fee)::int fees from orders where ${PAID} and created_at > now() - interval '30 days' group by 1) o on o.merchant_id=m.id
    left join (select merchant_id, count(*)::int n, avg(stars)::float a from reviews group by 1) r on r.merchant_id=m.id order by m.id desc`);
}, true);
route('GET', '/api/admin/reviews', async ({ m }) => {
  await adminOnly(m);
  return sql`select r.order_id, r.stars, r.comment, r.created_at, m.name from reviews r join merchants m on m.id=r.merchant_id order by r.created_at desc limit 100`;
}, true);
route('DELETE', '/api/admin/reviews/:id', async ({ m, p }) => { await adminOnly(m); await sql`delete from reviews where order_id=${(await getOrder(p.id)).id}::uuid`; }, true);
route('POST', '/api/admin/cafes/:id/reduced', async ({ m, p, body: b }) => { // grant (or with days:0 clear) the reduced fee manually
  await adminOnly(m); const days = Math.min(Math.max(Math.floor(+b.days) || 0, 0), 365);
  await sql`update merchants set reduced_until = case when ${days}=0 then null else greatest(coalesce(reduced_until, now()), now()) + make_interval(days => ${days}) end where id=${+p.id}`;
}, true);

route('POST', '/api/admin/cafes/:id/fee', async ({ m, p, body: b }) => { // set (or with pct:null clear) a custom platform fee for one café
  await adminOnly(m);
  const pct = b.pct === null || b.pct === '' ? null : Math.round(+b.pct * 100) / 100;
  if (pct !== null && !(pct >= 0 && pct <= 50)) throw bad('Enter a fee between 0 and 50%');
  await sql`update merchants set fee_pct=${pct} where id=${+p.id}`;
}, true);

// ---- merchant support desk (escalations): list / read / reply / close, owner only
route('GET', '/api/admin/desk', async ({ m, q }) => {
  await adminOnly(m);
  const f = q.get('f') || 'active';
  return sql`select t.id, t.email, t.name, t.subject, t.status, t.escalated, t.reason, t.updated_at, t.created_at,
      (select body from support_msgs x where x.thread_id=t.id order by x.id desc limit 1) preview, (select count(*)::int from support_msgs x where x.thread_id=t.id) n
    from support_threads t where (${f}='all') or (${f}='active' and t.status<>'done' and (t.escalated or t.status='open')) or (${f}='chains') or t.status=${f}
    order by (t.status='open' and t.escalated) desc, t.updated_at desc limit 200`;
}, true);
route('GET', '/api/admin/desk/:id', async ({ m, p }) => {
  await adminOnly(m);
  const t = (await sql`select * from support_threads where id=${p.id}`)[0]; if (!t) throw bad('Not found', 404);
  return { ...t, msgs: await sql`select id, dir, by, body, files, created_at from support_msgs where thread_id=${p.id} order by id` };
}, true);
route('POST', '/api/admin/desk/:id/reply', async ({ m, p, body: b }) => {
  await adminOnly(m); const text = str(b.text, 6000); if (text.length < 2) throw bad('Write a reply first');
  await D.deskReply(p.id, text);
}, true);
route('POST', '/api/admin/desk/:id/status', async ({ m, p, body: b }) => {
  await adminOnly(m); if (!['open', 'answered', 'done'].includes(b.status)) throw bad('Bad status');
  await sql`update support_threads set status=${b.status}, updated_at=now() where id=${p.id}`;
}, true);

// ================= SUPPORT, COMPLAINTS & DISPUTES =================
const completedOrder = async (id) => { const o = await getOrder(id); if (o.status !== 'completed' && o.status !== 'refunded') throw bad('Support opens once your order is complete'); return o; };
const cafeName = async (o) => (await merchantById(o.merchant_id))?.name || 'the café';
route('POST', '/api/orders/:id/support', async ({ p, body: b }) => { // AI chat. History comes from the browser, so it is length/role-checked and only the assistant's output is trusted for markers
  const o = await completedOrder(p.id);
  const hist = (Array.isArray(b.messages) ? b.messages : []).filter((x) => (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string').slice(-24).map((x) => ({ role: x.role, content: x.content.slice(0, 1000) }));
  if (!hist.length || hist.at(-1).role !== 'user') throw bad('Say something first');
  let reply = await ask(systemPrompt(o, await cafeName(o)), hist), action = null;
  const mk = reply.match(/\[\[(REFUND_REQUEST|COMPLAINT)\]\]/); if (mk) action = mk[1] === 'COMPLAINT' ? 'complaint' : 'refund';
  reply = reply.replace(/\[\[[A-Z_]+\]\]/g, '').trim();
  return { reply, action };
});
route('POST', '/api/orders/:id/complaint', async ({ p, body: b }) => { // goes to the Docket admin dashboard (and admin emails)
  const o = await completedOrder(p.id), summary = str(b.summary, 1500);
  if (summary.length < 10) throw bad('Please describe the problem');
  if ((await sql`select count(*)::int n from complaints where order_id=${o.id}::uuid`)[0].n >= 3) throw bad('You’ve already sent us a few reports about this order');
  const transcript = (Array.isArray(b.transcript) ? b.transcript : []).slice(-30).map((x) => ({ role: x?.role === 'assistant' ? 'assistant' : 'user', content: str(x?.content, 1000) }));
  const c = (await sql`insert into complaints (order_id,merchant_id,cafe_name,customer_name,customer_email,summary,transcript) values (${o.id}::uuid,${o.merchant_id},${await cafeName(o)},${o.customer_name},${o.customer_email},${summary},${JSON.stringify(transcript)}::jsonb) returning *`)[0];
  await notifyAdminComplaint(c);
});
route('POST', '/api/orders/:id/dispute', async ({ p, body: b }) => { // refund request -> the café's Dispute Resolution Centre; café has 7 days
  const o = await completedOrder(p.id), m = await merchantById(o.merchant_id);
  if (o.test || !m) throw bad('This order can’t be disputed');
  if (o.status === 'refunded' || (o.refunded || 0) >= o.total) throw bad('This order has already been refunded');
  if ((await sql`select 1 from disputes where order_id=${o.id}::uuid and status='open'`).length) throw bad('You already have an open refund request for this order');
  const reason = str(b.reason, 1500); if (reason.length < 10) throw bad('Please describe what went wrong');
  const done = o.refunded_items || {};
  const items = Array.isArray(b.items) && b.items.length ? b.items.map((x) => ({ i: +x.i, qty: +x.qty })).filter((x, k, a) => Number.isInteger(x.i) && x.i >= 0 && x.i < o.items.length && Number.isInteger(x.qty) && x.qty >= 1 && x.qty <= o.items[x.i].qty - (done[x.i] || 0) && a.findIndex((y) => y.i === x.i) === k) : null;
  if (Array.isArray(b.items) && b.items.length && !items.length) throw bad('Choose the items you want refunded');
  const d = (await sql`insert into disputes (order_id,merchant_id,reason,items,due_at) values (${o.id}::uuid,${o.merchant_id},${reason},${items && JSON.stringify(items)}::jsonb,now() + interval '7 days') returning *`)[0];
  await addMsg(d.id, 'customer', reason, await saveImgs(d.id, b.images));
  await notifyDisputeOpened(d, o, m);
  return disputeOut(d);
});
route('GET', '/api/disputes/:id/img/:n', async ({ p, res }) => { // ids are unguessable; used by both the customer and the café
  if (!UUID.test(p.id)) throw bad('Not found', 404);
  const r = (await sql`select data from dispute_imgs where id=${+p.n || 0} and dispute_id=${p.id}::uuid and status='clean'`)[0], mt = r?.data.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!mt) throw bad('Not found', 404);
  res.setHeader('Content-Type', mt[1]); res.setHeader('Cache-Control', 'private, max-age=3600'); res.end(Buffer.from(mt[2], 'base64'));
});
// merchant: Dispute Resolution Centre
route('GET', '/api/m/disputes', async ({ m }) => {
  await housekeeping().catch((e) => console.error('housekeeping', e));
  const rows = await sql`select d.*, o.num, o.customer_name, o.items as order_items, o.total, o.refunded from disputes d join orders o on o.id=d.order_id where d.merchant_id=${m} order by (d.status='open') desc, d.created_at desc limit 100`;
  return Promise.all(rows.map(async (d) => ({ ...(await disputeOut(d)), num: d.num, customer_name: d.customer_name, order_items: d.order_items, total: d.total, order_id: d.order_id })));
}, true);
const myDispute = async (m, id) => { const d = UUID.test(id) && (await sql`select * from disputes where id=${id}::uuid and merchant_id=${m} and status='open'`)[0]; if (!d) throw bad('That dispute is no longer open', 404); return d; };
route('POST', '/api/m/disputes/:id/respond', async ({ m, p, body: b }) => { // a reply or evidence stops the 7-day auto-refund clock
  const d = await myDispute(m, p.id), text = str(b.text, 1500), imgs = await saveImgs(d.id, b.images);
  if (!text && !imgs.length) throw bad('Write a reply or add a photo');
  await addMsg(d.id, 'merchant', text, imgs); await sql`update disputes set responded_at=coalesce(responded_at, now()) where id=${d.id}::uuid`;
}, true);
route('POST', '/api/m/disputes/:id/decide', async ({ m, p, body: b }) => {
  const d = await myDispute(m, p.id), text = str(b.text, 1500), mer = await merchantById(m), o = await getOrder(d.order_id), imgs = await saveImgs(d.id, b.images);
  if (b.accept) { if (o.status !== 'refunded') await doRefund(o, mer, d.items); }
  else if (text.length < 5) throw bad('Please explain why you’re refusing');
  const [r] = await sql`update disputes set status=${b.accept ? 'accepted' : 'refused'}, resolved_at=now(), responded_at=coalesce(responded_at, now()) where id=${d.id}::uuid and status='open' returning id`;
  if (!r) throw bad('That dispute was already resolved');
  if (text || imgs.length) await addMsg(d.id, 'merchant', text, imgs);
  await notifyDisputeResult(d, o, mer, b.accept ? 'accepted' : 'refused', text);
}, true);
// admin: customer complaints and a read-only view of disputes
route('GET', '/api/admin/complaints', async ({ m }) => { await adminOnly(m); return sql`select id, order_id, cafe_name, customer_name, customer_email, summary, transcript, status, created_at from complaints order by (status='new') desc, created_at desc limit 100`; }, true);
route('GET', '/api/admin/complaints/:id/order', async ({ m, p }) => { // the order behind a complaint, for the refund sheet
  await adminOnly(m);
  const c = (await sql`select order_id from complaints where id=${+p.id}`)[0]; if (!c?.order_id) throw bad('No order on this complaint', 404);
  const o = await getOrder(c.order_id);
  return { num: o.num, total: o.total, refunded: o.refunded || 0, refunded_items: o.refunded_items || {}, items: o.items, status: o.status, test: !!o.test };
}, true);
route('POST', '/api/admin/complaints/:id/refund', async ({ m, p, body: b }) => { // full (no items) or partial (items) refund from the café's Mollie balance, then email the café
  await adminOnly(m);
  const c = (await sql`select * from complaints where id=${+p.id}`)[0]; if (!c?.order_id) throw bad('No order on this complaint', 404);
  const o = await getOrder(c.order_id), mer = await merchantById(o.merchant_id); if (!mer) throw bad('That café no longer exists');
  if (!['pending', 'accepted', 'ready', 'completed'].includes(o.status)) throw bad('This order can no longer be refunded');
  const items = Array.isArray(b.items) && b.items.length ? b.items.map((x) => ({ i: +x.i, qty: +x.qty })) : null, note = str(b.note, 400);
  await doRefund(o, mer, items);
  const n = await getOrder(o.id), amount = (n.refunded || 0) - (o.refunded || 0);
  await sql`update complaints set status='resolved' where id=${c.id}`;
  await notifyAdminRefund(n, mer, amount, n.status === 'refunded' || (n.refunded || 0) >= n.total, note).catch((e) => console.error('admin refund email', e.message));
  return { amount };
}, true);
route('POST', '/api/admin/complaints/:id/resolve', async ({ m, p }) => { await adminOnly(m); await sql`update complaints set status='resolved' where id=${+p.id}`; }, true);
route('GET', '/api/admin/disputes', async ({ m }) => { await adminOnly(m); return sql`select d.id, d.status, d.reason, d.created_at, d.due_at, o.num, o.total, mm.name as cafe from disputes d join orders o on o.id=d.order_id left join merchants mm on mm.id=d.merchant_id order by d.created_at desc limit 100`; }, true);
route('GET', '/api/cron/housekeeping', async ({ req, q }) => {
  const k = process.env.CRON_SECRET; if (!k || (req.headers.authorization !== 'Bearer ' + k && q.get('key') !== k)) throw bad('Not allowed', 403);
  await housekeeping(true);
});

// ---- kitchen device notifications (Web Push)
route('GET', '/api/m/push', async ({ m, q }) => {
  const r = (await sql`select branch_id from merchant_push where endpoint=${str(q.get('endpoint'), 600)} and merchant_id=${m}`)[0];
  return { on: !!r, branch_id: r?.branch_id ?? null };
}, true);
route('POST', '/api/m/push', async ({ m, body: b }) => {
  const sb = b.sub; if (!/^https:\/\//.test(sb?.endpoint || '') || !sb.keys?.p256dh || !sb.keys?.auth) throw bad('Invalid subscription');
  const br = b.branch_id ? (await sql`select id from branches where id=${+b.branch_id} and merchant_id=${m}`)[0] : null;
  await sql`insert into merchant_push (endpoint,merchant_id,branch_id,sub) values (${sb.endpoint},${m},${br?.id ?? null},${JSON.stringify(sb)}::jsonb)
    on conflict (endpoint) do update set merchant_id=excluded.merchant_id, branch_id=excluded.branch_id, sub=excluded.sub`;
}, true);
route('POST', '/api/m/push/off', async ({ m, body: b }) => { await sql`delete from merchant_push where endpoint=${str(b.endpoint, 600)} and merchant_id=${m}`; }, true);
route('POST', '/api/m/push/test', async ({ m }) => { await pushTest(await merchantById(m)); }, true);

route('GET', '/api/mollie/connect', async ({ m, res }) => {
  if (!(await merchantById(m)).terms_at) throw bad('Agree to the Merchant Terms (in Settings) before launching your store');
  res.redirect(302, M.authUrl(sign({ m, exp: Date.now() + 6e5 }))); }, true);
route('GET', '/api/mollie/callback', async ({ q, res }) => {
  const st = verify(q.get('state')); if (!st || !q.get('code')) throw bad('Mollie connection failed');
  const t = await M.exchange(q.get('code'));
  await M.saveTokens(st.m, t);
  // OAuth tokens are organisation-wide, so /profiles/me isn't allowed: list profiles and take the first (prefer a verified one).
  const list = (await M.api(null, '/profiles', { token: t.access_token }))._embedded?.profiles || [];
  const prof = list.find((x) => x.status === 'verified') || list[0];
  if (!prof) throw bad('Your Mollie account has no website profile yet – create one in the Mollie dashboard, then reconnect');
  await sql`update merchants set mollie_profile=${prof.id} where id=${st.m}`;
  res.redirect(302, MURL + '/');
});

route('GET', '/api/m/menu', async ({ m }) => ({
  categories: await sql`select * from categories where merchant_id=${m} order by sort, id`,
  items: await sql`select * from items where merchant_id=${m} order by id`,
  off: await sql`select branch_id, kind, ref_id from branch_off where branch_id in (select id from branches where merchant_id=${m})`,
}), true);

route('POST', '/api/m/categories', async ({ m, body: b }) => {
  const name = str(b.name, 60); if (!name) throw bad('Name required');
  const t = (x) => (TIME.test(x) ? x : null);
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6];
  if (b.id) await sql`update categories set name=${name},from_time=${t(b.from_time)},to_time=${t(b.to_time)},days=${days} where id=${+b.id} and merchant_id=${m}`;
  else await sql`insert into categories (merchant_id,name,from_time,to_time,days) values (${m},${name},${t(b.from_time)},${t(b.to_time)},${days})`;
}, true);
route('DELETE', '/api/m/categories/:id', async ({ m, p }) => {
  await sql`delete from items where category_id=${+p.id} and merchant_id=${m}`;
  await sql`delete from categories where id=${+p.id} and merchant_id=${m}`;
}, true);

route('POST', '/api/m/items', async ({ m, body: b }) => {
  const name = str(b.name, 80), price = b.price_pence;
  if (!name || !Number.isInteger(price) || price < 0 || price > 1e5) throw bad('Name and a valid price required');
  const opts = (Array.isArray(b.options) ? b.options : []).slice(0, 10).map((g) => ({
    name: str(g.name, 40), multi: !!g.multi,
    choices: (g.choices || []).slice(0, 30).map((c) => ({ name: str(c.name, 40), allergens: cleanAllergens(c.allergens), price: Number.isInteger(c.price) && c.price >= 0 && c.price < 1e4 ? c.price : 0 })).filter((c) => c.name),
  })).filter((g) => g.name && g.choices.length);
  const cat = (await sql`select id from categories where id=${+b.category_id} and merchant_id=${m}`)[0];
  if (!cat) throw bad('Pick a category');
  const row = [name, str(b.description, 200), price, b.available !== false, JSON.stringify(opts), cat.id, JSON.stringify(cleanAllergens(b.allergens)), JSON.stringify(cleanDietary(b.dietary))];
  if (b.id) await sql`update items set name=${row[0]},description=${row[1]},price_pence=${row[2]},available=${row[3]},options=${row[4]}::jsonb,category_id=${row[5]},allergens=${row[6]}::jsonb,dietary=${row[7]}::jsonb where id=${+b.id} and merchant_id=${m}`;
  else await sql`insert into items (merchant_id,name,description,price_pence,available,options,category_id,allergens,dietary) values (${m},${row[0]},${row[1]},${row[2]},${row[3]},${row[4]}::jsonb,${row[5]},${row[6]}::jsonb,${row[7]}::jsonb)`;
}, true);
route('DELETE', '/api/m/items/:id', async ({ m, p }) => { await sql`delete from items where id=${+p.id} and merchant_id=${m}`; }, true);

route('GET', '/api/m/orders', async ({ m }) => { await housekeeping().catch((e) => console.error('housekeeping', e)); return sql`select id,num,branch_id,status,customer_name,pickup_time,asap,items,subtotal,tip,total,created_at,service,allergy,discount,offer_code,reward_used,printed_at,test,alert_at,alerted,refunded,refunded_items from orders
  where merchant_id=${m} and (status in ('pending','accepted','ready') or (status='completed' and created_at > now() - interval '12 hours'))
  order by created_at`; }, true);

const NEXT = { pending: 'accepted', accepted: 'ready', ready: 'completed' };
route('POST', '/api/m/orders/:id/status', async ({ m, p, body }) => {
  const o = await getOrder(p.id);
  if (o.merchant_id !== m || NEXT[o.status] !== body.status) throw bad('Invalid status change');
  const [n] = await sql`update orders set status=${body.status}, updated_at=now() where id=${o.id}::uuid and status=${o.status} returning *`;
  if (n) { const mer = await merchantById(m), br = (await branchesOf(m)).find((x) => x.id === n.branch_id);
    await Promise.allSettled([W.pushUpdate(n.id), n.status === 'accepted' ? notifyAccepted(n, mer) : n.status === 'ready' ? notifyReady(n, { ...mer, address: br?.address || '' }) : null]); }
}, true);

// Refund the whole order, or just some items (body.items = [{ i: line index, qty }]). Money comes back from the MERCHANT's Mollie balance.
// Mollie application fees are non-refundable, so the platform's 5% is kept and the merchant absorbs it.
route('POST', '/api/m/orders/:id/refund', async ({ m, p, body: b }) => {
  const o = await getOrder(p.id);
  if (o.merchant_id !== m || !['pending', 'accepted', 'ready', 'completed'].includes(o.status)) throw bad('This order can no longer be refunded');
  await doRefund(o, await merchantById(m), Array.isArray(b.items) ? b.items.map((x) => ({ i: +x.i, qty: +x.qty })) : null);
}, true);

// ---- sales history: paid orders only (pending/accepted/ready/completed) plus refunds. Proceeds = total − 5% fee;
// a refunded order returns the customer's money but the platform fee is not refunded, so it costs the merchant that fee.
const SOLD = `o.merchant_id=$1 and not o.test and o.status in ('pending','accepted','ready','completed','refunded') and ($2::int is null or o.branch_id=$2)`;
const rng = (q) => ({ days: Math.min(Math.max(parseInt(q.get('days')) || 30, 1), 730), br: parseInt(q.get('branch')) || null });
const inCur = 'o.created_at >= now() - make_interval(days => $3::int)', inPrev = 'o.created_at >= now() - make_interval(days => $3::int * 2) and o.created_at < now() - make_interval(days => $3::int)';
const sumq = (win) => `select count(*) filter (where status<>'refunded')::int orders, coalesce(sum(total - refunded) filter (where status<>'refunded'),0)::int gross,
  coalesce(sum(tip) filter (where status<>'refunded'),0)::int tips, coalesce(sum(vat) filter (where status<>'refunded'),0)::int vat,
  coalesce(sum(fee) filter (where status<>'refunded'),0)::int fees, count(*) filter (where status='refunded')::int refunds,
  coalesce(sum(total) filter (where status='refunded'),0)::int refunded, coalesce(sum(fee) filter (where status='refunded'),0)::int refund_fees
  from orders o where ${SOLD} and ${win}`;
const withNet = (t) => ({ ...t, net: t.gross - t.fees - t.refund_fees });
route('GET', '/api/m/stats', async ({ m, q }) => {
  const { days, br } = rng(q), P = [m, br, days];
  const [[cur], [prev], daily, hours, top, byBranch] = await Promise.all([
    sql.query(sumq(inCur), P), sql.query(sumq(inPrev), P),
    sql.query(`select to_char(o.created_at at time zone 'Europe/London','YYYY-MM-DD') d, count(*)::int orders, sum(total)::int gross from orders o where ${SOLD} and status<>'refunded' and ${inCur} group by 1 order by 1`, P),
    sql.query(`select extract(hour from o.created_at at time zone 'Europe/London')::int h, count(*)::int n from orders o where ${SOLD} and status<>'refunded' and ${inCur} group by 1 order by 1`, P),
    sql.query(`select e->>'name' name, sum((e->>'qty')::int)::int qty, sum((e->>'qty')::int*(e->>'unit')::int)::int rev from orders o, jsonb_array_elements(o.items) e where ${SOLD} and status<>'refunded' and ${inCur} group by 1 order by qty desc limit 8`, P),
    sql.query(`select branch_id, count(*)::int orders, coalesce(sum(total),0)::int gross from orders o where ${SOLD} and status<>'refunded' and ${inCur} group by 1`, P)]);
  return { days, cur: withNet(cur), prev: withNet(prev), daily, hours, top, byBranch };
}, true);

const TXQ = `select o.id,o.num,o.status,o.customer_name,o.pickup_time,o.created_at,o.subtotal,o.tip,o.vat,o.total,o.fee,o.refunded,o.branch_id,o.items from orders o where ${SOLD} and ${inCur}
  and ($4='' or o.customer_name ilike '%'||$4||'%' or o.num::text like $4||'%') order by o.created_at desc`;
route('GET', '/api/m/transactions', async ({ m, q }) => {
  const { days, br } = rng(q), off = Math.max(0, parseInt(q.get('offset')) || 0);
  const rows = await sql.query(`${TXQ} limit 51 offset $5`, [m, br, days, str(q.get('q'), 40), off]);
  return { rows: rows.slice(0, 50), more: rows.length > 50 };
}, true);
const csvCell = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; // customer names are untrusted: neutralise spreadsheet formulas
route('GET', '/api/m/export', async ({ m, q, res }) => {
  const { days, br } = rng(q);
  const rows = await sql.query(`${TXQ} limit 20000`, [m, br, days, '']);
  const names = Object.fromEntries((await branchesOf(m)).map((b) => [b.id, b.name]));
  const pounds = (p) => (p / 100).toFixed(2);
  const lines = [['Order', 'Date (UK)', 'Branch', 'Customer', 'Status', 'Subtotal', 'VAT included', 'Tip', 'Total paid', 'Platform fee (5%)', 'Net to you']].concat(rows.map((o) => [
    o.num, new Date(o.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' }), names[o.branch_id] || '', o.customer_name, o.status, pounds(o.subtotal), pounds(o.vat), pounds(o.tip), pounds(o.total), pounds(o.fee),
    pounds(o.status === 'refunded' ? -o.fee : o.total - (o.refunded || 0) - o.fee)]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="docket-sales-${days}d.csv"`);
  res.end('\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'));
}, true);
