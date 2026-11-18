import webpush from 'web-push';
import { sql } from './db.js';
import { layout, rows, para, small } from './mail.js';

const { BASE_URL, RESEND_API_KEY, EMAIL_FROM, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } = process.env;
const MURL = (process.env.MERCHANT_URL || BASE_URL + '/m').replace(/\/$/, ''), AURL = (process.env.ADMIN_URL || BASE_URL + '/admin').replace(/\/$/, '');
const gbp = (p) => '£' + (p / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function email(to, subject, html, from = EMAIL_FROM, attachments) {
  if (!RESEND_API_KEY || !to) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: (process.env.SANDBOX ? '[SANDBOX] ' : '') + subject, html, ...(attachments && { attachments }) }),
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
  const body = payload || { title: `New order #${o.num}`, body: `${n} item${n === 1 ? '' : 's'} · ${gbp(o.total)} · ${o.service === 'table' ? 'table ' + o.table_no : 'pickup ' + (o.asap ? '~' : '') + o.pickup_time}`, url: '/m/', tag: 'order-' + o.id, urgent: true };
  await Promise.allSettled(subs.map((s) => webpush.sendNotification(s.sub, JSON.stringify(body)).catch(async (e) => {
    console.error('merchant push', e.statusCode);
    if (e.statusCode === 404 || e.statusCode === 410) await sql`delete from merchant_push where endpoint=${s.endpoint}`; // device unsubscribed
  })));
}
export const pushTest = (m) => pushMerchant(null, m, { title: 'Docket test', body: 'Notifications are working on this device.', url: '/m/', tag: 'test' });

const lineRows = (o) => o.items.map((i) =>
  [`${i.qty} × ${esc(i.name)}${i.opts.length ? `<br><span style="font-size:13px;color:#4A505C">${esc(i.opts.join(', '))}</span>` : ''}`, gbp(i.unit * i.qty)]);
const shell = (m, o) => ({ cafe: m, base: BASE_URL, kicker: `#${o.num}` });

