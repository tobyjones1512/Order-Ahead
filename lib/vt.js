// VirusTotal API calls (VIRUSTOTAL_API_KEY lives in the Vercel env, never in the repo). Nothing here waits for a scan: lib/scanq.js queues files and
// starts at most 3 a minute. Verdicts are remembered by SHA-256 (scanned_files) so a file is never scanned twice.
import crypto from 'node:crypto';
import { sql } from './db.js';

const VT = 'https://www.virustotal.com/api/v3';
export const vtKey = () => process.env.VIRUSTOTAL_API_KEY;
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fail = (msg, status = 503) => Object.assign(new Error(msg), { status });
const vt = (path, opt = {}) => fetch(VT + path, { ...opt, headers: { 'x-apikey': vtKey(), ...opt.headers }, signal: AbortSignal.timeout(15000) });
const verdictOf = (s = {}) => { const malicious = +s.malicious || 0, suspicious = +s.suspicious || 0; return { status: malicious + suspicious > 0 ? 'flagged' : 'clean', malicious, suspicious }; };
const total = (s = {}) => ['malicious', 'suspicious', 'harmless', 'undetected'].reduce((n, k) => n + (+s[k] || 0), 0);

/** A remembered verdict for this hash, or null. */
export const known = async (sha) => (await sql`select verdict as status, malicious, suspicious from scanned_files where sha256=${sha}`)[0] || null;
export async function remember(sha, stats) {
  const v = verdictOf(stats);
  await sql`insert into scanned_files (sha256, verdict, malicious, suspicious) values (${sha}, ${v.status}, ${v.malicious}, ${v.suspicious}) on conflict (sha256) do nothing`;
  return v;
}
/** Ask VirusTotal about a hash it may already know. Returns stats, or null if it has never seen the file. */
export async function lookupHash(sha) {
  const r = await vt('/files/' + sha);
  if (r.status === 404) return null;
  if (r.status === 429) throw fail('rate limited');
  if (!r.ok) throw fail('VirusTotal ' + r.status);
  const s = (await r.json()).data?.attributes?.last_analysis_stats;
  return s && total(s) > 0 ? s : null;
}
/** Upload a file; returns the analysis id to poll later. */
export async function uploadFile(buf) {
  const form = new FormData(); form.append('file', new Blob([buf]), 'upload');
  const r = await vt('/files', { method: 'POST', body: form });
  if (r.status === 429) throw fail('rate limited');
  const id = r.ok && (await r.json()).data?.id; if (!id) throw fail('VirusTotal upload failed');
  return id;
}
/** Poll an analysis: stats when finished, otherwise null. */
export async function pollAnalysis(id) {
  const r = await vt('/analyses/' + id);
  if (r.status === 429) throw fail('rate limited');
  if (!r.ok) throw fail('VirusTotal ' + r.status);
  const a = (await r.json()).data?.attributes;
  return a?.status === 'completed' ? a.stats : null;
}
