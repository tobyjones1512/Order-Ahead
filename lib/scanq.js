// The upload scan queue. Every file a café or customer uploads (logo, dispute photo, emailed attachment) is queued here and sent to VirusTotal,
// at most PER_MINUTE (3) files a minute across the whole platform. A file is only used once it comes back clean:
//   logo      -> merchants.logo_pending becomes merchants.logo
//   dispute   -> dispute_imgs.status becomes 'clean' (until then the photo is not served)
//   email     -> the verdict is written onto the support message (files are never stored; only the verdict is kept)
// The queue is worked by processQueue(), called whenever the kitchen / order pages poll (housekeeping), by the cron endpoint, and right after a file is queued.
// Without VIRUSTOTAL_API_KEY nothing is queued: files are accepted unscanned and a warning is logged.
import { sql } from './db.js';
import { sha256, vtKey, known, remember, lookupHash, uploadFile, pollAnalysis } from './vt.js';

export const PER_MINUTE = 3;
const GIVE_UP = "30 minutes";

/** Queue a file. Returns { status: 'clean' | 'flagged' | 'unscanned' | 'queued' } straight away: clean/flagged when VirusTotal's answer for this exact file is already remembered. */
export async function submit({ kind, ref, buf, mime = '' }) {
  if (!vtKey()) { console.warn('VIRUSTOTAL_API_KEY is not set: file not scanned'); return { status: 'unscanned' }; }
  const sha = sha256(buf), seen = await known(sha);
  if (seen) return seen;
  if (kind === 'logo') await sql`delete from scan_queue where kind='logo' and ref=${String(ref)} and status in ('queued','checking')`; // a newer logo replaces an older one still waiting
  await sql`insert into scan_queue (kind, ref, sha256, mime, data) values (${kind}, ${String(ref)}, ${sha}, ${mime}, ${buf.toString('base64')})`;
  return { status: 'queued', sha256: sha };
}

/** Apply a finished verdict to whatever was waiting for it. */
export async function apply(kind, ref, mime, b64, v) {
  const ok = v.status === 'clean';
  if (kind === 'logo') {
    const url = `data:${mime};base64,${b64}`;
    if (ok) await sql`update merchants set logo=${url}, logo_pending=null where id=${+ref} and logo_pending=${url}`;
    else await sql`update merchants set logo_pending=null where id=${+ref} and logo_pending=${url}`;
  } else if (kind === 'dispute') {
    if (ok) await sql`update dispute_imgs set status='clean' where id=${+ref}`;
    else await sql`delete from dispute_imgs where id=${+ref}`;
  } else if (kind === 'email') {
    const [key, idx] = String(ref).split(':'), i = +idx;
    const m = (await sql`select id, thread_id, files from support_msgs where key=${key}`)[0]; if (!m) return;
    const files = m.files.map((f, n) => (n === i ? { ...f, status: v.status, malicious: v.malicious, suspicious: v.suspicious } : f));
    await sql`update support_msgs set files=${JSON.stringify(files)}::jsonb where id=${m.id}`;
    if (v.status === 'flagged') await (await import('./desk.js')).fileFlagged(m.thread_id, files[i]);
  }
}

async function finish(row, stats) {
  const v = await remember(row.sha256, stats);
  await sql`update scan_queue set status=${v.status}, data=null, done_at=now() where id=${row.id}`;
  await apply(row.kind, row.ref, row.mime, row.data, v);
}
async function giveUp(row) {
  await sql`update scan_queue set status='error', data=null, done_at=now() where id=${row.id}`;
  await apply(row.kind, row.ref, row.mime, row.data, { status: 'error' });
}

/** Work the queue: start up to 3 files a minute, and check files already sent. Safe to call from many places at once. */
export async function processQueue() {
  if (!vtKey()) return;
  const started = (await sql`select count(*)::int n from scan_queue where started_at > now() - interval '1 minute'`)[0].n, budget = PER_MINUTE - started;
  if (budget > 0) {
    const claimed = await sql`update scan_queue set status='checking', started_at=now() where id in (select id from scan_queue where status='queued' order by id limit ${budget} for update skip locked) returning *`;
    for (const row of claimed) {
      try {
        const stats = await lookupHash(row.sha256);
        if (stats) await finish(row, stats);
        else await sql`update scan_queue set analysis_id=${await uploadFile(Buffer.from(row.data, 'base64'))}, polled_at=now() where id=${row.id}`;
      } catch (e) {
        console.error('scan start', e.message);
        await sql`update scan_queue set status='queued', started_at=null where id=${row.id}`; // try again later
        break;
      }
    }
  }
  const waiting = await sql`update scan_queue set polled_at=now() where id in (select id from scan_queue where status='checking' and analysis_id is not null and (polled_at is null or polled_at < now() - interval '20 seconds') order by id limit 3 for update skip locked) returning *`;
  for (const row of waiting) {
    try {
      const stats = await pollAnalysis(row.analysis_id);
      if (stats) await finish(row, stats);
    } catch (e) { console.error('scan poll', e.message); }
  }
  const stale = await sql`select * from scan_queue where status in ('queued','checking') and created_at < now() - interval '30 minutes'`;
  for (const row of stale) await giveUp(row);
  await sql`delete from scan_queue where done_at < now() - interval '7 days'`;
}