export const receiptHtml = (o, m) => layout({ ...shell(m, o), title: `Thanks ${o.customer_name}, order #${o.num} is in`, stamp: 'Paid', preheader: `${o.service === 'table' ? 'Table ' + o.table_no : 'Pickup ' + (o.asap ? 'about ' : '') + o.pickup_time} · ${gbp(o.total)}`,
  body: para(o.service === 'table' ? `Table: <b>${esc(o.table_no)}</b>` : `Pickup: <b>${o.asap ? 'ASAP, about ' : ''}${esc(o.pickup_time)}</b>`) + rows([
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
  pushMerchant(o, m, o.asap ? undefined : { title: `${o.test ? 'TEST ' : ''}Order #${o.num}, start preparing`, body: `${o.service === 'table' ? 'Table ' + o.table_no : 'Pickup ' + o.pickup_time} · ${gbp(o.total)}`, url: '/m/', tag: 'order-' + o.id, urgent: true }),
  email(m.email, `${o.test ? 'TEST ' : ''}New order #${o.num}, ${gbp(o.total)}`, layout({ head: 'Docket', ...shell(m, o), kicker: o.test ? 'Test order' : 'New order', title: `Order #${o.num} from ${o.customer_name}`, stamp: o.test ? 'Test' : 'New', preheader: `Pickup ${o.pickup_time} · ${gbp(o.total)}`,
    body: para(o.service === 'table' ? `Table: <b>${esc(o.table_no)}</b>` : `Pickup: <b>${o.asap ? 'ASAP, about ' : ''}${esc(o.pickup_time)}</b>`) + (o.items.some((i) => i.alc) ? para(`<b>Contains alcohol.</b> ${C25}`) : '') + rows([...lineRows(o), ['Total', gbp(o.total), { bold: 1, rule: 1 }]]),
    cta: { label: 'Open kitchen', url: `${MURL}/` } })),
]);
export const notifyPaid = (o, m, alertMerchant = true) => Promise.allSettled([
  alertMerchant ? notifyMerchantNew(o, m) : null,
  o.test ? null : email(o.customer_email, `Receipt, ${m.name} #${o.num}`, receiptHtml(o, m)),
]);

export const notifyReady = (o, m) => Promise.allSettled([
  email(o.customer_email, `Your order #${o.num} is ${o.service === 'table' ? 'on its way' : 'ready for pickup'}`, layout({ ...shell(m, o), title: `Order #${o.num} is ${o.service === 'table' ? 'on its way' : 'ready'}`, stamp: o.service === 'table' ? 'Coming' : 'Ready', preheader: o.service === 'table' ? `Coming to table ${o.table_no}` : `Come and collect it from ${m.name}`,
    body: o.service === 'table' ? para(`Hi ${esc(o.customer_name)}, your order is on its way to <b>table ${esc(o.table_no)}</b> at <b>${esc(m.name)}</b>.`) : para(`Hi ${esc(o.customer_name)}, your order is ready for pickup at <b>${esc(m.name)}</b>.`) + (m.address ? para(esc(m.address)) : ''),
    cta: { label: 'View order', url: `${BASE_URL}/?order=${o.id}` } })),
  push(o.push_sub, { title: o.service === 'table' ? 'On its way to your table ☕️' : 'Ready for pickup ☕️', body: o.service === 'table' ? `Order #${o.num} is coming to table ${o.table_no}.` : `Order #${o.num} at ${m.name} is ready.`, url: `/?order=${o.id}`, tag: 'order-' + o.id }),
]);

export const notifyRefund = (o, m, amount = o.total) => o.test ? null : email(o.customer_email, `Order #${o.num} ${o.status === 'refunded' ? '' : 'part-'}refunded`, layout({ ...shell(m, o), title: `Order #${o.num} ${o.status === 'refunded' ? 'refunded' : 'part-refunded'}`, stamp: 'Refunded', preheader: `${gbp(amount)} is on its way back to you`,
  body: para(`Hi ${esc(o.customer_name)}, ${esc(m.name)} has refunded ${o.status === 'refunded' ? 'your order' : 'part of your order'}.`) + rows([['Refunded', gbp(amount), { bold: 1 }]]) + para('It goes back to your original payment method and can take a few days to appear.') }));

// Platform emails (not sent on behalf of a café): sign-in for customers (6-digit code) and cafés (link).
const DOCKET = { name: 'Docket', color: '#2B39F0' };
export const customerCodeHtml = (code) => layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Sign in', title: 'Your sign-in code', stamp: 'Code', preheader: `${code}, valid for 10 minutes`,
  body: `<div style="margin:6px 0 14px;font:900 38px/1 'Courier New',Courier,monospace;letter-spacing:.25em;color:#14161B">${esc(code)}</div>` + para('Enter this code in Docket to sign in. It works for 10 minutes.') + small('If you didn’t ask for this, you can ignore this email.') });
export const merchantLinkHtml = (url) => layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Kitchen', title: 'Sign in to Docket', stamp: 'Sign in', preheader: 'Your sign-in link is valid for 15 minutes',
  body: para('Tap the button to sign in to your café account. The link works for 15 minutes.') + small('If you didn’t ask for this, you can ignore this email.'),
  cta: { label: 'Sign in', url } });

export const notifyAccepted = (o, m) => push(o.push_sub, { title: 'Your order is being prepared', body: `Order #${o.num} at ${m.name} is in progress.`, url: `/?order=${o.id}`, tag: 'order-' + o.id });

// Disputes (refund requests) and complaints
export const notifyDisputeOpened = (d, o, m) => email(m.email, `Refund request, order #${o.num}`, layout({ head: 'Docket', ...shell(m, o), kicker: 'Dispute', title: `${o.customer_name} has asked for a refund`, stamp: 'Dispute', preheader: 'Respond within 7 days or the refund is granted automatically',
  body: para(`Order #${o.num}. <b>Please respond within 7 days.</b> If you don’t, the refund is granted automatically.`) + small(esc(String(d.reason).slice(0, 500))), cta: { label: 'Open Dispute Resolution Centre', url: `${MURL}/#disputes` } }));
