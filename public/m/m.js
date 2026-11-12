import { H, gbp, $, $$, api, toast, sheet, registerSW, toPhoto, setAccent, onColor, contrast, accentFor, loadScript, ls, stars } from '/ui.js';
import { ALLERGENS, DIETARY, cleanAllergens, allergenText } from '/allergens.js';

registerSW();
let urls = { appUrl: location.origin, adminUrl: '/admin' }; // real addresses of the customer app and admin site (from the server)
fetch('/api/config').then((r) => r.json()).then((c) => { urls = { ...urls, ...c }; }).catch(() => {});
const app = $('#app'), tabs = $('#tabs');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let dLast = 0, printIds = new Set(), me, menu, orders = [], seen = new Set(), lastChime = 0, ac, poller;
const brs = () => me?.branches || [], br0 = () => brs()[0] || { open_time: '07:00', close_time: '17:00' };
let kb = ls.get('kbranch', 0); // kitchen's selected branch (0 = all)
const kbCur = () => brs().find((b) => b.id === kb);
const visible = () => (kbCur() ? orders.filter((o) => o.branch_id === kb) : orders);
const putBranch = async (id, patch) => { me = await api('/m/branches/' + id, patch, 'PUT'); };
const tab = () => location.hash.slice(1) || 'orders';
const BACK = { poster: '#settings', offers: '#settings', reviews: '#settings' }; // sub-pages get a back button inside the header
const shell = (title, inner) => { const bk = BACK[tab()]; app.innerHTML = H`<div class="nav">${bk ? H`<a class="nb" href="${bk}"><span class="bk"></span>Settings</a>` : ''}<b>${title}</b><span style="width:60px"></span></div><div class="wrap wide">${inner}</div>`.raw; };
const put = async (patch) => { me = await api('/m/me', patch, 'PUT'); setAccent(me.color); };

// ---------- loud chime (Web Audio) ----------
function unlock() { // browsers only allow audio after a tap
  ac ??= new AudioContext(); ac.resume();
  navigator.wakeLock?.request('screen').catch(() => {}); // keep the kitchen tablet awake
}
function chime() {
  if (ac?.state !== 'running') return;
  const t = ac.currentTime;
  [880, 1175, 1480, 1175, 1480, 1760].forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain(), s = t + i * 0.18;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(1, s + 0.01); g.gain.exponentialRampToValueAtTime(0.001, s + 0.55);
    o.connect(g).connect(ac.destination); o.start(s); o.stop(s + 0.6);
  });
}

// ---------- boot / auth ----------
async function boot() {
  try { me = await api('/m/me'); } catch { return authView(!!refParam); }
  setAccent(me.color); tabs.hidden = false; clearInterval(poller); poller = setInterval(poll, 5000);
  await poll(); render();
}
addEventListener('hashchange', () => me && render());

const refParam = new URLSearchParams(location.search).get('ref') || '';
function authView(signup = false, sent = false) {
  tabs.hidden = true; clearInterval(poller);
  if (sent) return shell('Docket', H`<div class="empty"><h2>Check your email</h2>We've sent you a sign-in link. It's valid for 15 minutes.<br><br><button style="color:var(--text);text-decoration:underline" id="back">Use a different email</button></div>`), ($('#back').onclick = () => authView(signup));
  shell('Docket', H`<h1 class="large">${signup ? 'Register your café' : 'Kitchen sign in'}</h1>
    ${location.search.includes('expired') ? H`<div class="err">That link has expired – request a new one.</div>` : ''}
    <div class="group">${signup ? H`<input class="field" id="name" placeholder="Café name"><input class="field" id="pc" placeholder="Postcode" autocapitalize="characters"><input class="field" id="rf" placeholder="Referral code (optional)" autocapitalize="characters" value="${refParam}">` : ''}
    <input class="field" id="em" type="email" placeholder="Email" autocomplete="email"></div>
    ${signup ? H`<p class="sub" style="text-align:center">You’ll agree to the <a href="/terms/" target="_blank" rel="noopener" style="text-decoration:underline">Merchant Terms</a> before launching your store.</p>` : ''}
    <button class="btn" id="go">Email me a sign-in link</button>
    <p style="text-align:center"><button style="color:var(--text);text-decoration:underline" id="sw">${signup ? 'I already have an account' : 'Register a new café'}</button></p>`);
  $('#sw').onclick = () => authView(!signup);
  $('#go').onclick = async () => {
    try { await api('/m/login', { email: $('#em').value, name: $('#name')?.value, postcode: $('#pc')?.value, ref: $('#rf')?.value }); authView(signup, true); } catch (e) { toast(e.message); }
  };
}

function render() {
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.t === tab()));
  ({ orders: ordersView, sales: salesView, menu: menuView, settings: settingsView, disputes: disputesView, poster: posterView, offers: offersView, reviews: reviewsView }[tab()] || ordersView)();
}

// ---------- orders / kitchen ----------
const due = (o) => !o.alert_at || o.alerted; // scheduled orders stay quiet until pickup time minus prep time
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
async function badge() { // open disputes count on the tab (checked every 30s)
  if (Date.now() - dLast < 30000) return; dLast = Date.now();
  try { const n = (await api('/m/disputes')).filter((d) => d.status === 'open').length, el = $('#dbadge'); if (el) { el.hidden = !n; el.textContent = n; } } catch { /* optional */ }
}
async function poll() {
  try { orders = await api('/m/orders'); } catch (e) { if (e.status === 401) { me = null; authView(); } return; }
  badge();
  const pend = visible().filter((o) => o.status === 'pending' && due(o));
  printIds = new Set(pend.filter((o) => !seen.has(o.id)).map((o) => o.id)); const fresh = printIds.size > 0; pend.forEach((o) => seen.add(o.id));
  // chime on every new order, then nag every 12s until someone accepts it
  if (pend.length && (fresh || Date.now() - lastChime > 12000)) { chime(); lastChime = Date.now(); }
  if (tab() === 'orders' && $('#orders')) drawOrders();
}

