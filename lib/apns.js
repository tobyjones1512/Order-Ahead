// Docket iOS app pushes over APNs (token auth): a notification at each order step, and updates to the order's Live Activity.
// Env: APNS_KEY (contents of the .p8 key, \n escapes allowed), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (the app's bundle id).
// Tokens arrive per order from the app (orders.app_push = { alert, activity, sandbox }); sandbox = Xcode debug build.
import http2 from 'node:http2';
import { sign, createPrivateKey } from 'node:crypto';
import { sql } from './db.js';

const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = process.env;
export const enabled = () => !!(APNS_KEY && APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID);

let jwt = '', jwtAt = 0;
function bearer() { // Apple wants the provider token refreshed between 20 and 60 minutes
  if (Date.now() - jwtAt < 45 * 60e3) return jwt;
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b({ alg: 'ES256', kid: APNS_KEY_ID })}.${b({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = sign('sha256', Buffer.from(head), { key: createPrivateKey(APNS_KEY.replace(/\\n/g, '\n')), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtAt = Date.now(); return (jwt = `${head}.${sig}`);
}

const send = (client, token, headers, payload) => new Promise((ok) => {
  const rq = client.request({ ':method': 'POST', ':path': '/3/device/' + token, authorization: 'bearer ' + bearer(), 'apns-priority': '10', ...headers });
  let status = 0, body = '';
  rq.on('response', (r) => { status = r[':status']; }); rq.on('data', (d) => { body += d; });
  rq.on('close', () => { if (status !== 200) console.error('apns', headers['apns-push-type'], status, body); ok(status); });
  rq.on('error', (e) => { console.error('apns req', e.message); ok(0); });
  rq.end(JSON.stringify(payload));
});

const ALERT = {
  accepted: (o) => ['Being prepared', `The café has started on order #${o.num}.`],
  ready: (o) => ['Ready to collect', `Order #${o.num} is waiting at the counter.`],
  refunded: (o) => ['Order refunded', `Sorry, the café couldn’t make order #${o.num}. Your refund is on its way.`],
};

export async function orderChanged(id) {
  if (!enabled()) return;
  try {
    const [o] = await sql`select o.id, o.num, o.status, o.pickup_time, o.asap, o.app_push, m.name from orders o left join merchants m on m.id=o.merchant_id where o.id=${id}::uuid`;
    const t = o?.app_push; if (!t || (!t.alert && !t.activity)) return;
    const client = http2.connect(t.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    client.on('error', (e) => console.error('apns', e.message));
    const now = Math.floor(Date.now() / 1000), end = ['completed', 'refunded'].includes(o.status), a = ALERT[o.status]?.(o), jobs = [];
    if (t.activity) jobs.push(send(client, t.activity, { 'apns-topic': `${APNS_BUNDLE_ID}.push-type.liveactivity`, 'apns-push-type': 'liveactivity' }, {
      aps: { timestamp: now, event: end ? 'end' : 'update', 'content-state': { status: o.status, pickupTime: o.pickup_time, asap: !!o.asap }, ...(end && { 'dismissal-date': now + 15 * 60 }) } }));
    if (t.alert && a) jobs.push(send(client, t.alert, { 'apns-topic': APNS_BUNDLE_ID, 'apns-push-type': 'alert' }, {
      aps: { alert: { title: `${a[0]} · ${o.name || 'Docket'}`, body: a[1] }, sound: 'default', 'thread-id': o.id }, orderId: o.id }));
    await Promise.race([Promise.all(jobs), new Promise((ok) => setTimeout(ok, 8000))]);
    client.close();
  } catch (e) { console.error('apns', e.message); }
}