export const notifyDisputeResult = (d, o, m, outcome, note = '') => email(o.customer_email, `Your refund request for order #${o.num}`, layout({ ...shell(m, o), kicker: 'Refund request', title: outcome === 'refused' ? 'Your refund request was declined' : 'Your refund was approved',
  stamp: outcome === 'refused' ? 'Declined' : 'Approved', preheader: outcome === 'refused' ? `${m.name} replied to your request` : 'It’s on its way back to you',
  body: para(outcome === 'refused' ? `${esc(m.name)} has declined your refund request for order #${o.num}.` : `${esc(m.name)} ${outcome === 'auto' ? 'didn’t respond within 7 days, so your refund was granted automatically.' : 'approved your refund.'} It goes back to your original payment method and can take a few days to appear.`) + (note ? small('Their reply: ' + esc(note.slice(0, 500))) : ''),
  cta: { label: 'View order', url: `${BASE_URL}/?order=${o.id}` } }));
// Docket (admin) refunded an order after a customer complaint: tell the café, since the money comes out of its Mollie balance
export const notifyAdminRefund = (o, m, amount, whole, note = '') => email(m.email, `Docket refunded order #${o.num}`, layout({ head: 'Docket', ...shell(m, o), kicker: 'Refund', title: `Docket refunded ${gbp(amount)} on order #${o.num}`, stamp: 'Refunded', preheader: 'After a customer complaint',
  body: para(`After a complaint from ${esc(o.customer_name)}, Docket has issued a ${whole ? 'full' : 'partial'} refund of ${gbp(amount)} on order #${o.num}.`) + rows([['Refunded', gbp(amount), { bold: 1 }]])
    + para('The refund was paid from your Mollie balance. As with every refund, the platform fee on the order is not returned (see section 8 of the Merchant Terms).') + (note ? small(`Note from Docket: ${esc(note)}`) : '') + small('If you disagree, reply to this email or write to merchantsupport@placemyorder.online.'),
  cta: { label: 'Open your sales', url: `${MURL}/#sales` } }));
export const notifyAdminComplaint = (c) => Promise.allSettled((process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean).map((to) => email(to, `Customer complaint, ${c.cafe_name}`, layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Complaint', title: `Complaint about ${c.cafe_name}`, stamp: 'New',
  body: para(esc(String(c.summary).slice(0, 800))) + small(`From ${esc(c.customer_name)} (${esc(c.customer_email)})`), cta: { label: 'Open admin dashboard', url: `${AURL}/` } }))));

// Result of the AI menu review (sent from noreply@). `rule` = the guideline section a refusal cites.
export const notifyMenuReview = (m, cs) => {
  const n = (st) => cs.filter((c) => c.status === st).length, ok = n('accepted'), rs = n('restricted'), no = n('refused'), k = (x) => `${x} change${x === 1 ? '' : 's'}`;
  const word = { accepted: 'Accepted', restricted: 'Restricted', refused: 'Refused' };
  const line = (c) => para(`<b>${word[c.status]}: ${c.kind === 'cat' ? 'category' : 'item'} “${esc(c.data.name)}”</b>`
    + (c.status === 'accepted' ? '<br>Now live for customers.' : c.status === 'restricted' ? '<br>Now live, but marked <b>Restricted</b>: it can only be ordered with table service, never takeaway or eat-in.'
      : `<br>Not live, your current menu is unchanged.${c.rule ? `<br>Merchant Terms section ${c.rule.id}, ${esc(c.rule.title)}: ${esc(c.rule.text)}` : ''}<br>Why: ${esc(c.reason)}`));
  const parts = [ok && `${ok} accepted`, rs && `${rs} restricted`, no && `${no} refused`].filter(Boolean).join(', ');
  return email(m.email, `Menu review: ${parts}`,
    layout({ cafe: m, head: 'Docket', base: BASE_URL, kicker: 'Menu review', title: 'Your menu review is done', stamp: no ? (ok + rs ? 'Reviewed' : 'Refused') : rs ? 'Reviewed' : 'Accepted', preheader: parts,
      body: para(`${ok + rs} of ${k(cs.length)} went live${no ? ` and ${no} ${no === 1 ? 'was' : 'were'} refused` : ''}.`) + cs.map(line).join('')
        + (rs ? small('Restricted items are only shown to customers while Table service is switched on in your settings.') : '') + (no ? small(`Fix refused changes and send them for review again. Read the full <a href="${BASE_URL}/terms/">Merchant Terms</a>.`) : ''),
      cta: { label: 'Open your menu', url: `${MURL}/#menu` } }), process.env.MENU_REVIEW_FROM || 'Docket <noreply@placemyorder.online>');
};

