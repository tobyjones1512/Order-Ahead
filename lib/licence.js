// Alcohol Entitlement, decided by a person. A café uploads its licence + details; the file is scanned with VirusTotal; once clean, the owner is emailed the details and the file
// with Grant / Refuse buttons (signed links to a confirm page); the café is emailed the result. The admin dashboard can decide too.
// Statuses: in_review > accepted | refused. Only a granted (and unexpired) Entitlement lets alcohol items past menu review or be ordered.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './db.js';
import * as Q from './scanq.js';
import { notifyLicence, notifyLicenceRequest } from './notify.js';

const TO = () => process.env.ENTITLEMENT_TO || 'toby@thecaffeinemediacompany.com';
const AURL = () => (process.env.ADMIN_URL || process.env.BASE_URL + '/admin').replace(/\/$/, '');
// One link per (café, submission, action): it dies when the café resubmits or a decision is made (decide() only works while in_review).
const mac = (m, a, at) => createHmac('sha256', process.env.SESSION_SECRET).update(`licence|${m.id}|${a}|${new Date(at).getTime()}`).digest('base64url');
export const linkOk = (m, a, k) => { const e = mac(m, a, m.licence_tried); return String(k).length === e.length && timingSafeEqual(Buffer.from(k), Buffer.from(e)); };

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
export const alcOk = (m) => !!m.alcohol_ok && (!m.licence?.expires || m.licence.expires >= today());
export const TYPES = ['Premises licence (England and Wales)', 'Premises licence (Scotland)', 'Premises licence (Northern Ireland)', 'Other'];

const alert = async (mid, scan) => {
  const [m] = await sql`select * from merchants where id=${mid}`; if (!m) return;
  const link = (a) => `${AURL()}/api/entitlement/act?m=${m.id}&a=${a}&k=${mac(m, a, m.licence_tried)}`;
  await notifyLicenceRequest(m, TO(), { file: m.licence_file, scan, links: { grant: link('grant'), refuse: link('refuse') } }).catch((e) => console.error('entitlement alert', e.message));
};

// d = validated details; file = data URI (image or PDF).
export async function submit(mid, d, file) {
  const mt = /^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(file || '');
  if (!mt || file.length > 3e6) throw bad('Upload a photo or PDF of your licence (under 2 MB)');
  const r = await Q.submit({ kind: 'licence', ref: mid, buf: Buffer.from(mt[2], 'base64'), mime: mt[1] });
  if (r.status === 'flagged') throw bad('That file was flagged by our virus check, so it can’t be uploaded.');
  const wait = r.status === 'queued'; // virus check still running: a person is only asked to review it once it comes back clean
  await sql`update merchants set licence=${JSON.stringify(d)}::jsonb, licence_file=${wait ? null : file}, licence_pending=${wait ? file : null}, licence_status='in_review', licence_reason=null, alcohol_ok=false, licence_tried=now() where id=${mid}`;
  if (!wait) await alert(mid, r.status);
  else await Q.processQueue().catch((e) => console.error('scan queue', e.message)); // start the VirusTotal scan now rather than waiting for the next poll
}

// Called by the scan queue when a licence file's virus check finishes (ok = clean).
export async function scanned(mid, url, ok) {
  if (ok) { if ((await sql`update merchants set licence_file=licence_pending, licence_pending=null where id=${mid} and licence_pending=${url} returning id`).length) await alert(mid, 'clean'); return; }
  const [m] = await sql`update merchants set licence_pending=null, licence_status='refused', licence_reason='The file failed our virus check, so it wasn’t used. Upload a different file.' where id=${mid} and licence_pending=${url} returning *`;
  if (m) await notifyLicence(m, 'refused', m.licence_reason).catch(() => {});
}

// Decision (from the email link or the admin dashboard).
export const waiting = () => sql`select id, name, email, address, postcode, licence, licence_tried as submitted from merchants where licence_status='in_review' and licence_pending is null order by licence_tried`;
export async function decide(mid, approve, reason) {
  if (!approve && !reason) throw bad('Say why it was refused, so the café knows what to fix');
  const [m] = await sql`update merchants set licence_status=${approve ? 'accepted' : 'refused'}, alcohol_ok=${approve}, licence_reason=${approve ? null : reason}, licence_at=now() where id=${mid} and licence_status='in_review' and licence_pending is null returning *`;
  if (!m) throw bad('This request isn’t waiting for a decision (it may already have been decided)', 409);
  await notifyLicence(m, m.licence_status, reason).catch((e) => console.error('licence email', e.message));
}