const CL_LINK = { address: '#settings', logo: '#settings', terms: '#settings', mollie: '#settings', menu: '#menu', push: '#settings', order: '#poster' };
function checklist() {
  const c = me.checklist || [], left = c.filter((x) => !x.done); if (!left.length) return '';
  return H`<div class="group" style="margin-top:12px"><div class="row"><b class="grow">Get set up</b><span class="sub">${c.length - left.length} of ${c.length} done</span></div>
    ${c.map((x) => H`<a class="row" href="${CL_LINK[x.k] || '#settings'}" style="text-decoration:none;${x.done ? 'opacity:.55' : ''}"><span style="width:22px">${x.done ? '✓' : '○'}</span><span class="grow" style="${x.done ? 'text-decoration:line-through' : ''}">${x.label}</span></a>`)}</div>`;
}
function ordersView() {
  const many = brs().length > 1, cur = kbCur() || (many ? null : brs()[0]);
  shell('Kitchen', H`${checklist()}${many ? H`<div class="chips" id="kbs" style="margin-top:12px"><button class="chip ${kbCur() ? '' : 'on'}" data-b="0">All branches</button>${brs().map((b) => H`<button class="chip ${kb === b.id ? 'on' : ''}" data-b="${b.id}">${b.name}</button>`)}</div>` : ''}
    ${cur ? H`<div class="group" style="margin-top:12px">
    <label class="row"><span class="grow">Pause new orders${many ? ' · ' + cur.name : ''}</span><input type="checkbox" class="sw" id="pause" ${cur.paused ? H`checked` : ''}></label>
    <label class="row"><span class="grow">Rush: +10 min prep time<div class="sub">Customers' “ASAP” estimates are pushed back</div></span><input type="checkbox" class="sw" id="rush" ${cur.extra_minutes ? H`checked` : ''}></label></div>`
      : H`<div class="banner" style="margin-top:12px">Pick a branch to pause its orders or add prep time.</div>`}
    ${me.test_mode ? H`<div class="banner" style="margin-top:12px"><b>Test mode is on.</b> Orders you place from your own store aren’t charged, and customers can’t see it. <a href="${urls.appUrl}/#/c/${me.id}" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:700">Open your store</a></div>` : ''}
    <div id="snd"></div><div id="orders"></div>`);
  $('#kbs')?.addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b) { kb = +b.dataset.b; ls.set('kbranch', kb); ordersView(); } });
  if (cur) {
    $('#pause').onchange = (e) => putBranch(cur.id, { paused: e.target.checked }).catch((x) => toast(x.message));
    $('#rush').onchange = (e) => putBranch(cur.id, { extra_minutes: e.target.checked ? 10 : 0 }).catch((x) => toast(x.message));
  }
  drawOrders();
}
function drawOrders() {
  $('#snd').innerHTML = ac?.state === 'running' ? '' : H`<button class="btn sec" id="sound" style="margin-bottom:12px">Tap to enable order sounds</button>`.raw;
  if ($('#sound')) $('#sound').onclick = () => { unlock(); setTimeout(() => { chime(); drawOrders(); }, 100); };
  const sections = [['pending', 'New'], ['scheduled', 'Scheduled (alerts closer to pickup)'], ['accepted', 'Preparing'], ['ready', 'Ready for pickup'], ['completed', 'Completed']];
  const label = { pending: 'Accept', accepted: 'Ready for pickup', ready: 'Complete' };
  const next = { pending: 'accepted', accepted: 'ready', ready: 'completed' };
  const vis = visible(), showB = brs().length > 1 && !kbCur(), bname = (id) => brs().find((b) => b.id === id)?.name || '';
  $('#orders').innerHTML = H`${vis.length ? '' : H`<div class="empty">No orders yet</div>`}
    ${sections.map(([st, title]) => { const list = vis.filter((o) => (st === 'scheduled' ? o.status === 'pending' && !due(o) : st === 'pending' ? o.status === 'pending' && due(o) : o.status === st)); const sk = st; st = st === 'scheduled' ? 'pending' : st; return list.length ? H`<h3>${title} (${list.length})</h3>
      <div class="rail">${list.map((o) => H`<div class="ord ${st} ${printIds.has(o.id) ? 'print' : ''}"><h4><span class="n">#${o.num}</span><span class="t">${o.asap ? 'ASAP ' : ''}${o.pickup_time}</span></h4>${o.test ? H`<div style="margin:0 0 6px"><span class="badge">TEST ORDER</span></div>` : ''}${sk === 'scheduled' ? H`<div class="sub" style="margin:0 0 6px">Pops up at ${hhmm(o.alert_at)}</div>` : ''}<div class="sub" style="margin:-4px 0 8px">${o.customer_name}${showB ? ' · ' + bname(o.branch_id) : ''}</div>
        ${o.service === 'sitin' ? H`<div style="margin:0 0 6px"><span class="badge">Eat in</span></div>` : ''}${(o.allergy || []).length ? H`<div class="alert">⚠ ALLERGY: ${allergenText(o.allergy)}</div>` : ''}
        <ul>${o.items.map((i) => H`<li><b>${i.qty} ×</b> ${i.name}${i.opts.length ? H` <small>${i.opts.join(', ')}</small>` : ''}</li>`)}</ul>
        <div class="sub" style="margin-bottom:${next[st] ? 10 : 0}px">${gbp(o.total)}${o.refunded ? ' · refunded ' + gbp(o.refunded) : ''}${o.tip ? ' · incl. ' + gbp(o.tip) + ' tip' : ''}${o.discount ? ' · ' + (o.offer_code ? 'code ' + o.offer_code : 'loyalty reward') + ' −' + gbp(o.discount) : ''}${brs().find((b) => b.id === o.branch_id)?.printer_on ? (o.printed_at ? H` · <button style="text-decoration:underline;font-weight:700" data-reprint="${o.id}">Reprint ticket</button>` : ' · waiting for printer') : ''}</div>
        ${next[st] ? H`<button class="btn" data-id="${o.id}" data-to="${next[st]}">${label[st]}</button><button class="btn red" style="margin-top:8px" data-id="${o.id}" data-refund="1">Refund…</button>` : ''}</div>`)}</div>` : ''; })}`.raw;
  $('#orders').onclick = async (e) => {
    const rp = e.target.closest('[data-reprint]');
    if (rp) { try { await api(`/m/orders/${rp.dataset.reprint}/reprint`, {}); toast('Sent to the printer'); await poll(); } catch (x) { toast(x.message); } return; }
    const r = e.target.closest('[data-refund]');
    if (r) return refundSheet(orders.find((o) => o.id === r.dataset.id));
    const b = e.target.closest('[data-to]'); if (!b) return; b.disabled = true;
    try { await api(`/m/orders/${b.dataset.id}/status`, { status: b.dataset.to }); await poll(); } catch (x) { toast(x.message); b.disabled = false; }
  };
}

function refundSheet(o) {
  if (!o) return;
  const done = o.refunded_items || {}, left = o.items.map((l, i) => l.qty - (done[i] || 0));
  const sh = sheet(H`<h2>Refund order #${o.num}</h2><p class="sub">Pick the items to refund, or refund everything that’s left. The platform fee isn’t returned, so it comes out of your Mollie balance${o.test ? '. (Test order: no money moves.)' : '.'}</p>
    <div class="group">${o.items.map((l, i) => left[i] > 0 ? H`<label class="row"><span class="grow">${l.name}${l.opts.length ? H`<div class="sub">${l.opts.join(', ')}</div>` : ''}<div class="sub">${gbp(l.unit)} each</div></span>
      <select data-rq="${i}">${Array.from({ length: left[i] + 1 }, (_, k) => H`<option value="${k}">${k} of ${left[i]}</option>`)}</select></label>` : H`<div class="row"><span class="grow sub">${l.name} – already refunded</span></div>`)}</div>
    <button class="btn red" id="rpart" style="margin-top:12px">Refund selected items</button>
    <button class="btn sec" id="rall" style="margin-top:8px">Refund everything left &amp; cancel</button>`);
  const go = async (items) => {
    if (items && !items.length) return toast('Choose at least one item');
    $$('button', sh.el).forEach((b) => (b.disabled = true));
    try { await api(`/m/orders/${o.id}/refund`, items ? { items } : {}); toast('Refunded'); sh.close(); await poll(); } catch (x) { toast(x.message); $$('button', sh.el).forEach((b) => (b.disabled = false)); }
  };
  $('#rpart', sh.el).onclick = () => go($$('[data-rq]', sh.el).map((s) => ({ i: +s.dataset.rq, qty: +s.value })).filter((x) => x.qty > 0));
  $('#rall', sh.el).onclick = () => { if (confirm('Refund everything that’s left on this order?')) go(null); };
}

// ---------- disputes ----------
const DSTAT = { open: 'Open', accepted: 'You refunded', refused: 'You refused', auto_refunded: 'Auto-refunded (no reply in 7 days)' };
async function disputesView() {
  shell('Disputes', H`<div class="spin"></div>`);
  let list; try { list = await api('/m/disputes'); } catch (e) { return shell('Disputes', H`<div class="empty">${e.message}</div>`); }
  if (tab() !== 'disputes') return;
  dLast = Date.now(); const n = list.filter((d) => d.status === 'open').length, el = $('#dbadge'); if (el) { el.hidden = !n; el.textContent = n; }
  const days = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 864e5));
  shell('Disputes', H`<p class="sub" style="margin:12px 0">Dispute Resolution Centre. Customers who ask for a refund appear here. Accept to refund them, or refuse with a reason. If you don’t reply within 7 days the refund is granted automatically. Any reply or evidence you add pauses that clock.</p>
    ${list.length ? list.map((d) => H`<div class="group" style="margin-bottom:14px"><div class="row" style="align-items:flex-start"><div class="grow"><div class="t">Order #${d.num} · ${d.customer_name}</div>
      <div class="d">${d.status === 'open' ? (d.responded_at ? 'Awaiting your decision' : 'Reply due in ' + days(d.due_at) + ' day' + (days(d.due_at) === 1 ? '' : 's') + ' or it’s refunded automatically') : DSTAT[d.status]}</div></div><b>${gbp(d.total)}</b></div>
      <div class="row" style="display:block"><div class="sub">${d.items ? 'Items: ' + d.items.map((x) => x.qty + ' × ' + (d.order_items[x.i]?.name || 'item')).join(', ') : 'Whole order'}</div>
        ${d.msgs.map((m) => H`<div class="msg ${m.who}"><small>${m.who === 'customer' ? 'Customer' : 'You'} · ${new Date(m.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>${m.body}${m.pending ? H`<div class="sub">${m.pending} photo${m.pending === 1 ? '' : 's'} being checked for viruses</div>` : ''}${(m.imgs || []).map((id) => H`<a href="/api/disputes/${d.id}/img/${id}" target="_blank" rel="noopener"><img src="/api/disputes/${d.id}/img/${id}" alt="Evidence photo" loading="lazy"></a>`)}</div>`)}</div>
      ${d.status === 'open' ? H`<div class="row" style="gap:8px"><button class="btn" data-dec="${d.id}" data-acc="1">Accept &amp; refund</button><button class="btn sec" data-dec="${d.id}">Refuse…</button><button class="btn sec" data-rep="${d.id}">Reply</button></div>` : ''}</div>`) : H`<div class="empty">No disputes. Nothing to do here.</div>`}`);
  $$('[data-dec],[data-rep]').forEach((b) => { b.onclick = () => disputeSheet(list.find((d) => d.id === (b.dataset.dec || b.dataset.rep)), b.dataset.rep ? 'reply' : b.dataset.acc ? 'accept' : 'refuse'); });
}
function disputeSheet(d, mode) {
  const title = { reply: 'Reply to customer', accept: 'Refund the customer', refuse: 'Refuse this refund' }[mode];
  const sh = sheet(H`<h2>${title}</h2><p class="sub">${mode === 'accept' ? 'The customer is refunded' + (d.items ? ' for the items they chose' : ' in full') + '. The platform fee isn’t returned. You can add a note.' : mode === 'refuse' ? 'Explain why, and add photos if they help. The customer will see this.' : 'Your reply and any evidence are shown to the customer. This pauses the 7-day auto-refund until you decide.'}</p>
    <textarea class="field" id="dtxt" rows="4" maxlength="1500" placeholder="${mode === 'accept' ? 'Optional note' : 'Your response'}"></textarea>
    <label class="btn sec" style="margin-top:8px;display:block;text-align:center">Add photos (up to 3)<input id="dimg" type="file" accept="image/*" multiple hidden></label><div class="sub" id="dfiles"></div>
    <button class="btn ${mode === 'refuse' ? 'red' : ''}" id="dgo" style="margin-top:10px">${{ reply: 'Send reply', accept: 'Refund now', refuse: 'Refuse refund' }[mode]}</button>`);
  let imgs = [];
  $('#dimg', sh.el).onchange = async (e) => { try { imgs = await Promise.all([...e.target.files].slice(0, 3).map(toPhoto)); $('#dfiles', sh.el).textContent = imgs.length + ' photo' + (imgs.length === 1 ? '' : 's') + ' attached'; } catch { toast('Couldn’t read that photo'); } };
  $('#dgo', sh.el).onclick = async (e) => {
    e.target.disabled = true; const text = $('#dtxt', sh.el).value;
    try { await api(`/m/disputes/${d.id}/${mode === 'reply' ? 'respond' : 'decide'}`, mode === 'reply' ? { text, images: imgs } : { accept: mode === 'accept', text, images: imgs }); sh.close(); toast(mode === 'reply' ? 'Reply sent' : mode === 'accept' ? 'Refunded' : 'Refused'); disputesView(); }
    catch (x) { toast(x.message); e.target.disabled = false; }
  };
}

// ---------- menu ----------
async function menuView() {
  shell('Menu', H`<div class="spin"></div>`);
  menu = await api('/m/menu'); drawMenu();
}
let mb = 0; // 0 = edit the shared menu; otherwise the branch whose availability is being set
const isOff = (kind, id) => menu.off.some((r) => r.branch_id === mb && r.kind === kind && r.ref_id === id);
function drawMenu() {
  if (mb && !brs().some((x) => x.id === mb)) mb = 0;
  const sw = (kind, id, on, label) => H`<input type="checkbox" class="sw" data-a="boff" data-kind="${kind}" data-id="${id}" ${on ? H`checked` : ''} aria-label="${label}">`;
  shell('Menu', H`${brs().length > 1 ? H`<div class="chips" id="mbs" style="margin-top:12px"><button class="chip ${mb ? '' : 'on'}" data-b="0">Edit menu</button>${brs().map((x) => H`<button class="chip ${mb === x.id ? 'on' : ''}" data-b="${x.id}">${x.name}</button>`)}</div>
      ${mb ? H`<div class="banner">Choose what <b>${brs().find((x) => x.id === mb).name}</b> sells. Switched-off items and categories are hidden from customers at this branch only.</div>` : ''}` : ''}
    <div style="padding-top:12px">${mb ? '' : H`<button class="btn sec" data-a="newcat">Add category</button>`}</div>
    ${menu.categories.map((c) => H`<h3 style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span>${c.name}${c.from_time || c.to_time ? ` · ${c.from_time || '00:00'}–${c.to_time || '24:00'}` : ''}${c.days.length < 7 ? ' · ' + c.days.map((d) => DAYS[d]).join(' ') : ''}</span>
        ${mb ? sw('cat', c.id, !isOff('cat', c.id), 'Sold at this branch') : H`<button style="color:var(--text);text-decoration:underline" data-a="editcat" data-id="${c.id}">Edit</button>`}</h3>
      <div class="group" style="${mb && isOff('cat', c.id) ? 'opacity:.55' : ''}">${menu.items.filter((i) => i.category_id === c.id).map((i) => H`<div class="row"><button class="grow" style="text-align:left" data-a="edititem" data-id="${i.id}">
          <div class="t">${i.name}</div><div class="d">${gbp(i.price_pence)}${i.options.length ? ' · ' + i.options.length + ' option group(s)' : ''}</div></button>
          ${mb ? sw('item', i.id, !isOff('item', i.id), 'Sold at this branch') : H`<input type="checkbox" class="sw" data-a="avail" data-id="${i.id}" ${i.available ? H`checked` : ''} aria-label="Available">`}</div>`)}
        ${mb ? '' : H`<button class="row" style="color:var(--text);text-decoration:underline" data-a="newitem" data-id="${c.id}">+ Add item</button>`}</div>`)}`);
  $('#mbs')?.addEventListener('click', (e) => { const x = e.target.closest('[data-b]'); if (x) { mb = +x.dataset.b; drawMenu(); } });
}
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b || !menu || tab() !== 'menu') return;
  const id = +b.dataset.id, a = b.dataset.a;
  if (a === 'newcat') catSheet();
  if (a === 'editcat') catSheet(menu.categories.find((c) => c.id === id));
  if (a === 'newitem') itemSheet({ category_id: id });
  if (a === 'edititem') itemSheet(menu.items.find((i) => i.id === id));
});
app.addEventListener('change', async (e) => {
  if (e.target.dataset.a === 'boff') {
    const { kind, id } = e.target.dataset, off = !e.target.checked;
    try {
      await api(`/m/branches/${mb}/off`, { kind, ref: +id, off });
      menu.off = menu.off.filter((r) => !(r.branch_id === mb && r.kind === kind && r.ref_id === +id)); if (off) menu.off.push({ branch_id: mb, kind, ref_id: +id });
      drawMenu();
    } catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
    return;
  }
  if (e.target.dataset.a !== 'avail') return;
  const it = menu.items.find((i) => i.id === +e.target.dataset.id);
  try { await api('/m/items', { ...it, available: e.target.checked }); it.available = e.target.checked; } catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
});

function catSheet(c = {}) {
  const days = new Set(c.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const s = sheet(H`<h2>${c.id ? 'Edit' : 'New'} category</h2><div class="group">
    <label class="row"><span>Name</span><input id="n" value="${c.name || ''}"></label>
    <label class="row"><span>Available from</span><input id="f" type="time" value="${c.from_time || ''}"></label>
    <label class="row"><span>Until</span><input id="u" type="time" value="${c.to_time || ''}"></label></div>
    <div class="quick"><button data-q="all">All day</button><button data-q="open">From opening (${br0().open_time})</button><button data-q="close">Until closing (${br0().close_time})</button></div>
    <h3>Days available</h3><div class="chips" style="flex-wrap:wrap">${[1, 2, 3, 4, 5, 6, 0].map((d) => H`<button class="chip ${days.has(d) ? 'on' : ''}" data-d="${d}">${DAYS[d]}</button>`)}</div>
    <button class="btn" data-a="save" style="margin-top:12px">Save</button>
    ${c.id ? H`<button class="btn red" data-a="del" style="margin-top:10px">Delete category and its items</button>` : ''}`);
  s.el.onclick = async (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q) { // quick fills: All day clears both times; opening/closing copy the café's hours
      if (q === 'all') { $('#f', s.el).value = ''; $('#u', s.el).value = ''; }
      if (q === 'open') $('#f', s.el).value = br0().open_time;
      if (q === 'close') $('#u', s.el).value = br0().close_time;
      return;
    }
    const d = e.target.closest('[data-d]'); if (d) { d.classList.toggle('on'); days.has(+d.dataset.d) ? days.delete(+d.dataset.d) : days.add(+d.dataset.d); return; }
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    try {
      if (a === 'del') { if (!confirm('Delete this category and all its items?')) return; await api('/m/categories/' + c.id, null, 'DELETE'); }
      else await api('/m/categories', { id: c.id, name: $('#n', s.el).value, from_time: $('#f', s.el).value, to_time: $('#u', s.el).value, days: [...days] });
      s.close(); menuView();
    } catch (x) { toast(x.message); }
  };
}

const PRESETS = {
  Milk: { name: 'Milk', multi: false, choices: [{ name: 'Whole', price: 0 }, { name: 'Oat', price: 50 }, { name: 'Soy', price: 50 }] },
  Size: { name: 'Size', multi: false, choices: [{ name: 'Regular', price: 0 }, { name: 'Large', price: 50 }] },
  Extras: { name: 'Extras', multi: true, choices: [{ name: 'Extra shot', price: 60 }, { name: 'Syrup', price: 50 }] },
};

function itemSheet(it) {
  if (!menu.categories.length) return toast('Add a category first');
  const opts = structuredClone(it.options || []), itemAl = new Set(it.allergens || []), openAl = new Set(), itemDi = new Set(it.dietary || []);
  const alChips = (set, attr) => H`<div class="als">${ALLERGENS.map(([k, l]) => H`<button class="chip ${set.has(k) ? 'on' : ''}" ${{ raw: attr }} data-al="${k}">${l}</button>`)}</div>`;
  const s = sheet(H`<h2>${it.id ? 'Edit' : 'New'} item</h2><div class="group">
    <label class="row"><span>Name</span><input id="n" value="${it.name || ''}"></label>
    <label class="row"><span>Price (£)</span><input id="p" type="number" step="0.01" min="0" inputmode="decimal" value="${it.price_pence != null ? (it.price_pence / 100).toFixed(2) : ''}"></label>
    <label class="row"><span>Category</span><select id="c">${menu.categories.map((c) => H`<option value="${c.id}" ${c.id === it.category_id ? H`selected` : ''}>${c.name}</option>`)}</select></label>
    <label class="row"><span class="grow">Available</span><input type="checkbox" class="sw" id="a" ${it.available !== false ? H`checked` : ''}></label></div>
    <h3>Description (optional)</h3><div class="group"><textarea class="field" id="d" maxlength="200" placeholder="Leave blank if it needs no explanation">${it.description || ''}</textarea></div>
    <h3>Allergens in this item</h3><div class="sub" style="margin-bottom:8px">Tick everything it contains. Check carefully – customers rely on this.</div><div id="ial"></div>
    <h3>Dietary (optional)</h3><div class="sub" style="margin-bottom:8px">Customers can filter the menu by these. Only tick what you can guarantee.</div><div id="idi"></div>
    <h3>Customisation options (optional)</h3><div class="group" id="opts"></div>
    <div class="quick" id="presets">${Object.keys(PRESETS).map((k) => H`<button data-preset="${k}">+ ${k}</button>`)}<button data-newgroup="1">+ Custom group</button></div>
    <button class="btn" data-a="save">Save</button>${it.id ? H`<button class="btn red" data-a="del" style="margin-top:10px">Delete item</button>` : ''}`);
  const draw = () => {
    $('#ial', s.el).innerHTML = alChips(itemAl, 'data-ai="1"').raw;
    $('#idi', s.el).innerHTML = H`<div class="als">${DIETARY.map(([k, l]) => H`<button class="chip ${itemDi.has(k) ? 'on' : ''}" data-di="${k}">${l}</button>`)}</div>`.raw;
    $('#opts', s.el).innerHTML = opts.length ? H`${opts.map((g, gi) => H`<div class="opt">
      <div class="hd"><input data-f="gname" data-g="${gi}" value="${g.name}" placeholder="Group name, e.g. Milk"><button class="x" data-rm="${gi}" aria-label="Remove group">×</button></div>
      <div class="seg"><button class="${g.multi ? '' : 'on'}" data-mode="single" data-g="${gi}">Pick one</button><button class="${g.multi ? 'on' : ''}" data-mode="multi" data-g="${gi}">Pick any</button></div>
      ${g.choices.map((c, ci) => H`<div class="ch"><input data-f="cname" data-g="${gi}" data-c="${ci}" value="${c.name}" placeholder="Choice, e.g. Oat">
        <input class="pr" data-f="cprice" data-g="${gi}" data-c="${ci}" type="number" step="0.01" min="0" inputmode="decimal" value="${c.price ? (c.price / 100).toFixed(2) : ''}" placeholder="+£0.00" aria-label="Extra cost in pounds">
        <button class="x" data-rmc="${ci}" data-g="${gi}" aria-label="Remove choice">×</button></div>
        <button class="link" data-tal="${gi}-${ci}" style="margin-top:6px;font-size:13px">Allergens${(c.allergens || []).length ? ' (' + c.allergens.length + ')' : ''} ${openAl.has(gi + '-' + ci) ? '▴' : '▾'}</button>
        ${openAl.has(gi + '-' + ci) ? alChips(new Set(c.allergens || []), `data-ag="${gi}" data-ac="${ci}"`) : ''}`)}
      <button class="link" data-addc="${gi}">+ Add choice</button></div>`)}`.raw : H`<div class="opt sub">No options. Add one below, e.g. milk or size.</div>`.raw;
  };
  s.el.addEventListener('input', (e) => { // typing updates state only (no redraw, so focus is kept)
    const f = e.target.dataset.f, g = opts[+e.target.dataset.g]; if (!f || !g) return;
    if (f === 'gname') g.name = e.target.value;
    if (f === 'cname') g.choices[+e.target.dataset.c].name = e.target.value;
    if (f === 'cprice') g.choices[+e.target.dataset.c].price = Math.max(0, Math.round(parseFloat(e.target.value) * 100) || 0);
  });
  s.el.onclick = async (e) => {
    const d = e.target.dataset, t = e.target.closest('button'); if (!t) return;
    const D = t.dataset;
    if (D.di) itemDi.has(D.di) ? itemDi.delete(D.di) : itemDi.add(D.di);
    else if (D.al) {
      if (D.ai) itemAl.has(D.al) ? itemAl.delete(D.al) : itemAl.add(D.al);
      else { const c = opts[+D.ag].choices[+D.ac], x = new Set(c.allergens || []); x.has(D.al) ? x.delete(D.al) : x.add(D.al); c.allergens = [...x]; }
    } else if (D.tal !== undefined) openAl.has(D.tal) ? openAl.delete(D.tal) : openAl.add(D.tal);
    else if (D.preset) opts.push(structuredClone(PRESETS[D.preset]));
    else if (D.newgroup) opts.push({ name: '', multi: false, choices: [{ name: '', price: 0 }] });
    else if (D.rm !== undefined) opts.splice(+D.rm, 1);
    else if (D.mode) opts[+D.g].multi = D.mode === 'multi';
    else if (D.addc !== undefined) opts[+D.addc].choices.push({ name: '', price: 0 });
    else if (D.rmc !== undefined) opts[+D.g].choices.splice(+D.rmc, 1);
    else if (D.a) {
      try {
        if (D.a === 'del') { if (!confirm('Delete this item?')) return; await api('/m/items/' + it.id, null, 'DELETE'); }
        else await api('/m/items', {
          id: it.id, name: $('#n', s.el).value, description: $('#d', s.el).value, price_pence: Math.round(parseFloat($('#p', s.el).value) * 100),
          category_id: +$('#c', s.el).value, available: $('#a', s.el).checked,
          allergens: [...itemAl], dietary: [...itemDi], options: opts.map((g) => ({ ...g, choices: g.choices.filter((c) => c.name.trim()) })).filter((g) => g.name.trim() && g.choices.length),
        });
        s.close(); menuView();
      } catch (x) { toast(x.message); }
      return;
    } else return;
    draw();
  };
  draw();
}

// ---------- settings ----------
async function toLogo(file) {
  const img = await createImageBitmap(file), n = 256, cv = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const k = Math.min(n / img.width, n / img.height);
  cv.getContext('2d').drawImage(img, (n - img.width * k) / 2, (n - img.height * k) / 2, img.width * k, img.height * k);
  const png = cv.toDataURL('image/png');
  return png.length < 380000 ? png : cv.toDataURL('image/webp', 0.8);
}
function settingsView() {
  const feeTxt = me.fee_pct != null ? Number(me.fee_pct) + '%' : (me.reduced_until && new Date(me.reduced_until) > new Date()) ? '2.5%' : '5%';
  const reduced = me.reduced_until && new Date(me.reduced_until) > new Date(), rdate = reduced ? new Date(me.reduced_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const f = (id, label, v, extra = '') => H`<label class="row"><span>${label}</span><input id="${id}" value="${v ?? ''}" ${extra}></label>`;
  shell('Settings', H`<div class="group" style="margin-top:12px">
      <div class="row">${me.logo ? H`<img class="logo" src="${me.logo}">` : H`<div class="logo" style="background:${me.color};color:${onColor(me.color)}">${me.name[0]}</div>`}
        <label class="grow" style="color:var(--text);text-decoration:underline">Upload logo<input type="file" id="logo" accept="image/*" hidden>${me.logo_pending ? H`<div class="sub">Your new logo is being checked for viruses. It goes live in a few minutes.</div>` : ''}</label></div></div>
    <h3>Brand colour</h3><div class="group">
      <label class="row"><span class="grow">Colour wheel</span><input type="color" id="color" value="${me.color}" style="flex:none;width:52px;height:34px"></label>
      <label class="row"><span>Hex</span><input id="hex" value="${me.color}" maxlength="7" autocapitalize="characters" spellcheck="false"></label>
      <div class="row"><span style="min-width:96px">RGB</span><div class="rgb">${[0, 1, 2].map((i) => H`<input class="rgbi" data-i="${i}" type="number" min="0" max="255" inputmode="numeric" aria-label="${'RGB'[i]}" value="${parseInt(me.color.slice(1 + i * 2, 3 + i * 2), 16)}">`)}</div></div>
      <div class="swatch-preview"><span class="pv" id="pv">Order now</span><span class="sub" id="pvnote"></span></div>
      <div class="swatches" style="padding-top:4px">${['#2B39F0', '#C42F17', '#0F6B37', '#E0541F', '#7A2BC4', '#6B4A2B', '#14161B'].map((c) => H`<button data-c="${c}" style="background:${c}" aria-label="${c}"></button>`)}</div>
      <div style="padding:0 16px 14px"><button class="btn" id="savecolor">Save colour</button></div></div>
    <h3>Café</h3><div class="group">${f('name', 'Name', me.name)}</div>
    <h3>Branches</h3><div class="group">${me.branches.map((b) => H`<button class="row chev" data-branch="${b.id}"><div class="grow"><div class="t">${b.name}</div><div class="d">${b.address || b.postcode} · ${b.open_time}–${b.close_time}</div></div></button>`)}</div>
    <button class="btn sec" id="addbranch" style="margin-top:10px">Add a branch</button>
    <h3>Ordering</h3><div class="group"><label class="row"><span class="grow">Offer eat-in<div class="sub">Customers choose eat-in or takeaway at checkout</div></span><input type="checkbox" class="sw" id="sitin" ${me.allow_sitin !== false ? H`checked` : ''}></label>
      <label class="row"><span class="grow">Off-hand service fee to customer<div class="sub">Raises every price slightly so you receive the full menu price after Docket’s ${feeTxt} fee. Not a surcharge: the prices themselves change. Keep it within the 7.5% in-store price limit in the Merchant Terms.</div></span><input type="checkbox" class="sw" id="passfee" ${me.pass_fee ? H`checked` : ''}></label>
      <label class="row"><span class="grow">Test mode<div class="sub">View your store as a customer and place fake orders without paying. Only you can see your store while it’s on.</div></span><input type="checkbox" class="sw" id="testmode" ${me.test_mode ? H`checked` : ''}></label>
      <a class="row chev" href="#offers"><span class="grow">Offers &amp; loyalty card<div class="sub">Offer codes, plus a stamp card for regulars</div></span></a>
      <a class="row chev" href="#reviews"><span class="grow">Reviews<div class="sub">What customers say about you</div></span></a></div>
    <h3>Tax</h3><div class="group"><label class="row"><span class="grow">VAT registered<div class="sub">Menu prices include 20% VAT; it's shown on receipts</div></span><input type="checkbox" class="sw" id="vat" ${me.vat_registered ? H`checked` : ''}></label>
      ${f('vatno', 'VAT number', me.vat_number)}</div>
    <button class="btn" id="save" style="margin-top:12px">Save changes</button>
    <h3>Notifications</h3><div class="group" id="pn"></div>
    <h3>Marketing</h3><div class="group"><a class="row chev" href="#poster"><span class="grow">Design a QR poster<div class="sub">Print a poster or table card that opens your menu</div></span></a></div>
    <h3>Refer a café</h3><div class="group"><div class="row"><span class="grow">Your code<div class="sub">When a café you refer takes its first paid order, you both pay half the fee (2.5% instead of 5%) for 30 days. Rewards stack. ${me.referral.count} referred so far.${reduced ? ' Reduced fee until ' + rdate + '.' : ''}</div></span><b style="font-size:20px;letter-spacing:.1em">${me.referral.code}</b></div>
      <button class="row" id="refshare" style="text-decoration:underline;font-weight:700">Share your invite link</button></div>
    ${me.is_admin ? H`<a class="btn sec" href="${urls.adminUrl}/" style="margin-top:12px">Admin dashboard</a>` : ''}
    <h3>Merchant Terms</h3>${me.terms.current ? H`<div class="banner">You’ve agreed to the Merchant Terms. <a href="/terms/" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:700">Read them</a></div>`
      : H`<div class="group"><div class="row"><span class="sub">Before you can launch your store, read and agree to the Merchant Terms. They cover how Docket works, fees, refunds, food safety, data and liability.</span></div>
        <a class="row chev" href="/terms/" target="_blank" rel="noopener"><span class="grow">Read the Merchant Terms</span></a>
        <label class="row"><span class="grow">I’ve read and agree to the Merchant Terms</span><input type="checkbox" class="sw" id="agree"></label></div>
        <button class="btn" id="accept" disabled>Agree and continue</button>`}
    <h3>Payments</h3>${me.mollie ? H`<div class="banner">Mollie connected. Payouts go straight to your Mollie balance (a ${me.fee_pct != null ? feeTxt + ' custom' : reduced ? '2.5% reduced' : '5%'} platform fee is deducted${reduced ? ' until ' + rdate : ''}).</div>`
      : H`<div class="banner">Connect Mollie to start taking orders – customers can't see your café until you do.</div>${me.terms.current ? H`<a class="btn" href="/api/mollie/connect">Connect Mollie</a>` : H`<div class="err">Agree to the Merchant Terms above to launch your store.</div>`}`}
    <button class="btn red" id="out" style="margin-top:24px">Sign out</button>
    <h3>Delete account</h3><div class="group"><div class="row"><span class="sub">Permanently deletes your café, menu, branches, offers, loyalty cards, reviews and sign-in from our servers. Past order records are kept for payment and tax purposes. This can’t be undone.</span></div>
      <button class="row" id="delacct" style="color:#b00020;text-decoration:underline;font-weight:700">Delete my account…</button></div>`);
  const save = async (patch) => { try { await put(patch); toast('Saved'); } catch (e) { toast(e.message); } };
  $('#logo').onchange = async (e) => { if (e.target.files[0]) { await save({ logo: await toLogo(e.target.files[0]) }); settingsView(); } };
  let col = me.color; // wheel, hex and RGB all edit the same value
  const setCol = (c, from) => {
    col = c.toLowerCase();
    if (from !== 'wheel') $('#color').value = col;
    if (from !== 'hex') $('#hex').value = col;
    if (from !== 'rgb') $$('.rgbi').forEach((el) => { el.value = parseInt(col.slice(1 + el.dataset.i * 2, 3 + el.dataset.i * 2), 16); });
    const a = accentFor(col), pv = $('#pv');
    pv.style.background = col; pv.style.color = onColor(col);
    $('#pvnote').textContent = `Text contrast ${contrast(col, onColor(col)).toFixed(1)}:1` + (a.toLowerCase() !== col ? ' · buttons on white use a slightly darker shade so they stand out' : '');
  };
  setCol(col);
  $('#color').oninput = (e) => setCol(e.target.value, 'wheel');
  $('#hex').oninput = (e) => { const v = e.target.value.trim().replace(/^#?/, '#'); if (/^#[0-9a-f]{6}$/i.test(v)) setCol(v, 'hex'); };
  $$('.rgbi').forEach((el) => { el.oninput = () => setCol('#' + $$('.rgbi').map((i) => Math.max(0, Math.min(255, parseInt(i.value) || 0)).toString(16).padStart(2, '0')).join(''), 'rgb'); });
  $$('.swatches button').forEach((b) => { b.onclick = () => setCol(b.dataset.c); });
  $('#savecolor').onclick = async () => { await save({ color: col }); settingsView(); };
  $('#vat').onchange = (e) => save({ vat_registered: e.target.checked });
  $('#save').onclick = () => save({ name: $('#name').value, vat_number: $('#vatno').value });
  $$('[data-branch]').forEach((b) => { b.onclick = () => branchSheet(me.branches.find((x) => x.id === +b.dataset.branch)); });
  $('#addbranch').onclick = () => branchSheet({});
  $('#sitin').onchange = (e) => save({ allow_sitin: e.target.checked });
  $('#passfee').onchange = (e) => save({ pass_fee: e.target.checked });
  $('#testmode').onchange = async (e) => { await save({ test_mode: e.target.checked }); settingsView(); };
  $('#agree')?.addEventListener('change', (e) => { $('#accept').disabled = !e.target.checked; });
  $('#accept')?.addEventListener('click', async () => { try { me = await api('/m/terms', { accept: true, version: me.terms.version }); toast('Thanks – terms accepted'); settingsView(); } catch (e) { toast(e.message); } });
  $('#refshare').onclick = async () => {
    const text = 'Join me on Docket – take orders ahead and we both get a reduced fee.';
    try { if (navigator.share) await navigator.share({ title: 'Docket', text, url: me.referral.link }); else { await navigator.clipboard.writeText(me.referral.link); toast('Invite link copied'); } } catch { /* cancelled */ }
  };
  pushSettings();
  $('#out').onclick = async () => { await api('/m/logout', {}); me = null; authView(); };
  $('#delacct').onclick = async () => {
    const email = prompt(`This permanently deletes ${me.name} and all its data. Type your account email (${me.email}) to confirm.`);
    if (email === null) return;
    try { await api('/m/account', { email }, 'DELETE'); me = null; authView(); toast('Your account has been deleted'); } catch (e) { toast(e.message); }
  };
}

boot();

// ---------- QR poster designer (print / save as PDF from the browser) ----------
const SIZES = { a4: ['A4 poster', 'A4'], a5: ['A5 flyer', 'A5'], a6: ['A6 table card', 'A6'] };
async function posterView() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js');
  const o = { head: 'Order ahead. Skip the queue.', sub: 'Pay by card or Apple Pay. We’ll alert you when it’s ready.', theme: 'brand', size: 'a4', ...ls.get('poster', {}) };
  const url = `${urls.appUrl}/#/c/${me.id}`;
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  const seg = (k, opts) => H`<div class="chips" data-k="${k}">${Object.entries(opts).map(([v, l]) => H`<button class="chip ${o[k] === v ? 'on' : ''}" data-v="${v}">${l}</button>`)}</div>`;
  shell('QR poster', H`<div class="noprint">
    <div class="group" style="margin-top:12px"><label class="row"><span>Headline</span><input id="phead" maxlength="60" value="${o.head}"></label>
      <label class="row"><span>Line</span><input id="psub" maxlength="90" value="${o.sub}"></label></div>
    <h3>Style</h3>${seg('theme', { brand: 'Brand colour', ink: 'Black', paper: 'White' })}
    <h3>Size</h3>${seg('size', Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v[0]])))}
    <button class="btn" id="print" style="margin:14px 0">Print or save as PDF</button>
    <div class="sub" style="margin-bottom:12px">Choose “Save as PDF” in the print dialog to download it. Scan it with your phone first – it should open your menu.</div></div>
    <div id="pwrap"></div>`);
  const draw = () => {
    const brand = me.color, bg = { brand, ink: '#14161B', paper: '#FFFFFF' }[o.theme], fg = o.theme === 'brand' ? onColor(brand) : o.theme === 'ink' ? '#FFFFFF' : '#14161B';
    const edge = o.theme === 'paper' ? brand : fg;
    $('#pwrap').innerHTML = H`<div class="poster" style="background:${bg};color:${fg}">
      <div class="p-top">${me.logo ? H`<img src="${me.logo}" alt="">` : ''}<span>${me.name}</span></div>
      <h2 style="color:${fg}">${o.head}</h2>
      <div class="p-qr"><div class="p-qrbox">${{ raw: qr.createSvgTag({ scalable: true, margin: 0 }) }}</div><b>Scan to order</b></div>
      <p class="p-sub" style="color:${fg}">${o.sub}</p>
      <ol class="p-steps" style="border-color:${edge}"><li>Scan</li><li>Order</li><li>Collect</li></ol>
    </div>`.raw;
    let st = $('#pagesz'); if (!st) { st = document.head.appendChild(Object.assign(document.createElement('style'), { id: 'pagesz' })); }
    st.textContent = `@page{size:${SIZES[o.size][1]} portrait;margin:0}`;
    ls.set('poster', o);
  };
  $('#phead').oninput = (e) => { o.head = e.target.value; draw(); };
  $('#psub').oninput = (e) => { o.sub = e.target.value; draw(); };
  $$('.chips[data-k]').forEach((c) => { c.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; o[c.dataset.k] = b.dataset.v; $$('.chip', c).forEach((x) => x.classList.toggle('on', x === b)); draw(); }; });
  $('#print').onclick = () => print();
  draw();
}

// ---------- branches ----------
function branchSheet(b) {
  const f = (id, label, v, extra = '') => H`<label class="row"><span>${label}</span><input id="${id}" value="${v ?? ''}" ${extra}></label>`;
  const s = sheet(H`<h2>${b.id ? 'Edit' : 'New'} branch</h2><div class="sub" style="margin-bottom:10px">Same menu and account – each branch has its own address, hours and orders.</div>
    <div class="group">${f('bn', 'Name', b.name, 'placeholder="e.g. High Street"')}${f('ba', 'Address', b.address)}${f('bp', 'Postcode', b.postcode, 'autocapitalize="characters"')}
    ${f('bo', 'Opens', b.open_time || '07:00', 'type="time"')}${f('bc', 'Closes', b.close_time || '17:00', 'type="time"')}${f('bx', 'Prep time (min)', b.prep_minutes ?? 10, 'type="number" min="0" max="120"')}</div>
    ${b.id ? H`<div id="bextra"></div>` : ''}
    <button class="btn" data-a="save" style="margin-top:14px">Save</button>${b.id && brs().length > 1 ? H`<button class="btn red" data-a="del" style="margin-top:10px">Delete branch</button>` : ''}`);
  s.el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    try {
      if (a === 'del') { if (!confirm('Delete this branch?')) return; me = await api('/m/branches/' + b.id, null, 'DELETE'); if (kb === b.id) { kb = 0; ls.set('kbranch', 0); } }
      else {
        const body = { name: $('#bn', s.el).value, address: $('#ba', s.el).value, postcode: $('#bp', s.el).value, open_time: $('#bo', s.el).value, close_time: $('#bc', s.el).value, prep_minutes: parseInt($('#bx', s.el).value) || 0 };
        me = b.id ? await api('/m/branches/' + b.id, body, 'PUT') : await api('/m/branches', body);
      }
      s.close(); settingsView();
    } catch (x) { toast(x.message); }
  };
  if (!b.id) return;

  // temporary closures / special hours, kitchen printer (all apply to this branch)
  const cur = () => me.branches.find((x) => x.id === b.id) || b, st = { kind: 'closed' };
  const day = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const extras = () => {
    const x = cur(), cls = me.closures.filter((c) => c.branch_id === b.id);
    $('#bextra', s.el).innerHTML = H`<h3>Temporary closures &amp; special hours</h3>
      ${cls.length ? H`<div class="group">${cls.map((c) => H`<div class="row"><span class="grow">${c.kind === 'hours' ? `Hours ${c.open_time}–${c.close_time}` : 'Closed'} · ${c.from_date === c.to_date ? day(c.from_date) : day(c.from_date) + ' – ' + day(c.to_date)}${c.note ? H`<div class="sub">${c.note}</div>` : ''}</span><button class="x" data-x="delcl" data-id="${c.id}" aria-label="Remove">×</button></div>`)}</div>` : ''}
      <div class="group"><div class="row"><div class="seg" style="flex:1"><button class="${st.kind === 'closed' ? 'on' : ''}" data-x="kind" data-k="closed">Closed</button><button class="${st.kind === 'hours' ? 'on' : ''}" data-x="kind" data-k="hours">Special hours</button></div></div>
        <label class="row"><span>From</span><input id="cf" type="date" value="${st.cf || ''}"></label><label class="row"><span>To</span><input id="ct" type="date" value="${st.ct || ''}"></label>
        ${st.kind === 'hours' ? H`<label class="row"><span>Opens</span><input id="co" type="time" value="${st.co ?? x.open_time}"></label><label class="row"><span>Closes</span><input id="cc" type="time" value="${st.cc ?? x.close_time}"></label>` : ''}
        <label class="row"><span>Note</span><input id="cn" maxlength="80" placeholder="e.g. Bank holiday" value="${st.cn || ''}"></label></div>
      <button class="btn sec" data-x="addcl" style="margin-top:8px">Add</button>
      <h3>Kitchen printer</h3><div class="group"><label class="row"><span class="grow">Print orders automatically<div class="sub">Star CloudPRNT printers. Customers then see an estimated ready time instead of live “Preparing / Ready” updates.</div></span><input type="checkbox" class="sw" data-x="printer" ${x.printer_on ? H`checked` : ''}></label>
        ${x.printer_on ? H`<div class="row" style="flex-direction:column;align-items:stretch;gap:6px"><div class="sub">Set this as the CloudPRNT server URL in your printer’s settings:</div><input readonly value="${location.origin}/api/print/${x.printer_token}" style="font-size:12px;width:100%"><div style="display:flex;gap:16px"><button data-x="copy" style="text-decoration:underline;font-weight:700">Copy</button><button data-x="regen" style="text-decoration:underline;font-weight:700">Generate new address</button></div></div>` : ''}</div>
`.raw;
  };
  s.el.addEventListener('input', (e) => { if (['cf', 'ct', 'cn', 'co', 'cc'].includes(e.target.id)) st[e.target.id] = e.target.value; });
  s.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-x]'); if (!t) return; const k = t.dataset.x;
    try {
      if (k === 'kind') st.kind = t.dataset.k;
      else if (k === 'addcl') { me = await api(`/m/branches/${b.id}/closures`, { kind: st.kind, from_date: st.cf, to_date: st.ct || st.cf, open_time: st.co ?? cur().open_time, close_time: st.cc ?? cur().close_time, note: st.cn }); Object.assign(st, { cf: '', ct: '', cn: '' }); toast('Added'); }
      else if (k === 'delcl') me = await api('/m/closures/' + t.dataset.id, null, 'DELETE');
      else if (k === 'printer') me = await api(`/m/branches/${b.id}/printer`, { on: t.checked });
      else if (k === 'regen') { if (!confirm('The old address will stop working – you’ll need to update your printer. Continue?')) return; me = await api(`/m/branches/${b.id}/printer`, { regen: true }); }
      else if (k === 'copy') { await navigator.clipboard.writeText(`${location.origin}/api/print/${cur().printer_token}`); return toast('Copied'); }
      else return;
      extras();
    } catch (x) { toast(x.message); if (t.type === 'checkbox') t.checked = !t.checked; }
  });
  extras();
}

