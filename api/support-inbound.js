// Resend "email.received" webhook for merchantsupport@placemyorder.online. Separate from api/index.js because the signature covers the exact bytes Resend sent.
// Env: RESEND_API_KEY, RESEND_WEBHOOK_SECRET (the webhook's "whsec_..." signing secret), SUPPORT_API_KEY (the AI), VIRUSTOTAL_API_KEY, DATABASE_URL.
import { init } from '../lib/db.js';
import { verifySignature, handleInbound, addr, SUPPORT, ESCALATIONS } from '../lib/desk.js';

export const config = { api: { bodyParser: false } };

const readRaw = (req) => new Promise((ok, no) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', no); });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const raw = await readRaw(req);
  if (!verifySignature(raw, req.headers, process.env.RESEND_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Bad signature' });
  let evt; try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  if (evt.type !== 'email.received' || !evt.data?.email_id) return res.status(200).json({ ok: true, ignored: 'event' });
  if (!([].concat(evt.data.to || []).map(addr)).some((a) => a === SUPPORT || a === ESCALATIONS)) return res.status(200).json({ ok: true, ignored: 'recipient' });
  try { await init(); res.status(200).json(await handleInbound(evt)); } catch (e) { console.error(e); res.status(200).json({ ok: false }); }
}
