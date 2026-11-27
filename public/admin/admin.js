import { H, gbp, $, $$, api, toast, stars, sheet } from '/ui.js';

const app = $('#app');
const shell = (inner) => { app.innerHTML = H`<div class="nav"><a class="nb" href="/escalations/" style="margin-left:auto">Escalations</a><b>Admin</b></div><div class="wrap wide">${inner}</div>`.raw; };
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

async function load() {
  let o, cafes, reviews, complaints, disputes, lics;
  try { [o, cafes, reviews, complaints, disputes, lics] = await Promise.all([api('/admin/overview'), api('/admin/cafes'), api('/admin/reviews'), api('/admin/complaints'), api('/admin/disputes'), api('/admin/licences')]); } catch (e) {
    return shell(H`<div class="empty">${e.status === 401 ? H`Sign in first at <a href="/m/" style="text-decoration:underline">/m/</a> with an admin email, then come back.` : e.status === 403 ? 'This account isn’t an admin. Add its email to the ADMIN_EMAILS environment variable.' : e.message}</div>`);
  }
  const kpi = (l, v, n) => H`<div class="kpi"><small>${l}</small><b>${v}</b>${n ? H`<small>${n}</small>` : ''}</div>`;
  const max = Math.max(1, ...o.daily.map((d) => d.gmv));
  shell(H`<div class="kpis">${kpi('Orders (30 days)', o.d30.orders, o.all.orders + ' all time')}${kpi('Sales (30 days)', gbp(o.d30.gmv), gbp(o.all.gmv) + ' all time')}${kpi('Platform fees (30 days)', gbp(o.d30.fees), gbp(o.all.fees) + ' all time')}
      ${kpi('Cafés', o.cafes.cafes, o.cafes.live + ' live on Mollie')}${kpi('On reduced fee', o.cafes.reduced)}</div>
    <h3>Alcohol Entitlement requests${lics.length ? ' (' + lics.length + ' waiting)' : ''}</h3>${lics.length ? H`<div class="group">${lics.map((c) => H`<div class="row" style="align-items:flex-start;flex-wrap:wrap"><div class="grow" style="min-width:220px"><div class="t">${c.name}</div>
      <div class="d">${c.email} · submitted ${day(c.submitted)}</div><div class="d">${c.licence.type} · no. ${c.licence.number} · ${c.licence.issuer}</div>
      <div class="d">Holder: ${c.licence.holder}${c.licence.dps ? ' · supervisor ' + c.licence.dps : ''}${c.licence.expires ? ' · expires ' + day(c.licence.expires) : ''}</div><div class="d">Premises: ${c.licence.premises}</div><div class="d">Café account: ${c.address || ''} ${c.postcode}</div>
      <button data-file="/api/admin/cafes/${c.id}/licence" data-name="${c.name}" style="text-decoration:underline;font-weight:700">View licence file</button></div>
      <div style="display:flex;gap:10px"><button class="btn" style="width:auto;padding:10px 18px" data-lic="${c.id}" data-ok="1" data-name="${c.name}">Grant</button><button class="btn red" style="width:auto;padding:10px 18px" data-lic="${c.id}" data-name="${c.name}">Refuse</button></div></div>`)}</div>` : H`<div class="empty">No requests waiting</div>`}
    <h3>Sales per day</h3><div class="card"><svg viewBox="0 0 600 120" width="100%" role="img" aria-label="Sales per day" style="display:block"><line x1="0" y1="119" x2="600" y2="119" stroke="#14161B" stroke-width="2"/>
      ${o.daily.map((d, i) => H`<rect x="${(i * 600 / o.daily.length).toFixed(1)}" y="${(118 - d.gmv / max * 116).toFixed(1)}" width="${Math.max(600 / o.daily.length - 3, 1).toFixed(1)}" height="${(d.gmv / max * 116).toFixed(1)}" fill="var(--accent)"/>`)}</svg></div>
    <h3>Cafés (last 30 days)</h3><div class="group">${cafes.map((c) => H`<div class="row" style="align-items:flex-start;flex-wrap:wrap"><div class="grow" style="min-width:200px"><div class="t">${c.name} <span class="badge ${c.live ? 'ok' : 'warn'}">${c.live ? 'Live' : 'Not connected'}</span>${c.banned ? H` <span class="badge warn">Banned</span>` : ''}</div>
        <div class="d">${c.email} · ${c.branches} branch${c.branches === 1 ? '' : 'es'} · joined ${day(c.created_at)} · code ${c.referral_code}${c.referred_by ? ' · referred by #' + c.referred_by : ''}</div>
        <div class="d">${c.orders} orders · ${gbp(c.gmv)} sales · ${gbp(c.fees)} fees${c.reviews ? H` · ${stars(c.avg)} ${c.avg.toFixed(1)} (${c.reviews})` : ''}${c.reduced_until && new Date(c.reduced_until) > new Date() ? ' · reduced fee until ' + day(c.reduced_until) : ''}</div></div>
        <div style="display:flex;gap:4px 16px;flex-wrap:wrap"><button data-grant="${c.id}" style="text-decoration:underline;font-weight:700">+30 days reduced fee</button><button data-fee="${c.id}" data-cur="${c.fee_pct ?? ''}" style="text-decoration:underline;font-weight:700">${c.fee_pct != null ? 'Fee: ' + c.fee_pct + '% (change)' : 'Set custom fee'}</button><button data-clear="${c.id}" style="text-decoration:underline">Clear</button><button data-menu="${c.id}" style="text-decoration:underline;font-weight:700">View menu</button><button data-ban="${c.id}" data-on="${c.banned ? 1 : 0}" data-name="${c.name}" style="text-decoration:underline;font-weight:700;color:var(--red,#C42F17)">${c.banned ? 'Unban' : 'Ban'}</button></div></div>`)}</div>
    <h3>Customer complaints${complaints.filter((c) => c.status === 'new').length ? ' (' + complaints.filter((c) => c.status === 'new').length + ' new)' : ''}</h3>${complaints.length ? H`<div class="group">${complaints.map((c) => H`<div class="row" style="align-items:flex-start;${c.status === 'new' ? '' : 'opacity:.6'}"><div class="grow"><div class="t">${c.cafe_name} · ${c.customer_name}</div>
      <div class="d">${c.customer_email} · ${day(c.created_at)} · ${c.status}</div><div style="margin-top:6px;white-space:pre-wrap">${c.summary}</div>
      <details style="margin-top:6px"><summary class="d">Chat transcript</summary>${(c.transcript || []).map((m) => H`<div class="d"><b>${m.role === 'user' ? 'Customer' : 'Assistant'}:</b> ${m.content}</div>`)}</details></div>
      <div style="display:grid;gap:8px">${c.order_id ? H`<button data-refund="${c.id}" style="text-decoration:underline;font-weight:700">Refund…</button>` : ''}${c.status === 'new' ? H`<button data-resolve="${c.id}" style="text-decoration:underline;font-weight:700">Mark resolved</button>` : ''}</div></div>`)}</div>` : H`<div class="empty">No complaints</div>`}
    <h3>Refund disputes (read-only)</h3>${disputes.length ? H`<div class="group">${disputes.map((d) => H`<div class="row"><div class="grow"><div class="t">${d.cafe || 'Closed café'} · order #${d.num} · ${gbp(d.total)}</div><div class="d">${d.status} · opened ${day(d.created_at)} · due ${day(d.due_at)}</div><div class="d">${d.reason}</div></div></div>`)}</div>` : H`<div class="empty">No disputes</div>`}
    <h3>Latest reviews</h3>${reviews.length ? H`<div class="group">${reviews.map((r) => H`<div class="row" style="align-items:flex-start"><div class="grow"><div class="t">${r.stars}/5 ${stars(r.stars)} · ${r.name}</div>${r.comment ? H`<div class="d">${r.comment}</div>` : ''}<div class="d">${day(r.created_at)}</div></div>
      <button data-del="${r.order_id}" style="text-decoration:underline;font-weight:700">Delete</button></div>`)}</div>` : H`<div class="empty">No reviews yet</div>`}`);
  $$('[data-lic]').forEach((b) => {
    b.onclick = () => {
      const ok = b.dataset.ok === '1', why = ok ? '' : prompt(`Why are you refusing ${b.dataset.name} the Alcohol Entitlement? This is emailed to them.`);
      if (!ok && !why?.trim()) return;
      if (ok && !confirm(`Grant ${b.dataset.name} the Alcohol Entitlement? Check the licence file first.`)) return;
      b.disabled = true; api(`/admin/cafes/${b.dataset.lic}/licence`, { approve: ok, reason: why }).then(() => { toast(ok ? 'Granted, café emailed' : 'Refused, café emailed'); load(); }).catch((e) => { toast(e.message); b.disabled = false; });
    };
  });
  $$('[data-file]').forEach((b) => { b.onclick = () => sheet(H`<h2>${b.dataset.name}: licence file</h2><iframe src="${b.dataset.file}" title="Licence file" style="width:100%;height:70vh;border:1px solid var(--rule);background:#fff"></iframe>`); }); // files open in a popover, never a new tab
  const act = (p) => p.then(load).catch((e) => toast(e.message));
  $$('[data-grant]').forEach((b) => { b.onclick = () => act(api(`/admin/cafes/${b.dataset.grant}/reduced`, { days: 30 })); });
  $$('[data-menu]').forEach((b) => { b.onclick = () => api(`/admin/cafes/${b.dataset.menu}/menu`).then((mn) => sheet(H`<h2>${mn.name}: menu</h2>${mn.categories.length ? mn.categories.map((c) => H`<h3>${c.name}</h3><div class="group">${mn.items.filter((i) => i.category_id === c.id).map((i) => H`<div class="row" style="align-items:flex-start"><div class="grow"><div class="t">${i.name}${i.available ? '' : ' (sold out)'}${i.alcohol ? ' (restricted)' : ''}</div>${i.description ? H`<div class="d">${i.description}</div>` : ''}${(i.options || []).map((g) => H`<div class="d">${g.name}: ${g.choices.map((o) => o.name + (o.price ? ' +' + gbp(o.price) : '')).join(', ')}</div>`)}</div><b>${gbp(i.price_pence)}</b></div>`)}</div>`) : H`<div class="empty">No menu yet</div>`}`), (e) => toast(e.message)); });
  $$('[data-clear]').forEach((b) => { b.onclick = () => act(api(`/admin/cafes/${b.dataset.clear}/reduced`, { days: 0 })); });
  $$('[data-ban]').forEach((b) => { b.onclick = () => { const on = b.dataset.on === '1'; if (confirm(on ? `Restore ${b.dataset.name}?` : `Ban ${b.dataset.name}? They’ll be signed out, can’t sign in, and their café is hidden from customers.`)) act(api(`/admin/cafes/${b.dataset.ban}/ban`, { banned: !on })); }; });
  $$('[data-resolve]').forEach((b) => { b.onclick = () => act(api('/admin/complaints/' + b.dataset.resolve + '/resolve', {})); });
  $$('[data-fee]').forEach((b) => {
    b.onclick = () => {
      const v = prompt('Custom platform fee for this café, in % (0 to 50). Leave empty to go back to the standard rate (5%, or 2.5% with a referral reward).', b.dataset.cur);
      if (v === null) return;
      act(api(`/admin/cafes/${b.dataset.fee}/fee`, { pct: v.trim() === '' ? null : parseFloat(v) }));
    };
  });
  $$('[data-refund]').forEach((b) => {
    b.onclick = async () => {
      let o; try { o = await api(`/admin/complaints/${b.dataset.refund}/order`); } catch (e) { return toast(e.message); }
      const done = o.refunded_items || {}, left = o.items.map((l, i) => l.qty - (done[i] || 0));
      const sh = sheet(H`<h2>Refund order #${o.num}</h2><p class="sub">Paid from the café’s Mollie balance, and the café is emailed. Choose items for a partial refund, or refund everything left. The platform fee isn’t returned.${o.test ? ' (Test order: no money moves.)' : ''}</p>
        <div class="group">${o.items.map((l, i) => left[i] > 0 ? H`<label class="row"><span class="grow">${l.name}<div class="sub">${gbp(l.unit)} each</div></span><select data-rq="${i}">${Array.from({ length: left[i] + 1 }, (_, k) => H`<option value="${k}">${k} of ${left[i]}</option>`)}</select></label>` : H`<div class="row"><span class="grow sub">${l.name}, already refunded</span></div>`)}</div>
        <textarea class="field" id="rnote" rows="2" maxlength="400" placeholder="Note to the café (optional)"></textarea>
        <button class="btn red" id="rpart" style="margin-top:12px">Refund selected items</button><button class="btn sec" id="rall" style="margin-top:8px">Refund everything left</button>`);
      const go = async (items) => {
        if (items && !items.length) return toast('Choose at least one item');
        $$('button', sh.el).forEach((x) => (x.disabled = true));
        try { const r = await api(`/admin/complaints/${b.dataset.refund}/refund`, { items, note: $('#rnote', sh.el).value }); toast('Refunded ' + gbp(r.amount) + ', café emailed'); sh.close(); load(); }
        catch (e) { toast(e.message); $$('button', sh.el).forEach((x) => (x.disabled = false)); }
      };
      $('#rpart', sh.el).onclick = () => go($$('[data-rq]', sh.el).map((s) => ({ i: +s.dataset.rq, qty: +s.value })).filter((x) => x.qty > 0));
      $('#rall', sh.el).onclick = () => { if (confirm('Refund everything that’s left on this order?')) go(null); };
    };
  });
  $$('[data-del]').forEach((b) => { b.onclick = () => { if (confirm('Delete this review?')) act(api('/admin/reviews/' + b.dataset.del, null, 'DELETE')); }; });
}
load();
