// Apple Wallet order tracking: builds + signs .order packages and pings devices when an order changes.
// Needs env: WALLET_ORDER_P12 (base64 .p12), WALLET_ORDER_P12_PASSWORD, WALLET_ORDER_TYPE_ID, APPLE_TEAM_ID.
// Optional: WALLET_MERCHANT_ID (Apple Pay merchant id shown to Wallet; default merchant.<order type id without "order.">).
import { createHash, createHmac } from 'node:crypto';
import http2 from 'node:http2';
import forge from 'node-forge';
import { zipSync, strToU8 } from 'fflate';
import WWDR from './wwdr.js';
import { sql } from './db.js';

const { WALLET_ORDER_P12, WALLET_ORDER_P12_PASSWORD, WALLET_ORDER_TYPE_ID, SESSION_SECRET, BASE_URL } = process.env;
export const TYPE = WALLET_ORDER_TYPE_ID;
export const enabled = () => !!(WALLET_ORDER_P12 && WALLET_ORDER_TYPE_ID);

let creds;
function load() {
  if (creds) return creds;
  const der = forge.util.decode64(WALLET_ORDER_P12.replace(/\s/g, ''));
  let p12, err;
  for (const pw of [WALLET_ORDER_P12_PASSWORD ?? '', (WALLET_ORDER_P12_PASSWORD ?? '').trim(), '']) { // an empty password may have been stored as a space
    try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), pw); break; } catch (e) { err = e; }
  }
  if (!p12) throw new Error('Could not open the Wallet .p12 (wrong password or unsupported encryption): ' + err?.message);
  const keys = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert);
  const key = keys[0]?.key; if (!key) throw new Error('No private key inside the .p12 – export the certificate WITH its private key');
  const cert = certs.find((c) => forge.pki.publicKeyToPem(c.publicKey) === forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(key.n, key.e))) || certs[0];
  const ou = cert.issuer.getField('OU')?.value; // G3 / G4 / G5 / G6
  const wwdr = forge.pki.certificateFromPem(WWDR[ou] || WWDR.G4);
  return (creds = { key, cert, wwdr, pemKey: forge.pki.privateKeyToPem(key), pemCert: forge.pki.certificateToPem(cert) });
}

export const authToken = (orderId) => createHmac('sha256', SESSION_SECRET).update('wallet:' + orderId).digest('base64url');
export const info = (orderId) => (enabled() ? { orderTypeIdentifier: TYPE, orderIdentifier: orderId, webServiceURL: `${BASE_URL}/api/wallet`, authenticationToken: authToken(orderId) } : null);

// "HH:MM" today in London -> ISO instant
function londonISO(hhmm) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()), g = new Date(`${d}T${hhmm}:00Z`);
  const wall = new Date(g.toLocaleString('en-US', { timeZone: 'Europe/London' })); // parsed as server-local (UTC on Vercel)
  return new Date(g.getTime() + (g.getTime() - wall.getTime())).toISOString();
}
const money = (p) => ({ amount: (p / 100).toFixed(2), currency: 'GBP' });
const STATE = { // our status -> [order status, pickup fulfilment status, text for the customer]
  awaiting_payment: ['open', 'open', 'Waiting for payment'], pending: ['open', 'open', 'Received'], accepted: ['open', 'processing', 'In progress'],
  ready: ['open', 'readyForPickup', 'Ready to collect'], completed: ['completed', 'pickedUp', 'Collected'], refunded: ['cancelled', 'cancelled', 'Refunded'],
};

