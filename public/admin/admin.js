import { H, gbp, $, $$, api, toast, stars } from '/ui.js';

const app = $('#app');
const shell = (inner) => { app.innerHTML = H`<div class="nav"><a class="nb" href="/escalations/" style="margin-left:auto">Escalations</a><b>Admin</b></div><div class="wrap wide">${inner}</div>`.raw; };
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

async function load() {
  let o, cafes, reviews, complaints, disputes;
  try { [o, cafes, reviews, complaints, disputes] = await Promise.all([api('/admin/overview'), api('/admin/cafes'), api('/admin/reviews'), api('/admin/complaints'), api('/admin/disputes')]); } catch (e) {
    return shell(H`<div class="empty">${e.status === 401 ? H`Sign in first at <a href="/m/" style="text-decoration:underline">/m/</a> with an admin email, then come back.` : e.status === 403 ? 'This account isn’t an admin. Add its email to the ADMIN_EMAILS environment variable.' : e.message}</div>`);
  }
  const kpi = (l, v, n) => H`<div class="kpi"><small>${l}</small><b>${v}</b>${n ? H`<small>${n}</small>` : ''}</div>`;
  const max = Math.max(1, ...o.daily.map((d) => d.gmv));
  shell(H`<div class="kpis">${kpi('Orders (30 days)', o.d30.orders, o.all.orders + ' all time')}${kpi('Sales (30 days)', gbp(o.d30.gmv), gbp(o.all.gmv) + ' all time')}${kpi('Platform fees (30 days)', gbp(o.d30.fees), gbp(o.all.fees) + ' all time')}
      ${kpi('Cafés', o.cafes.cafes, o.cafes.live + ' live on Mollie')}${kpi('On reduced fee', o.cafes.reduced)}</div>
    <h3>Sales per day</h3><div class="card"><svg viewBox="0 0 600 120" width="100%" role="img" aria-label="Sales per day" style="display:block"><line x1="0" y1="119" x2="600" y2="119" stroke="#14161B" stroke-width="2"/>
      ${o.daily.map((d, i) => H`<rect x="${(i * 600 / o.daily.length).toFixed(1)}" y="${(118 - d.gmv / max * 116).toFixed(1)}" width="${Math.max(600 / o.daily.length - 3, 1).toFixed(1)}" height="${(d.gmv / max * 116).toFixed(1)}" fill="var(--accent)"/>`)}</svg></div>
    <h3>Cafés (last 30 days)</h3><div class="group">${cafes.map((c) => H`<div class="row" style="align-items:flex-start;flex-wrap:wrap"><div class="grow" style="min-width:200px"><div class="t">${c.name} <span class="badge ${c.live ? 'ok' : 'warn'}">${c.live ? 'Live' : 'Not connected'}</span></div>
        <div class="d">${c.email} · ${c.branches} branch${c.branches === 1 ? '' : 'es'} · joined ${day(c.created_at)} · code ${c.referral_code}${c.referred_by ? ' · referred by #' + c.referred_by : ''}</div>
        <div class="d">${c.orders} orders · ${gbp(c.gmv)} sales · ${gbp(c.fees)} fees${c.reviews ? H` · ${stars(c.avg)} ${c.avg.toFixed(1)} (${c.reviews})` : ''}${c.reduced_until && new Date(c.reduced_until) > new Date() ? ' · reduced fee until ' + day(c.reduced_until) : ''}</div></div>
        <div style="display:flex;gap:12px"><button data-grant="${c.id}" style="text-decoration:underline;font-weight:700">+30 days reduced fee</button><button data-fee="${c.id}" data-cur="${c.fee_pct ?? ''}" style="text-decoration:underline;font-weight:700">${c.fee_pct != null ? 'Fee: ' + c.fee_pct + '% (change)' : 'Set custom fee'}</button><button data-clear="${c.id}" style="text-decoration:underline">Clear</button></div></div>`)}</div>
    <h3>Customer complaints${complaints.filter((c) => c.status === 'new').length ? ' (' + complaints.filter((c) => c.status === 'new').length + ' new)' : ''}</h3>${complaints.length ? H`<div class="group">${complaints.map((c) => H`<div class="row" style="align-items:flex-start;${c.status === 'new' ? '' : 'opacity:.6'}"><div class="grow"><div class="t">${c.cafe_name} · ${c.customer_name}</div>
      <div class="d">${c.customer_email} · ${day(c.created_at)} · ${c.status}</div><div style="margin-top:6px;white-space:pre-wrap">${c.summary}</div>
      <details style="margin-top:6px"><summary class="d">Chat transcript</summary>${(c.transcript || []).map((m) => H`<div class="d"><b>${m.role === 'user' ? 'Customer' : 'Assistant'}:</b> ${m.content}</div>`)}</details></div>
      ${c.status === 'new' ? H`<button data-resolve="${c.id}" style="text-decoration:underline;font-weight:700">Mark resolved</button>` : ''}</div>`)}</div>` : H`<div class="empty">No complaints</div>`}
    <h3>Refund disputes (read-only)</h3>${disputes.length ? H`<div class="group">${disputes.map((d) => H`<div class="row"><div class="grow"><div class="t">${d.cafe || 'Closed café'} · order #${d.num} · ${gbp(d.total)}</div><div class="d">${d.status} · opened ${day(d.created_at)} · due ${day(d.due_at)}</div><div class="d">${d.reason}</div></div></div>`)}</div>` : H`<div class="empty">No disputes</div>`}
    <h3>Latest reviews</h3>${reviews.length ? H`<div class="group">${reviews.map((r) => H`<div class="row" style="align-items:flex-start"><div class="grow"><div class="t">${r.stars}/5 ${stars(r.stars)} · ${r.name}</div>${r.comment ? H`<div class="d">${r.comment}</div>` : ''}<div class="d">${day(r.created_at)}</div></div>
      <button data-del="${r.order_id}" style="text-decoration:underline;font-weight:700">Delete</button></div>`)}</div>` : H`<div class="empty">No reviews yet</div>`}`);
  const act = (p) => p.then(load).catch((e) => toast(e.message));
  $$('[data-grant]').forEach((b) => { b.onclick = () => act(api(`/admin/cafes/${b.dataset.grant}/reduced`, { days: 30 })); });
  $$('[data-clear]').forEach((b) => { b.onclick = () => act(api(`/admin/cafes/${b.dataset.clear}/reduced`, { days: 0 })); });
  $$('[data-resolve]').forEach((b) => { b.onclick = () => act(api('/admin/complaints/' + b.dataset.resolve + '/resolve', {})); });
  $$('[data-fee]').forEach((b) => {
    b.onclick = () => {
      const v = prompt('Custom platform fee for this café, in % (0–50). Leave empty to go back to the standard rate (5%, or 2.5% with a referral reward).', b.dataset.cur);
      if (v === null) return;
      act(api(`/admin/cafes/${b.dataset.fee}/fee`, { pct: v.trim() === '' ? null : parseFloat(v) }));
    };
  });
  $$('[data-del]').forEach((b) => { b.onclick = () => { if (confirm('Delete this review?')) act(api('/admin/reviews/' + b.dataset.del, null, 'DELETE')); }; });
}
load();
