import webpush from 'web-push';
import { sql } from './db.js';
import { layout, rows, para, small } from './mail.js';

const { BASE_URL, RESEND_API_KEY, EMAIL_FROM, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } = process.env;
const MURL = (process.env.MERCHANT_URL || BASE_URL + '/m').replace(/\/$/, ''), AURL = (process.env.ADMIN_URL || BASE_URL + '/admin').replace(/\/$/, '');
const gbp = (p) => '£' + (p / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function email(to, subject, html) {
  if (!RESEND_API_KEY || !to) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
  });
  if (!r.ok) console.error('resend', await r.text());
}

// VAPID_EMAIL may be stored with or without "mailto:"; a bad value makes web-push throw, which used to fail silently.
function vapid() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) { console.error('push: VAPID keys are not set'); return false; }
  try { webpush.setVapidDetails(/^(mailto:|https:)/.test(VAPID_EMAIL || '') ? VAPID_EMAIL : `mailto:${VAPID_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); return true; } catch (e) { console.error('push: bad VAPID config', e.message); return false; }
}
async function push(sub, payload) {
  if (!sub?.endpoint || !vapid()) return;
  await webpush.sendNotification(sub, JSON.stringify(payload)).then(() => console.log('push sent', payload.tag || ''), (e) => console.error('push failed', e.statusCode, e.body));
}

// New-order alert to every kitchen device the merchant has switched notifications on for (all branches, or just this order's branch).
async function pushMerchant(o, m, payload) {
  if (!vapid()) return;
  const subs = await sql`select endpoint, sub from merchant_push where merchant_id=${m.id} and (branch_id is null or branch_id=${o?.branch_id ?? null})`;
  const n = o ? o.items.reduce((a, i) => a + i.qty, 0) : 0;
  const body = payload || { title: `New order #${o.num}`, body: `${n} item${n === 1 ? '' : 's'} · ${gbp(o.total)} · pickup ${o.asap ? '~' : ''}${o.pickup_time}`, url: '/m/', tag: 'order-' + o.id, urgent: true };
  await Promise.allSettled(subs.map((s) => webpush.sendNotification(s.sub, JSON.stringify(body)).catch(async (e) => {
    console.error('merchant push', e.statusCode);
    if (e.statusCode === 404 || e.statusCode === 410) await sql`delete from merchant_push where endpoint=${s.endpoint}`; // device unsubscribed
  })));
}
export const pushTest = (m) => pushMerchant(null, m, { title: 'Docket test', body: 'Notifications are working on this device.', url: '/m/', tag: 'test' });

const lineRows = (o) => o.items.map((i) =>
  [`${i.qty} × ${esc(i.name)}${i.opts.length ? `<br><span style="font-size:13px;color:#4A505C">${esc(i.opts.join(', '))}</span>` : ''}`, gbp(i.unit * i.qty)]);
const shell = (m, o) => ({ cafe: m, base: BASE_URL, kicker: `#${o.num}` });

export const receiptHtml = (o, m) => layout({ ...shell(m, o), title: `Thanks ${o.customer_name} – order #${o.num} is in`, stamp: 'Paid', preheader: `Pickup ${o.asap ? 'about ' : ''}${o.pickup_time} · ${gbp(o.total)}`,
  body: para(`Pickup: <b>${o.asap ? 'ASAP, about ' : ''}${esc(o.pickup_time)}</b>`) + rows([
    ...lineRows(o),
    ['Subtotal', gbp(o.subtotal), { rule: 1 }],
    ...(o.discount ? [[o.offer_code ? `Offer ${o.offer_code}` : 'Loyalty reward', '−' + gbp(o.discount)]] : []),
    ...(o.service === 'sitin' ? [['Eating in', '', { small: 1 }]] : []),
    ...(o.vat ? [['Includes VAT (20%)', gbp(o.vat), { small: 1 }]] : []),
    ...(o.tip ? [['Tip', gbp(o.tip)]] : []),
    ['Total paid', gbp(o.total), { bold: 1, rule: 1 }]]) + (o.vat && m.vat_number ? small(`VAT no. ${esc(m.vat_number)}`) : ''),
  cta: { label: 'Track your order', url: `${BASE_URL}/?order=${o.id}` } });

// Kitchen alert: web push + email. Scheduled orders send this later, once it's time to start preparing (see housekeeping in the API).
export const notifyMerchantNew = (o, m) => Promise.allSettled([
  pushMerchant(o, m, o.asap ? undefined : { title: `${o.test ? 'TEST ' : ''}Order #${o.num} – start preparing`, body: `Pickup ${o.pickup_time} · ${gbp(o.total)}`, url: '/m/', tag: 'order-' + o.id, urgent: true }),
  email(m.email, `${o.test ? 'TEST ' : ''}New order #${o.num} – ${gbp(o.total)}`, layout({ ...shell(m, o), kicker: o.test ? 'Test order' : 'New order', title: `Order #${o.num} from ${o.customer_name}`, stamp: o.test ? 'Test' : 'New', preheader: `Pickup ${o.pickup_time} · ${gbp(o.total)}`,
    body: para(`Pickup: <b>${o.asap ? 'ASAP, about ' : ''}${esc(o.pickup_time)}</b>`) + rows([...lineRows(o), ['Total', gbp(o.total), { bold: 1, rule: 1 }]]),
    cta: { label: 'Open kitchen', url: `${MURL}/` } })),
]);
export const notifyPaid = (o, m, alertMerchant = true) => Promise.allSettled([
  alertMerchant ? notifyMerchantNew(o, m) : null,
  o.test ? null : email(o.customer_email, `Receipt – ${m.name} #${o.num}`, receiptHtml(o, m)),
]);

export const notifyReady = (o, m) => Promise.allSettled([
  email(o.customer_email, `Your order #${o.num} is ready for pickup`, layout({ ...shell(m, o), title: `Order #${o.num} is ready`, stamp: 'Ready', preheader: `Come and collect it from ${m.name}`,
    body: para(`Hi ${esc(o.customer_name)}, your order is ready for pickup at <b>${esc(m.name)}</b>.`) + (m.address ? para(esc(m.address)) : ''),
    cta: { label: 'View order', url: `${BASE_URL}/?order=${o.id}` } })),
  push(o.push_sub, { title: 'Ready for pickup ☕️', body: `Order #${o.num} at ${m.name} is ready.`, url: `/?order=${o.id}`, tag: 'order-' + o.id }),
]);

export const notifyRefund = (o, m, amount = o.total) => o.test ? null : email(o.customer_email, `Order #${o.num} ${amount < o.total ? 'part-' : ''}refunded`, layout({ ...shell(m, o), title: `Order #${o.num} ${o.status === 'refunded' ? 'refunded' : 'part-refunded'}`, stamp: 'Refunded', preheader: `${gbp(amount)} is on its way back to you`,
  body: para(`Hi ${esc(o.customer_name)}, ${esc(m.name)} has refunded ${o.status === 'refunded' ? 'your order' : 'part of your order'}.`) + rows([['Refunded', gbp(amount), { bold: 1 }]]) + para('It goes back to your original payment method and can take a few days to appear.') }));

// Platform emails (not sent on behalf of a café): sign-in for customers (6-digit code) and cafés (link).
const DOCKET = { name: 'Docket', color: '#2B39F0' };
export const customerCodeHtml = (code) => layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Sign in', title: 'Your sign-in code', stamp: 'Code', preheader: `${code} – valid for 10 minutes`,
  body: `<div style="margin:6px 0 14px;font:900 38px/1 'Courier New',Courier,monospace;letter-spacing:.25em;color:#14161B">${esc(code)}</div>` + para('Enter this code in Docket to sign in. It works for 10 minutes.') + small('If you didn’t ask for this, you can ignore this email.') });