export function orderJson(o, m, br, many, estimateOnly = false) {
  let [status, fstatus, text] = STATE[o.status] || STATE.pending;
  if (estimateOnly && status === 'open') { fstatus = 'open'; text = `Estimated ready around ${o.pickup_time}`; } // printer cafés don't update statuses
  const name = m.name + (many ? ' · ' + br.name : '');
  const created = new Date(o.created_at).toISOString(), updated = new Date(Math.max(+new Date(o.updated_at || o.created_at), +new Date(created))).toISOString();
  return {
    schemaVersion: 1, orderType: 'ecommerce', orderTypeIdentifier: TYPE, orderIdentifier: o.id, orderNumber: String(o.num),
    createdAt: created, updatedAt: updated, status, statusDescription: text,
    merchant: { displayName: name, merchantIdentifier: process.env.WALLET_MERCHANT_ID || 'merchant.' + TYPE.replace(/^order\./, ''), url: BASE_URL },
    orderManagementURL: `${BASE_URL}/?order=${o.id}`, webServiceURL: `${BASE_URL}/api/wallet`, authenticationToken: authToken(o.id),
    lineItems: (o.items || []).map((i) => ({ title: i.name, quantity: i.qty, ...(i.opts?.length ? { subtitle: i.opts.join(', ') } : {}), price: money(i.unit * i.qty) })),
    payment: { total: money(o.total), status: o.status === 'awaiting_payment' ? 'pending' : o.status === 'refunded' ? 'refunded' : 'paid' },
    fulfillments: [{ fulfillmentType: 'pickup', fulfillmentIdentifier: 'pickup', displayName: name, status: fstatus, statusDescription: text,
      pickupAt: londonISO(o.pickup_time), pickupWindowDuration: 'PT15M', ...(br?.address ? { notes: br.address } : {}) }],
  };
}

// zip { order.json, manifest.json, signature } -> Buffer (served as application/vnd.apple.finance.order)
export function buildPackage(order) {
  const c = load();
  const orderBytes = strToU8(JSON.stringify(order));
  const manifest = JSON.stringify({ 'order.json': createHash('sha256').update(orderBytes).digest('hex') });
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest, 'utf8');
  p7.addCertificate(c.cert); p7.addCertificate(c.wwdr);
  p7.addSigner({ key: c.key, certificate: c.cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }] });
  p7.sign({ detached: true });
  const signature = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
  return Buffer.from(zipSync({ 'order.json': orderBytes, 'manifest.json': strToU8(manifest), signature: new Uint8Array(signature) }, { level: 0 }));
}

// Wake every device that added this order so it re-fetches the package (APNs: topic = order type id, empty payload).
export async function pushUpdate(orderId) {
  if (!enabled()) return;
  try {
    const regs = await sql`select push_token from wallet_regs where order_id=${orderId}::uuid`;
    console.log('wallet push', orderId, regs.length, 'device(s)');
    if (!regs.length) return;
    const c = load(), client = http2.connect('https://api.push.apple.com', { cert: c.pemCert, key: c.pemKey });
    client.on('error', (e) => console.error('apns', e.message));
    const send = (token, type) => new Promise((ok) => {
      const h = { ':method': 'POST', ':path': '/3/device/' + token, 'apns-topic': TYPE, 'apns-priority': '10', ...(type ? { 'apns-push-type': type } : {}) };
      const rq = client.request(h); let status = 0, body = '';
      rq.on('response', (r) => { status = r[':status']; }); rq.on('data', (d) => { body += d; });
      rq.on('close', () => { console.log('apns', type || 'no-type', status, body, '…' + token.slice(-6)); ok({ status, body }); });
      rq.on('error', (e) => { console.error('apns req', e.message); ok({ status: 0, body: e.message }); }); rq.end('{}');
    });
    await Promise.race([
      Promise.all(regs.map(async (r) => { // Apple's docs only say "empty payload, topic = order type id": try without a push type first, then the typed variants
        for (const type of [null, 'background', 'alert']) {
          const { status, body } = await send(r.push_token, type);
          if (status === 200) return;
          if (status === 410) return sql`delete from wallet_regs where push_token=${r.push_token}`;
          if (status !== 400 || !/PushType/.test(body)) return;
        }
      })),
      new Promise((ok) => setTimeout(ok, 8000))]);
    client.close();
  } catch (e) { console.error('wallet push', e.message); }
}