// Result of the Alcohol Entitlement decision (sent from noreply@)
export const notifyLicence = (m, status, reason) => { const ok = status === 'accepted';
  return email(m.email, `Alcohol Entitlement ${ok ? 'granted' : 'refused'}`, layout({ cafe: m, head: 'Docket', base: BASE_URL, kicker: 'Alcohol Entitlement', title: ok ? 'Your Alcohol Entitlement was granted' : 'Your Alcohol Entitlement was refused', stamp: ok ? 'Granted' : 'Refused', preheader: ok ? 'You can now list alcohol' : 'It needs fixing before you can list alcohol',
    body: ok ? para('Your Alcohol Entitlement has been granted. You can now add items containing alcohol to your menu. They are marked <b>Restricted</b> and can only be ordered with table service, so switch on Table service in Settings.') + small('You must keep your licence valid and tell us if it is suspended or revoked.')
      : para('Your Alcohol Entitlement request was refused, so you can’t list alcohol yet.') + para(`Why: ${esc(reason)}`) + small('Fix this and request it again from Settings.'),
    cta: { label: ok ? 'Open your menu' : 'Open Settings', url: `${MURL}/#${ok ? 'menu' : 'settings'}` } }), process.env.MENU_REVIEW_FROM || 'Docket <noreply@placemyorder.online>'); };
export const C25 = 'Selling alcohol to anyone under 18 is illegal. Follow Challenge 25: ask for valid photo ID (passport, photocard driving licence or PASS card) from anyone who looks under 25, and refuse to serve them without it.';

// A café has requested the Alcohol Entitlement: email the owner the details and the licence file, with Grant / Refuse buttons (links: { grant, refuse }).
export const notifyLicenceRequest = (m, to, { file, links, scan }) => { const d = m.licence || {}, mt = /^data:([\w/+.-]+);base64,(.*)$/.exec(file || ''), ext = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/webp': 'webp' }[mt?.[1]] || 'jpg';
  const btn = (label, url, bg) => `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:0 10px 8px 0"><tr><td style="background:${bg};border-radius:8px"><a href="${esc(url)}" style="display:inline-block;padding:14px 22px;font:700 14px 'Courier New',Courier,monospace;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF;text-decoration:none">${label}</a></td></tr></table>`;
  return email(to, `Alcohol Entitlement request: ${m.name}`, layout({ cafe: DOCKET, platform: true, base: BASE_URL, kicker: 'Alcohol Entitlement', title: `${m.name} wants to sell alcohol`, stamp: 'Review', preheader: 'Grant or refuse the Alcohol Entitlement',
    body: para('A café has requested the Alcohol Entitlement. Its licence is attached. Check it, then grant or refuse the Entitlement.') + rows([['Café', esc(m.name)], ['Account email', esc(m.email)], ['Café address', esc(`${m.address || ''} ${m.postcode || ''}`.trim())], ['Licence type', esc(d.type)], ['Licence number', esc(d.number)], ['Issuing council', esc(d.issuer)], ['Holder', esc(d.holder)], ['Premises', esc(d.premises)], ['Supervisor', esc(d.dps || 'none given')], ['Expires', esc(d.expires || 'no expiry given')], ['Virus scan', scan === 'clean' ? 'VirusTotal: clean' : 'not scanned']])
      + `<div style="margin:18px 0 0">${btn('Grant Entitlement', links.grant, '#0F6B37')}${btn('Refuse', links.refuse, '#C42F17')}</div>` }),
    process.env.ESCALATIONS_FROM || 'Docket Escalations <escalations@placemyorder.online>', mt ? [{ filename: `licence-${m.id}.${ext}`, content: mt[2] }] : undefined); };