export const merchantLinkHtml = (url) => layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Kitchen', title: 'Sign in to Docket', stamp: 'Sign in', preheader: 'Your sign-in link is valid for 15 minutes',
  body: para('Tap the button to sign in to your café account. The link works for 15 minutes.') + small('If you didn’t ask for this, you can ignore this email.'),
  cta: { label: 'Sign in', url } });

export const notifyAccepted = (o, m) => push(o.push_sub, { title: 'Your order is being prepared', body: `Order #${o.num} at ${m.name} is in progress.`, url: `/?order=${o.id}`, tag: 'order-' + o.id });

// Disputes (refund requests) and complaints
export const notifyDisputeOpened = (d, o, m) => email(m.email, `Refund request – order #${o.num}`, layout({ ...shell(m, o), kicker: 'Dispute', title: `${o.customer_name} has asked for a refund`, stamp: 'Dispute', preheader: 'Respond within 7 days or the refund is granted automatically',
  body: para(`Order #${o.num}. <b>Please respond within 7 days.</b> If you don’t, the refund is granted automatically.`) + small(esc(String(d.reason).slice(0, 500))), cta: { label: 'Open Dispute Resolution Centre', url: `${MURL}/#disputes` } }));
export const notifyDisputeResult = (d, o, m, outcome, note = '') => email(o.customer_email, `Your refund request for order #${o.num}`, layout({ ...shell(m, o), kicker: 'Refund request', title: outcome === 'refused' ? 'Your refund request was declined' : 'Your refund was approved',
  stamp: outcome === 'refused' ? 'Declined' : 'Approved', preheader: outcome === 'refused' ? `${m.name} replied to your request` : 'It’s on its way back to you',
  body: para(outcome === 'refused' ? `${esc(m.name)} has declined your refund request for order #${o.num}.` : `${esc(m.name)} ${outcome === 'auto' ? 'didn’t respond within 7 days, so your refund was granted automatically.' : 'approved your refund.'} It goes back to your original payment method and can take a few days to appear.`) + (note ? small('Their reply: ' + esc(note.slice(0, 500))) : ''),
  cta: { label: 'View order', url: `${BASE_URL}/?order=${o.id}` } }));
export const notifyAdminComplaint = (c) => Promise.allSettled((process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean).map((to) => email(to, `Customer complaint – ${c.cafe_name}`, layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Complaint', title: `Complaint about ${c.cafe_name}`, stamp: 'New',
  body: para(esc(String(c.summary).slice(0, 800))) + small(`From ${esc(c.customer_name)} (${esc(c.customer_email)})`), cta: { label: 'Open admin dashboard', url: `${AURL}/` } }))));