// ---------- sales, proceeds, trends, history ----------
const sv = { days: 30, br: 0, q: '' };
const trend = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round((a - b) / b * 100))}% vs previous period` : 'No earlier data to compare');
const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
function barChart(vals, label) { // inline SVG, no library; the numbers are also listed in text for screen readers
  const max = Math.max(1, ...vals), W = 600, H_ = 140, gap = vals.length > 60 ? 1 : 3, bw = W / vals.length - gap;
  return H`<svg viewBox="0 0 ${W} ${H_ + 2}" width="100%" role="img" aria-label="${label}" style="display:block"><line x1="0" y1="${H_ + 1}" x2="${W}" y2="${H_ + 1}" stroke="#14161B" stroke-width="2"/>
    ${vals.map((v, i) => H`<rect x="${(i * (W / vals.length)).toFixed(1)}" y="${(H_ - v / max * H_).toFixed(1)}" width="${Math.max(bw, 1).toFixed(1)}" height="${(v / max * H_).toFixed(1)}" fill="var(--accent)"/>`)}</svg>`;
}
async function salesView() {
  shell('Sales', H`<div class="chips" id="rng" style="margin-top:12px">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']].map(([d, l]) => H`<button class="chip ${sv.days === d ? 'on' : ''}" data-d="${d}">${l}</button>`)}</div>
    ${brs().length > 1 ? H`<div class="chips" id="sbs"><button class="chip ${sv.br ? '' : 'on'}" data-b="0">All branches</button>${brs().map((b) => H`<button class="chip ${sv.br === b.id ? 'on' : ''}" data-b="${b.id}">${b.name}</button>`)}</div>` : ''}
    <div id="sbody"><div class="spin"></div></div>`);
  $('#rng').onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) { sv.days = +b.dataset.d; salesView(); } };
  $('#sbs')?.addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b) { sv.br = +b.dataset.b; salesView(); } });
  let d; try { d = await api(`/m/stats?days=${sv.days}&branch=${sv.br}`); } catch (e) { $('#sbody').innerHTML = H`<div class="empty">${e.message}</div>`.raw; return; }
  if (tab() !== 'sales') return;
  const c = d.cur, p = d.prev, avg = c.orders ? Math.round(c.gross / c.orders) : 0;
  // fill empty days; beyond 90 days group into weeks so bars stay readable
  const byDay = Object.fromEntries(d.daily.map((r) => [r.d, r])); const days = [];
  for (let i = d.days - 1; i >= 0; i--) { const k = ymd(new Date(Date.now() - i * 864e5)); if (days[days.length - 1] !== k) days.push(k); }
  const step = d.days > 90 ? 7 : 1, series = [];
  for (let i = 0; i < days.length; i += step) series.push(days.slice(i, i + step).reduce((a, k) => a + (byDay[k]?.gross || 0), 0));
  const hrs = Array.from({ length: 24 }, (_, h) => d.hours.find((r) => r.h === h)?.n || 0), peak = hrs.indexOf(Math.max(...hrs));
  const kpi = (l, v, note) => H`<div class="kpi"><small>${l}</small><b>${v}</b>${note ? H`<small>${note}</small>` : ''}</div>`;
  $('#sbody').innerHTML = H`<div class="kpis">${kpi('Sales', gbp(c.gross), trend(c.gross, p.gross))}${kpi('Orders', c.orders, trend(c.orders, p.orders))}
      ${kpi('Average order', gbp(avg))}${kpi('Tips', gbp(c.tips))}${kpi('Your proceeds', gbp(c.net), 'After the 5% platform fee')}${kpi('Refunds', c.refunds ? `${c.refunds} · ${gbp(c.refunded)}` : 'None', c.refunds ? 'The 5% fee isn’t returned' : '')}</div>
    <div class="sub" style="margin:8px 0 0">Proceeds = sales − the 5% platform fee. Mollie’s own card fees are shown in your Mollie dashboard.${c.vat ? ` Sales include ${gbp(c.vat)} VAT.` : ''}</div>
    <h3>Sales ${d.days > 90 ? 'by week' : 'by day'}</h3><div class="card">${c.orders ? barChart(series, 'Sales over time') : H`<div class="empty" style="padding:20px 0">No sales in this period</div>`}
      ${c.orders ? H`<div class="axis"><span>${days[0]}</span><span>Best ${d.days > 90 ? 'week' : 'day'}: ${gbp(Math.max(...series))}</span><span>${days[days.length - 1]}</span></div>` : ''}</div>
    <h3>Busiest hours</h3><div class="card">${c.orders ? H`${barChart(hrs, 'Orders by hour of day')}<div class="axis"><span>00:00</span><span>Peak ${String(peak).padStart(2, '0')}:00</span><span>23:00</span></div>` : H`<div class="empty" style="padding:20px 0">No data yet</div>`}</div>
    <h3>Top sellers</h3>${d.top.length ? H`<div class="group">${d.top.map((t) => H`<div class="row"><span class="grow">${t.name}</span><span class="sub">${t.qty} sold</span><b>${gbp(t.rev)}</b></div>`)}</div>` : H`<div class="empty">Nothing sold yet</div>`}
    ${brs().length > 1 && !sv.br ? H`<h3>By branch</h3><div class="group">${brs().map((b) => { const r = d.byBranch.find((x) => x.branch_id === b.id); return H`<div class="row"><span class="grow">${b.name}</span><span class="sub">${r?.orders || 0} orders</span><b>${gbp(r?.gross || 0)}</b></div>`; })}</div>` : ''}
    <h3>Transactions</h3><div class="group"><div class="row"><input id="tq" class="field" style="padding:0;background:none" type="search" placeholder="Search name or order number" value="${sv.q}"></div></div>
    <div id="tx" style="margin-top:10px"></div>
    <a class="btn sec" style="margin-top:14px" href="/api/m/export?days=${sv.days}&branch=${sv.br}">Download CSV (${sv.days === 365 ? '12 months' : sv.days + ' days'})</a>`.raw;
  let off = 0, rows = [], t;
  const draw = (more) => {
    $('#tx').innerHTML = rows.length ? H`<div class="group">${rows.map((o) => H`<div class="row" style="align-items:flex-start"><div class="grow"><div class="t"><span>#${o.num} · ${o.customer_name}</span></div>
      <div class="d">${new Date(o.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' })}${brs().length > 1 ? ' · ' + (brs().find((b) => b.id === o.branch_id)?.name || '') : ''}</div>
      <div class="d">${o.items.map((i) => i.qty + '× ' + i.name).join(', ')}</div></div>
      <div style="text-align:right"><b>${gbp(o.total)}</b><div class="d">${o.status === 'refunded' ? H`<span class="badge warn">Refunded</span> −${gbp(o.fee)} fee` : 'Net ' + gbp(o.total - o.fee)}</div></div></div>`)}</div>
      ${more ? H`<button class="btn sec" id="more" style="margin-top:10px">Load more</button>` : ''}` .raw : H`<div class="empty">No transactions found</div>`.raw;
    if (more) $('#more').onclick = () => load(true);
  };
  const load = async (append) => {
    try {
      off = append ? off + 50 : 0;
      const r = await api(`/m/transactions?days=${sv.days}&branch=${sv.br}&q=${encodeURIComponent(sv.q)}&offset=${off}`);
      rows = append ? rows.concat(r.rows) : r.rows; draw(r.more);
    } catch (e) { toast(e.message); }
  };
  $('#tq').oninput = (e) => { sv.q = e.target.value.trim(); clearTimeout(t); t = setTimeout(() => load(false), 300); };
  load(false);
}

// ---------- new-order notifications (Web Push to this device) ----------
const b64 = (v) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pushSettings() {
  const box = $('#pn'); if (!box) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) || (ios && !standalone)) {
    box.innerHTML = H`<div class="row"><span class="grow">${ios && !standalone ? 'On iPhone or iPad, tap Share → “Add to Home Screen”, then open Docket Kitchen from your Home Screen to turn on notifications.' : 'This browser can’t receive notifications. Try Chrome, Edge or Safari from the Home Screen.'}</span></div>`.raw; return;
  }
  const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
  const st = sub ? await api('/m/push?endpoint=' + encodeURIComponent(sub.endpoint)).catch(() => ({ on: false })) : { on: false };
  const where = (id) => (id ? brs().find((b) => b.id === id)?.name || 'one branch' : 'all branches');
  box.innerHTML = st.on
    ? H`<div class="row"><span class="grow">On for this device · ${where(st.branch_id)}<div class="sub">You’ll get an alert for each new order, even when the app is closed.</div></span></div>
        <button class="row" id="ptest" style="text-decoration:underline;font-weight:700">Send a test notification</button>
        <button class="row" id="poff" style="text-decoration:underline;font-weight:700">Turn off on this device</button>`.raw
    : H`${brs().length > 1 ? H`<label class="row"><span>Alert me for</span><select id="pbr"><option value="0">All branches</option>${brs().map((b) => H`<option value="${b.id}">${b.name}</option>`)}</select></label>` : ''}
        <div class="row"><button class="btn" id="pon">Turn on notifications</button></div>`.raw;
  $('#pon')?.addEventListener('click', async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') return toast('Notifications are blocked – allow them in your browser settings');
      const { vapid } = await api('/config');
      const s = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapid) });
      await api('/m/push', { sub: s.toJSON(), branch_id: +($('#pbr')?.value || 0) || null });
      toast('Notifications on'); pushSettings();
    } catch (e) { toast(e.message); }
  });
  $('#ptest')?.addEventListener('click', () => api('/m/push/test', {}).then(() => toast('Test sent')).catch((e) => toast(e.message)));
  $('#poff')?.addEventListener('click', async () => { try { await api('/m/push/off', { endpoint: sub.endpoint }); await sub.unsubscribe(); pushSettings(); } catch (e) { toast(e.message); } });
}

// ---------- offers & loyalty ----------
async function offersView() {
  shell('Offers & loyalty', H`<div class="spin"></div>`);
  let offers, menuItems, menuCats; try { [offers, { items: menuItems, categories: menuCats }] = await Promise.all([api('/m/offers'), api('/m/menu')]); } catch (e) { return shell('Offers & loyalty', H`<div class="empty">${e.message}</div>`); }
  if (tab() !== 'offers') return;
  let L = { ...me.loyalty };
  const desc = (o) => `${o.kind === 'percent' ? o.value + '% off' : gbp(o.value) + ' off'}${o.min_spend ? ' · min ' + gbp(o.min_spend) : ''} · used ${o.used}${o.max_uses ? '/' + o.max_uses : ''}${o.expires_at ? ' · until ' + o.expires_at : ''}`;
  const draw = () => {
    shell('Offers & loyalty', H`
      <h3>Loyalty card</h3><div class="group">
        <label class="row"><span class="grow">Run a loyalty card<div class="sub">Customers collect stamps when signed in. You choose how they earn them and the reward.</div></span><input type="checkbox" class="sw" id="le" ${L.enabled ? H`checked` : ''}></label>
        ${L.enabled ? H`<label class="row"><span>Card name</span><input id="ln" maxlength="30" value="${L.name}"></label>
          <label class="row"><span>Stamps needed</span><input id="lneed" type="number" min="2" max="30" value="${L.needed}"></label>
          <label class="row"><span>Earn a stamp</span><select id="lea"><option value="order" ${L.earn !== 'item' ? H`selected` : ''}>Per order</option><option value="item" ${L.earn === 'item' ? H`selected` : ''}>Per item</option></select></label>
          ${L.earn === 'item' ? H`<div class="row" style="flex-direction:column;align-items:stretch;gap:8px"><span>Items that count <span class="sub">(none selected = every item)</span></span><div class="chips" id="lec" style="flex-wrap:wrap;overflow:visible;margin:0;padding:0">${menuCats.map((c) => H`<button class="chip ${(L.earnCats || []).includes(c.id) ? 'on' : ''}" data-ec="${c.id}">${c.name}</button>`)}</div></div>` : ''}
          <div class="row"><div class="seg" style="flex:1"><button class="${L.type === 'percent' ? 'on' : ''}" data-lt="percent">% off</button><button class="${L.type === 'fixed' ? 'on' : ''}" data-lt="fixed">£ off</button><button class="${L.type === 'product' ? 'on' : ''}" data-lt="product">Free item</button></div></div>
          ${L.type === 'product' ? H`<label class="row"><span>Free product</span><select id="li"><option value="">Choose…</option>
              <optgroup label="Any item from a category">${menuCats.map((c) => H`<option value="c${c.id}" ${c.id === L.category ? H`selected` : ''}>Any ${c.name}</option>`)}</optgroup>
              <optgroup label="A specific item">${menuItems.map((i) => H`<option value="i${i.id}" ${i.id === L.item ? H`selected` : ''}>${i.name}</option>`)}</optgroup></select></label>
            <label class="row"><span class="grow">Extras are free too<div class="sub">Off: the customer still pays for extras like milk or size</div></span><input type="checkbox" class="sw" id="lx" ${L.extras ? H`checked` : ''}></label>
            <div class="row"><span class="sub">The customer adds it to their basket and it’s free. For a category, the priciest matching item is free (up to your cap).</span></div>`
          : H`<label class="row"><span>${L.type === 'percent' ? 'Percent off (100 = free)' : 'Amount off (£)'}</span><input id="lv" type="number" min="1" step="${L.type === 'percent' ? 1 : 0.01}" value="${L.type === 'percent' ? L.value : (L.value / 100).toFixed(2)}"></label>`}
          ${L.type === 'percent' || (L.type === 'product' && L.category) ? H`<label class="row"><span>Max discount (£, 0 = none)</span><input id="lcap" type="number" min="0" step="0.01" value="${(L.cap / 100).toFixed(2)}"></label>` : ''}` : ''}</div>
      ${L.enabled ? H`<button class="btn" id="lsave" style="margin-top:12px">Save loyalty card</button>` : ''}
      <h3>Offer codes</h3>
      ${offers.length ? H`<div class="group">${offers.map((o) => H`<div class="row"><span class="grow"><div class="t">${o.code}</div><div class="d">${desc(o)}</div></span>
        <input type="checkbox" class="sw" data-oa="${o.id}" ${o.active ? H`checked` : ''} aria-label="Active"><button class="x" data-od="${o.id}" aria-label="Delete">×</button></div>`)}</div>` : H`<div class="empty" style="padding:12px 0">No offer codes yet</div>`}
      <h3>New offer code</h3><div class="group">
        <label class="row"><span>Code</span><input id="oc" maxlength="20" autocapitalize="characters" placeholder="e.g. WELCOME10"></label>
        <label class="row"><span>Type</span><select id="ok"><option value="percent">Percent off</option><option value="fixed">Amount off (£)</option></select></label>
        <label class="row"><span>Value (% or £)</span><input id="ov" type="number" min="1" step="0.01" inputmode="decimal"></label>
        <label class="row"><span>Minimum spend (£)</span><input id="om" type="number" min="0" step="0.01" placeholder="0"></label>
        <label class="row"><span>Max uses</span><input id="ox" type="number" min="1" placeholder="Unlimited"></label>
        <label class="row"><span>Expires</span><input id="oe" type="date"></label></div>
      <button class="btn" id="oadd" style="margin-top:12px">Create offer code</button>`);
    const ok = (p) => p.then(() => offersView()).catch((x) => toast(x.message));
    $('#le').onchange = async (e) => { try { me = await api('/m/loyalty', { enabled: e.target.checked }, 'PUT'); L = { ...me.loyalty }; draw(); } catch (x) { toast(x.message); } };
    $$('[data-ec]').forEach((b) => { b.onclick = () => { const id = +b.dataset.ec, s = new Set(L.earnCats || []); s.has(id) ? s.delete(id) : s.add(id); L = { ...L, earnCats: [...s] }; b.classList.toggle('on', s.has(id)); }; });
    $('#lea')?.addEventListener('change', (e) => { L = { ...L, earn: e.target.value }; draw(); });
    $$('[data-lt]').forEach((b) => { b.onclick = () => { L = { ...L, type: b.dataset.lt, ...(b.dataset.lt === 'product' ? {} : { value: b.dataset.lt === 'percent' ? 100 : 300 }) }; draw(); }; });
    $('#lsave')?.addEventListener('click', async () => {
      try {
        const v = parseFloat($('#lv')?.value);
        me = await api('/m/loyalty', { enabled: true, name: $('#ln').value, needed: parseInt($('#lneed').value), type: L.type, earn: $('#lea').value, earnCats: $('#lea').value === 'item' ? L.earnCats || [] : [], extras: !!$('#lx')?.checked, ...(L.type === 'product' ? ($('#li').value[0] === 'c' ? { category: +$('#li').value.slice(1) } : { item: +$('#li').value.slice(1) || null }) : { value: L.type === 'percent' ? Math.round(v) : Math.round(v * 100) }), cap: Math.round((parseFloat($('#lcap')?.value) || 0) * 100) }, 'PUT');
        L = { ...me.loyalty }; toast('Saved'); draw();
      } catch (x) { toast(x.message); }
    });
    $$('[data-oa]').forEach((c) => { c.onchange = () => api('/m/offers/' + c.dataset.oa, { active: c.checked }, 'PUT').catch((x) => { toast(x.message); c.checked = !c.checked; }); });
    $$('[data-od]').forEach((b) => { b.onclick = () => { if (confirm('Delete this offer code?')) ok(api('/m/offers/' + b.dataset.od, null, 'DELETE')); }; });
    $('#oadd').onclick = () => {
      const kind = $('#ok').value, v = parseFloat($('#ov').value);
      ok(api('/m/offers', { code: $('#oc').value, kind, value: kind === 'percent' ? Math.round(v) : Math.round(v * 100), min_spend: Math.round((parseFloat($('#om').value) || 0) * 100), max_uses: parseInt($('#ox').value) || 0, expires: $('#oe').value }).then(() => toast('Offer code created')));
    };
  };
  draw();
}

async function reviewsView() {
  shell('Reviews', H`<div class="spin"></div>`);
  let r; try { r = await api('/m/reviews'); } catch (e) { return shell('Reviews', H`<div class="empty">${e.message}</div>`); }
  if (tab() !== 'reviews') return;
  shell('Reviews', H`
    <div class="kpis"><div class="kpi"><small>Average</small><b>${r.n ? r.avg.toFixed(1) + ' / 5' : '–'}</b><small>${r.n} review${r.n === 1 ? '' : 's'}</small></div></div>
    <div class="sub" style="margin:10px 0">${r.shown ? 'Customers can see your average rating.' : `Customers see your average rating once you have 10 reviews (${10 - r.n} to go). You can read every review here.`}</div>
    ${r.rows.length ? H`<div class="group">${r.rows.map((x) => H`<div class="row" style="align-items:flex-start"><div class="grow"><div class="t">${x.stars}/5 ${stars(x.stars)}</div>${x.comment ? H`<div class="d">${x.comment}</div>` : ''}
      <div class="d">#${x.num}${x.branch ? ' · ' + x.branch : ''} · ${new Date(x.created_at).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' })}</div></div></div>`)}</div>` : H`<div class="empty">No reviews yet. Customers are asked once their order is collected.</div>`}`);
}
