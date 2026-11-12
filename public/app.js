import { H, gbp, $, $$, ls, api, toast, sheet, loadScript, toPhoto, registerSW, setAccent, barcode, onColor, stars } from './ui.js';
import { priceLine, totals, catAvailable, londonNow, toMins, discountFor } from './pricing.js';
import { itemAllergens, allergenText, ALLERGENS, DIETARY } from '/allergens.js';

registerSW();
const app = $('#app');
let cart = ls.get('cart', { cafeId: null, lines: [] });
let favs = ls.get('favs', []), favCafes = ls.get('favCafes', []); // favCafes: [{id,name,address}]
let orders = ls.get('orders', []);
let cafe = null, timer, deferred, acct = null, signin = null; // acct: signed-in email; signin: { email } once a code has been sent
let avoid = ls.get('avoid', []); // allergens this customer avoids (flagged on the menu and sent to the café if they choose)
let allergensOn = ls.get('allergensOn', avoid.length > 0), defaults = ls.get('defaults', []); // settings; allergen info is opt-in
const av = () => (allergensOn ? avoid : []);
const words = (x) => (String(x).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w !== 'milk'); // case and the word “milk” are ignored: “Oat milk” = “oat”
const isDefault = (name) => { const w = words(name); return defaults.some((d) => { const dw = words(d); return dw.length && dw.every((x) => w.includes(x)); }); }; // "oat milk" matches "Oat milk", "decaf" matches "Decaf shot"
const road = (a) => String(a || '').split(',').map((x) => x.trim().replace(/^\d+[a-z]?(\s*[-–/]\s*\d+[a-z]?)?\s+/i, '')).find((x) => /[a-z]/i.test(x) && !/^(unit|flat|suite|shop|floor)\b/i.test(x)) || a;
const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hyg = (r) => (/^[0-5]$/.test(r || '') ? `Hygiene ${r}/5` : /^(pass|improvement required)$/i.test(r || '') ? `Hygiene: ${r}` : '');
const rewardText = (L) => L.type === 'product' ? (L.category ? `a free item from ${L.itemName || 'the menu'}` : `a free ${L.itemName || 'item'}`) : (L.type === 'percent' ? (L.value === 100 ? 'a free order' : L.value + '% off') : gbp(L.value) + ' off') + (L.type === 'percent' && L.cap ? ` (up to ${gbp(L.cap)})` : '');
const upText = (u) => `${u.kind === 'hours' ? `Special hours ${u.open}–${u.close}` : 'Closed'} ${u.from === u.to ? fmtDay(u.from) : fmtDay(u.from) + ' – ' + fmtDay(u.to)}${u.note ? ' · ' + u.note : ''}`;
const save = () => { ls.set('cart', cart); ls.set('favs', favs); ls.set('orders', orders); };
const nav = (title, back) => H`<div class="nav"><button data-go="${back}"><span class="bk"></span>Back</button><b>${title}</b><span style="width:60px"></span></div>`;
const logo = (c) => c.logo ? H`<img class="logo" src="${c.logo}" alt="">` : H`<div class="logo" style="background:${c.color};color:${onColor(c.color)}">${c.name[0]}</div>`;
const sk = (sel) => JSON.stringify(sel);
const mi = (km) => { const m = km * 0.621; return m < 0.1 ? 'nearby' : m.toFixed(1) + ' mi'; };

// ---------- café data ----------
// A café account can have several branches: the customer's pick decides address, hours, slots and where the order goes.
function applyBranch(id) {
  cafe.all ||= cafe.categories; // full shared menu; cafe.categories = what the chosen branch sells
  const b = cafe.branches.find((x) => x.id === +id) || cafe.branches.find((x) => x.id === ls.get('br:' + cafe.id)) || cafe.branches[0];
  ls.set('br:' + cafe.id, b.id);
  cafe.categories = cafe.all.filter((c) => !b.off.cats.includes(c.id)).map((c) => ({ ...c, items: c.items.filter((i) => !b.off.items.includes(i.id)) }));
  cafe.categories.forEach((c) => c.items.forEach((i) => { i.cat = c; }));
  Object.assign(cafe, { branchId: b.id, branchName: cafe.branches.length > 1 ? b.name : '', address: b.address, paused: b.paused, asap: b.asap, slots: b.slots, open_time: b.open_time, close_time: b.close_time, lat: b.lat, lng: b.lng,
    closed: b.closed, special: b.special, upcoming: b.upcoming || [], hygiene: b.hygiene, reviews: b.reviews || { n: 0 }, estimate: b.estimate });
}
async function loadCafe(id, branch) {
  cafe = await api('/cafes/' + id);
  applyBranch(branch);
  cafe.categories.forEach((c) => c.items.forEach((i) => { i.cat = c; }));
  setAccent(cafe.color);
}
const itemOf = (id) => cafe?.categories.flatMap((c) => c.items).find((i) => i.id === id);
function cleanCart() { // drop lines whose item vanished / options changed
  cart.lines = cart.lines.filter((l) => { const it = itemOf(l.id); try { return it && it.available && priceLine(it, l.sel); } catch { return false; } });
  save();
}
const cartSub = () => cart.lines.reduce((n, l) => n + priceLine(itemOf(l.id), l.sel).unit * l.qty, 0);

function addToCart(it, sel, qty) {
  if (cart.cafeId !== cafe.id) {
    if (cart.lines.length && !confirm('Start a new basket? Your current basket is from another café.')) return false;
    cart = { cafeId: cafe.id, cafeName: cafe.name, lines: [] };
  }
  const l = cart.lines.find((x) => x.id === it.id && sk(x.sel) === sk(sel));
  if (l) l.qty = Math.min(20, l.qty + qty); else cart.lines.push({ id: it.id, sel, qty });
  save(); return true;
}

// ---------- favourites (stored on device, include customisations) ----------
const isFav = (id, sel) => favs.some((f) => f.cafeId === cafe.id && f.itemId === id && sk(f.sel) === sk(sel));
function toggleFav(it, sel) {
  if (isFav(it.id, sel)) favs = favs.filter((f) => !(f.cafeId === cafe.id && f.itemId === it.id && sk(f.sel) === sk(sel)));
  else favs.push({ cafeId: cafe.id, cafeName: cafe.name, itemId: it.id, name: it.name, sel, label: priceLine(it, sel).names.join(', ') });
  save(); syncMe();
}
// Signed in: favourites live on the server against the account; localStorage is a cache (and the only copy for guests).
const syncMe = () => { ls.set('favs', favs); ls.set('favCafes', favCafes); if (acct) api('/me', { favs, favCafes }, 'PUT').catch(() => {}); };
const sk2 = (f) => `${f.cafeId}|${f.itemId}|${JSON.stringify(Object.entries(f.sel || {}).sort())}`;
const union = (a, b, key) => [...new Map([...a, ...b].map((v) => [key(v), v])).values()].slice(0, 100);
const unionFavs = (a, b) => union(a, b, sk2), unionCafes = (a, b) => union(a, b, (c) => c.branchId ?? 'm' + c.id);

// A saved café is one specific branch (old saves without a branch match any branch of that café).
// A saved café is identified by its branch id (unique across the platform). Old saves without one match the café's first branch until upgraded.
const favMatch = (c, id, br) => (c.branchId != null ? c.branchId === br : c.id === id);
const isFavCafe = (id, br) => favCafes.some((c) => favMatch(c, id, br));
const dedupeCafes = (a) => [...new Map(a.map((c) => [c.branchId ?? 'm' + c.id, c])).values()];
function upgradeFavs(live) { // give old saves their branch id, drop duplicates
  const before = JSON.stringify(favCafes);
  favCafes = dedupeCafes(favCafes.map((f) => { const c = f.branchId == null ? live.find((x) => x.id === f.id) : null; return c ? { ...f, branchId: c.branchId, branch: c.branch, many: c.many } : f; }));
  if (JSON.stringify(favCafes) !== before) syncMe();
}
function toggleFavCafe(c) {
  favCafes = isFavCafe(c.id, c.branchId) ? favCafes.filter((x) => !favMatch(x, c.id, c.branchId))
    : [...favCafes, { id: c.id, branchId: c.branchId, name: c.name, branch: c.branch, many: c.many, address: c.address, color: c.color, logo: c.logo }];
  syncMe();
}

// ---------- routing ----------
const views = { c: menuView, cart: cartView, checkout: checkoutView, o: orderView, favs: favsView, orders: ordersView, settings: settingsView };
async function route() {
  clearTimeout(timer);
  const q = new URLSearchParams(location.search);
  if (q.get('order')) { history.replaceState(null, '', '/#/o/' + q.get('order')); }
  const [, page, arg, arg2] = location.hash.split('/');
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.t === ({ favs: 'favs', orders: 'orders', o: 'orders', settings: 'settings' }[page] || 'home')));
  app.scrollTo(0, 0);
  try { await (views[page] || homeView)(arg, arg2); $('#app .group, #app .ord')?.classList.add('print'); } catch (e) { app.innerHTML = H`<div class="empty">${e.message}<br><br><button class="btn sm" data-go="#/">Back to cafés</button></div>`.raw; }
}
addEventListener('hashchange', route);

app.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]'); if (go) return (location.hash = go.dataset.go);
  const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
  if (a === 'install') installApp();
  if (a === 'x') { ls.set('noinstall', 1); $('#install').innerHTML = ''; }
  if (a === 'loc') { ls.set('pos', null); homeView(); }
  if (a === 'pc') {
    try {
      const j = await (await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent($('#pc').value.replace(/\s/g, '')))).json();
      if (!j.result) throw 0; ls.set('pos', { lat: j.result.latitude, lng: j.result.longitude }); homeView();
    } catch { toast('Postcode not found'); }
  }
  if (a === 'qty') { const l = cart.lines[+b.dataset.i]; l.qty += +b.dataset.d; cart.lines = cart.lines.filter((x) => x.qty > 0); save(); drawCart(); }
  if (a === 'favcafe') { // heart on a home/favourites row (that one branch) or on the café page
    const id = +b.dataset.id, br = +b.dataset.br, home = !!$('#saved'), fv = !!$('#favlist');
    const c = home ? window.findCafe(id, br) : fv ? favCafes.find((x) => favMatch(x, id, br)) : { id, branchId: br, name: cafe.name, branch: cafe.branchName, many: !!cafe.branchName, address: cafe.address, color: cafe.color, logo: cafe.logo };
    if (c) toggleFavCafe({ ...c, branchId: br });
    if (home) window.redrawHome(); else if (fv) favsView(); else { b.classList.toggle('on', isFavCafe(id, br)); b.querySelector('svg').setAttribute('fill', isFavCafe(id, br) ? 'currentColor' : 'none'); }
  }
  if (a === 'favrm') { favs.splice(+b.dataset.i, 1); save(); syncMe(); drawFavs(); }
  if (a === 'favadd') {
    const f = favs[+b.dataset.i];
    try {
      if (cafe?.id !== f.cafeId) await loadCafe(f.cafeId);
      const it = itemOf(f.itemId); if (!it?.available) throw new Error('No longer available');
      priceLine(it, f.sel); if (addToCart(it, f.sel, 1)) { toast('Added to basket'); if ($('#myfavs')) renderMenu(); }
    } catch (err) { toast(err.message.startsWith('Choose') || err.message.startsWith('Invalid') ? 'Options changed – re-add from the menu' : err.message); }
  }
  if (a === 'push') enablePush(b.dataset.id);
  if (a === 'alon') { allergensOn = b.checked; ls.set('allergensOn', allergensOn); settingsView(); }
  if (a === 'avk') { avoid = avoid.includes(b.dataset.k) ? avoid.filter((x) => x !== b.dataset.k) : [...avoid, b.dataset.k]; ls.set('avoid', avoid); settingsView(); }
  if (a === 'dadd') addDefault();
  if (a === 'codesend') {
    const email = $('#se').value.trim();
    try { await api('/me/code', { email }); signin = { email }; settingsView(); toast('Code sent – check your email'); } catch (err) { toast(err.message); }
  }
  if (a === 'codeverify') {
    try {
      await api('/me/verify', { email: signin.email, code: $('#sc').value });
      const r = await api('/me'); acct = r.email; signin = null;
      favs = unionFavs(r.favs, favs); favCafes = unionCafes(r.favCafes, favCafes); syncMe(); toast('Signed in'); settingsView();
    } catch (err) { toast(err.message); }
  }
  if (a === 'codeback') { signin = null; settingsView(); }
  if (a === 'signout') { await api('/me/logout', {}).catch(() => {}); acct = null; favs = []; favCafes = []; ls.set('favs', favs); ls.set('favCafes', favCafes); toast('Signed out'); settingsView(); }

  if (a === 'drm') { defaults.splice(+b.dataset.i, 1); ls.set('defaults', defaults); settingsView(); }
  if (a === 'support') return supportSheet(b.dataset.id);
  if (a === 'again') { b.disabled = true; reorder(await api('/orders/' + b.dataset.id)).finally(() => { b.disabled = false; }); }
  if (a === 'rate') { $$('.rate .star').forEach((x) => x.classList.toggle('on', +x.dataset.n <= +b.dataset.n)); b.parentElement.dataset.n = b.dataset.n; } // tap the Nth star = N stars
  if (a === 'sendrev') {
    const n = $('.rate')?.dataset.n; if (n === undefined) return toast('Choose a rating first');
    try { await api(`/orders/${b.dataset.id}/review`, { stars: +n, comment: $('#rc').value }); toast('Thanks for your review'); orderView(b.dataset.id); } catch (err) { toast(err.message); }
  }
});

// "Order again": rebuild the basket from a past order, skipping anything that's gone or changed.
async function reorder(o) {
  try {
    await loadCafe(o.cafe.id, o.cafe.branchId);
    let skipped = 0, added = 0;
    for (const l of o.items) {
      const it = itemOf(l.id); if (!it?.available) { skipped++; continue; }
      const sel = l.sel || Object.fromEntries(it.options.map((g, gi) => { const p = g.choices.map((c, ci) => (l.opts.includes(c.name) ? ci : -1)).filter((ci) => ci >= 0); return [gi, g.multi ? p : p.length ? [p[0]] : [0]]; }));
      try { priceLine(it, sel); } catch { skipped++; continue; }
      if (!addToCart(it, sel, l.qty)) return; added++;
    }
    if (!added) return toast('Those items aren’t available right now');
    if (skipped) toast(`${skipped} item${skipped > 1 ? 's' : ''} no longer available`);
    location.hash = '#/cart';
  } catch (e) { toast(e.message); }
}

// ---------- home ----------
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; installBanner(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function installBanner() {
  const el = $('#install');
  if (!el || standalone() || ls.get('noinstall')) return;
  if (!deferred && !/iphone|ipad|ipod|android/i.test(navigator.userAgent)) return;
  el.innerHTML = H`<div class="banner" style="flex-wrap:wrap"><div style="flex:1;min-width:180px"><b>Get the Docket app</b>
    <div class="sub">Add it to your home screen for one-tap ordering and ready-for-pickup alerts.</div></div>
    <button class="btn sm" data-a="install">Add to Home Screen</button><button data-a="x" class="sub" style="text-decoration:underline">Dismiss</button></div>`.raw;
}
// Android/Chrome can show the real install prompt; iOS never lets a site add itself, so we show the exact steps.
function installApp() {
  if (deferred) { deferred.prompt(); deferred.userChoice?.then(() => { deferred = null; const el = $('#install'); if (el) el.innerHTML = ''; }); return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const steps = ios ? ['Open this page in Safari', 'Tap the Share button (the square with an arrow) in the toolbar', 'Scroll down and tap “Add to Home Screen”, then “Add”']
    : ['Open your browser’s menu (the three dots)', 'Tap “Install app” or “Add to Home screen”'];
  sheet(H`<h2>Add to Home Screen</h2><div class="group">${steps.map((t, i) => H`<div class="row"><b>${i + 1}</b><span class="grow">${t}</span></div>`)}</div>
    ${ios ? H`<div class="sub">Apple doesn’t let websites add themselves, so it takes these taps.</div>` : ''}`);
}
const locate = () => new Promise((ok) => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { timeout: 8000, maximumAge: 6e5 }) : ok(null));

function cafeRow(c) {
  const bits = [c.reviews?.avg ? H`${stars(c.reviews.avg)} ${c.reviews.avg} (${c.reviews.n})` : '', hyg(c.hygiene)].filter(Boolean);
  return H`<div class="row"><button class="grow" style="display:flex;align-items:center;gap:12px;text-align:left;min-width:0" data-go="#/c/${c.id}${c.branchId ? '/' + c.branchId : ''}">${logo(c)}
      <div class="grow"><div class="t">${c.name}</div><div class="d">${c.km != null ? mi(c.km) + ' · ' : ''}${road(c.address)}</div>
        ${bits.length ? H`<div class="d">${bits.map((x, i) => H`${i ? ' · ' : ''}${x}`)}</div>` : ''}</div>
      ${c.slots ? H`<span class="badge ${c.paused ? 'warn' : c.asap ? 'ok' : ''}">${c.paused ? 'Paused' : c.closed ? 'Closed today' : c.asap ? 'Open' : 'Closed'}</span>` : ''}</button>
      <button class="heart ${isFavCafe(c.id, c.branchId) ? 'on' : ''}" data-a="favcafe" data-id="${c.id}" data-br="${c.branchId}" aria-label="Save café"><svg viewBox="0 0 24 24" width="24" height="24" fill="${isFavCafe(c.id, c.branchId) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/></svg></button></div>`;
}

async function homeView() {
  setAccent();
  app.innerHTML = H`<div class="nav"><b></b></div><div class="wrap"><h1 class="large">Docket</h1><div id="install"></div>
    <div class="group"><div class="row"><input id="q" class="field" style="padding:0;background:none" placeholder="Search cafés by name" type="search" autocomplete="off" enterkeyhint="search"></div></div>
    <div class="chips" id="vw" style="margin-top:10px"><button class="chip on" data-v="list">List</button><button class="chip" data-v="map">Map</button></div>
    <div id="mapbox" hidden><div id="map"></div></div>
    <div id="saved"></div><h3 id="lh">Open near you</h3><div id="list"><div class="spin"></div></div><div id="loc"></div></div>`.raw;
  installBanner();
  const pos = ls.get('pos') || await locate();
  let list = [], seq = 0;
  let map, layer, mode = 'list';
  const drawMap = async () => {
    if (mode !== 'map') return;
    if (!window.L) { if (!$('#leafcss')) document.head.append(Object.assign(document.createElement('link'), { id: 'leafcss', rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css' })); await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'); }
    if (!map) {
      map = L.map('map', { zoomControl: true, attributionControl: true }).setView([pos?.lat ?? 54.5, pos?.lng ?? -3], pos ? 12 : 5);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    const pts = list.filter((c) => c.lat != null && c.lng != null);
    pts.forEach((c) => L.marker([c.lat, c.lng], { icon: L.divIcon({ className: 'pin', html: H`<span style="background:${c.color}"></span>`.raw, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] }) })
      .bindPopup(H`<b>${c.name}</b>${c.many ? H` · ${c.branch}` : ''}<br>${c.address}<br><a href="#/c/${c.id}/${c.branchId}">View menu</a>`.raw).addTo(layer));
    if (pos) L.circleMarker([pos.lat, pos.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#2B39F0', fillOpacity: 1 }).addTo(layer);
    const b = pts.map((c) => [c.lat, c.lng]).concat(pos ? [[pos.lat, pos.lng]] : []);
    if (b.length > 1) map.fitBounds(b, { padding: [30, 30], maxZoom: 15 }); else if (b.length) map.setView(b[0], 14);
    setTimeout(() => map.invalidateSize(), 50);
  };
  $('#vw').onclick = (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    mode = b.dataset.v; $$('#vw .chip').forEach((x) => x.classList.toggle('on', x === b));
    $('#mapbox').hidden = mode !== 'map'; drawMap();
  };
  const draw = () => {
    drawMap();
    const q = $('#q').value.trim();
    const rest = list; // favourite cafés live in the Favourites tab only
    $('#saved').innerHTML = '';
    $('#lh').textContent = q ? 'Results' : 'Open near you';
    $('#list').innerHTML = H`${rest.length ? H`<div class="group">${rest.map(cafeRow)}</div>`
      : H`<div class="empty">${q ? 'No cafés match “' + q + '”.' : 'No supported cafés ' + (pos ? 'near you yet' : 'found') + '.'}</div>`}`.raw;
  };
  const load = async () => {
    const my = ++seq, q = $('#q').value.trim();
    const r = await api('/cafes?' + new URLSearchParams({ ...(pos ? { lat: pos.lat, lng: pos.lng } : {}), ...(q ? { q } : {}) }));
    if (my === seq) { list = r; upgradeFavs(r); draw(); }
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  window.redrawHome = draw;
  window.findCafe = (id, br) => list.find((c) => c.id === id && c.branchId === br) || favCafes.find((c) => favMatch(c, id, br));
  $('#loc').innerHTML = H`<h3>Location</h3><div class="group">
      <div class="row"><input id="pc" class="field" style="padding:0;background:none" placeholder="Enter a postcode" autocapitalize="characters"><button data-a="pc" style="text-decoration:underline;font-weight:700">Search</button></div>
      <button class="row" data-a="loc"><span style="text-decoration:underline;font-weight:700">Use my current location</span></button>
      ${standalone() ? '' : H`<button class="row" data-a="install"><span style="text-decoration:underline;font-weight:700">Add Docket to my Home Screen</span></button>`}</div>`.raw;
  await load();
}

// ---------- menu ----------
async function menuView(id, branch) {
  app.innerHTML = H`${nav('', '#/')}<div class="spin"></div>`.raw;
  await loadCafe(id, branch); cafe.stamps = 0;
  if (acct && cafe.loyalty.enabled) try { cafe.stamps = (await api('/loyalty?cafe=' + cafe.id)).stamps; } catch { /* optional */ }
  renderMenu();
}
function catNote(c) {
  const { dow, mins } = londonNow();
  if (catAvailable(c, dow, mins)) return '';
  if (c.days && !c.days.includes(dow)) return 'Not available today';
  return c.from_time && mins < toMins(c.from_time) ? `From ${c.from_time}` : 'Finished for today';
}
let menuQ = '', menuCat = 0, menuFor = null, menuDiet = []; // search text + selected category (0 = all) + dietary filters
const flagged = (i) => [...new Set([...(i.allergens || []), ...i.options.flatMap((g) => g.choices.flatMap((c) => c.allergens || []))])].filter((a) => av().includes(a)); // item or any option
const itemRow = (i) => H`<button class="row ${i.available ? '' : 'off'}" ${i.available ? H`data-item="${i.id}"` : H`disabled`}>
  <div class="grow"><div class="t"><span>${i.name}</span><i></i><b>${i.available ? gbp(i.price_pence) : 'Sold out'}</b></div>${i.description ? H`<div class="d">${i.description}</div>` : ''}
    ${(i.dietary || []).length ? H`<div class="diet">${i.dietary.map((d) => H`<span>${DIETARY.find((x) => x[0] === d)?.[1] || d}</span>`)}</div>` : ''}
    ${allergensOn ? H`${flagged(i).length ? H`<div class="al warn">⚠ Contains ${allergenText(flagged(i))}</div>` : ''}${(i.allergens || []).length ? H`<div class="al">Contains: ${allergenText(i.allergens)}</div>` : ''}` : ''}</div>
  ${i.available ? H`<span class="add">+</span>` : ''}</button>`;
function drawItems() {
  const q = menuQ.trim().toLowerCase(), okDiet = (i) => menuDiet.every((d) => (i.dietary || []).includes(d));
  const cats = cafe.categories.filter((c) => c.items.length && (q || !menuCat || c.id === menuCat))
    .map((c) => ({ ...c, items: c.items.filter((i) => okDiet(i) && (!q || (i.name + ' ' + i.description + ' ' + c.name).toLowerCase().includes(q))) })).filter((c) => c.items.length);
  $('#items').innerHTML = cats.length ? H`${cats.map((c) => H`<h3>${c.name}${catNote(c) ? ' · ' + catNote(c) : ''}</h3><div class="group">${c.items.map(itemRow)}</div>`)}`.raw
    : H`<div class="empty">${q || menuDiet.length ? 'Nothing on the menu matches.' : 'No items yet.'}</div>`.raw;
}
// Favourite orders (an item with its customisations) live inside the café they belong to.
function drawFavs() {
  const el = $('#myfavs'); if (!el || !cafe) return;
  const mine = favs.map((f, i) => [f, i]).filter(([f]) => f.cafeId === cafe.id);
  el.innerHTML = mine.length ? H`<h3>Your favourites</h3><div class="group">${mine.map(([f, i]) => H`<div class="row"><button class="grow" data-a="favadd" data-i="${i}" style="text-align:left"><div class="t">${f.name}</div>${f.label ? H`<div class="d">${f.label}</div>` : ''}</button>
    <button class="add" data-a="favadd" data-i="${i}" aria-label="Add to basket">+</button><button data-a="favrm" data-i="${i}" class="sub" style="text-decoration:underline">Remove</button></div>`)}</div>`.raw : '';
}
function renderMenu() {
  if (menuFor !== cafe.id) { menuFor = cafe.id; menuQ = ''; menuCat = 0; menuDiet = []; }
  const n = cart.cafeId === cafe.id ? cart.lines.reduce((a, l) => a + l.qty, 0) : 0;
  const cats = cafe.categories.filter((c) => c.items.length);
  if (menuCat && !cats.some((c) => c.id === menuCat)) menuCat = 0; // that category isn't sold at this branch
  const dietUsed = DIETARY.filter(([k]) => cats.some((c) => c.items.some((i) => (i.dietary || []).includes(k)))), L = cafe.loyalty;
  app.innerHTML = H`${nav(cafe.name, '#/')}<div class="wrap">
    <div class="group" style="margin-top:16px"><div class="hero">${logo(cafe)}<h1>${cafe.name}</h1><button class="heart ${isFavCafe(cafe.id, cafe.branchId) ? 'on' : ''}" data-a="favcafe" data-id="${cafe.id}" data-br="${cafe.branchId}" aria-label="Save café"><svg viewBox="0 0 24 24" width="28" height="28" fill="${isFavCafe(cafe.id, cafe.branchId) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/></svg></button></div>
      <div class="row"><span class="sub">${cafe.address}</span><span class="badge ${cafe.paused ? 'warn' : cafe.asap ? 'ok' : ''}">${cafe.paused ? 'Orders paused' : cafe.closed ? 'Closed today' : cafe.asap ? (cafe.estimate ? 'Ready ~' : 'Ready by ~') + cafe.asap : 'Closed · pre-order'}</span></div>
      ${cafe.closed || cafe.special || cafe.upcoming.length ? H`<div class="row"><span class="sub">${cafe.closed ? '⚠ ' + cafe.closed : cafe.special ? cafe.special : upText(cafe.upcoming[0])}</span></div>` : ''}
      ${cafe.reviews.avg ? H`<div class="row"><span class="sub">${stars(cafe.reviews.avg)} ${cafe.reviews.avg} · ${cafe.reviews.n} reviews</span></div>` : ''}
      ${L.enabled ? H`<div class="row"><span class="sub">🎟 ${cafe.stamps || 0}/${L.needed} Stamps Collected</span></div>` : ''}</div>
    ${cafe.branches.length > 1 ? H`<h3>Collect from</h3><div class="chips" id="brs">${cafe.branches.map((b) => H`<button class="chip ${b.id === cafe.branchId ? 'on' : ''}" data-br="${b.id}">${b.name}</button>`)}</div>` : ''}
    <div class="group" style="margin-top:14px"><div class="row"><input id="mq" class="field" style="padding:0;background:none" type="search" placeholder="Search the menu" autocomplete="off" value="${menuQ}"></div></div>
    ${cats.length > 1 ? H`<div class="chips" id="cats" style="margin-top:10px"><button class="chip ${menuCat ? '' : 'on'}" data-cat="0">All</button>${cats.map((c) => H`<button class="chip ${menuCat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.name}</button>`)}</div>` : ''}
    <div class="chips" id="diets" style="margin-top:10px">${dietUsed.map(([k, l]) => H`<button class="chip ${menuDiet.includes(k) ? 'on' : ''}" data-d="${k}">${l}</button>`)}</div>
    <div id="myfavs"></div><div id="items"></div></div>
    ${n ? H`<button class="btn bar" data-go="#/cart"><span>View basket</span><span>${n} · ${gbp(cartSub())}</span></button>` : ''}`.raw;
  drawItems(); drawFavs();
  $('#mq').oninput = (e) => { menuQ = e.target.value; drawItems(); };
  $('#brs')?.addEventListener('click', (e) => { const b = e.target.closest('[data-br]'); if (b) { applyBranch(b.dataset.br); renderMenu(); } });
  $('#diets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    menuDiet = menuDiet.includes(b.dataset.d) ? menuDiet.filter((x) => x !== b.dataset.d) : [...menuDiet, b.dataset.d]; b.classList.toggle('on'); drawItems();
  });
  $('#cats')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    menuCat = +b.dataset.cat; $$('#cats .chip').forEach((x) => x.classList.toggle('on', x === b)); drawItems();
  });
}
app.addEventListener('click', (e) => { const b = e.target.closest('[data-item]'); if (b) openItem(itemOf(+b.dataset.item)); });

function openItem(it) {
  const sel = {}; it.options.forEach((g, gi) => { const want = g.choices.flatMap((c, ci) => (isDefault(c.name) ? [ci] : [])); sel[gi] = g.multi ? want : [want[0] ?? 0]; }); // saved defaults (Settings) preselect matching choices
  let qty = 1;
  const s = sheet(H``);
  const draw = () => {
    const { unit } = priceLine(it, sel), fav = isFav(it.id, sel);
    s.set(H`<div style="display:flex;justify-content:space-between;gap:12px"><div><h2 style="margin:4px 0">${it.name}</h2>${it.description ? H`<div class="sub">${it.description}</div>` : ''}</div>
      <button class="heart ${fav ? 'on' : ''}" data-a="fav" aria-label="Favourite"><svg viewBox="0 0 24 24" width="28" height="28" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/></svg></button></div>
      ${it.options.map((g, gi) => H`<h3>${g.name}${g.multi ? ' (optional)' : ''}</h3><div class="group">${g.choices.map((c, ci) => H`
        <button class="row" data-a="pick" data-g="${gi}" data-c="${ci}"><span class="grow">${c.name}${allergensOn && (c.allergens || []).length ? H`<div class="al">Contains: ${allergenText(c.allergens)}</div>` : ''}</span><span class="end">${c.price ? '+' + gbp(c.price) : ''}</span>
        <span style="width:18px">${sel[gi].includes(ci) ? H`<svg class="tick" viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>` : ''}</span></button>`)}</div>`)}
      <div class="group" style="margin-top:16px"><div class="row"><span class="grow">Quantity</span><div class="step"><button data-a="q" data-d="-1">−</button><b>${qty}</b><button data-a="q" data-d="1">+</button></div></div></div>
      ${allergensOn ? H`${itemAllergens(it, sel).length ? H`<div class="alsum"><b>Allergens in your order:</b> ${allergenText(itemAllergens(it, sel))}</div>` : ''}
      <div class="sub" style="margin:0 0 12px">Allergen information is provided by the café. Ask staff about cross-contamination or if you’re unsure.</div>` : ''}
      <button class="btn" data-a="add">Add to basket · ${gbp(unit * qty)}</button>`);
  };
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'pick') {
      const g = +b.dataset.g, c = +b.dataset.c;
      sel[g] = it.options[g].multi ? (sel[g].includes(c) ? sel[g].filter((x) => x !== c) : [...sel[g], c].sort((x, y) => x - y)) : [c];
    }
    if (a === 'q') qty = Math.max(1, Math.min(20, qty + +b.dataset.d));
    if (a === 'fav') { toggleFav(it, sel); drawFavs(); }
    if (a === 'add') {
      const bad = itemAllergens(it, sel).filter((x) => av().includes(x));
      if (bad.length && !confirm(`This contains ${allergenText(bad)}, which you’ve told us you avoid. Add it anyway?`)) return;
      if (addToCart(it, sel, qty)) { s.close(); renderMenu(); toast('Added to basket'); } return; }
    draw();
  });
  draw();
}

// ---------- basket ----------
async function cartView() {
  if (!cart.cafeId) { app.innerHTML = H`${nav('Basket', '#/')}<div class="empty">Your basket is empty</div>`.raw; return; }
  await loadCafe(cart.cafeId); cleanCart(); drawCart();
}
function drawCart() {
  if (!cart.lines.length) { app.innerHTML = H`${nav('Basket', '#/')}<div class="empty">Your basket is empty</div>`.raw; return; }
  app.innerHTML = H`${nav('Basket', '#/c/' + cart.cafeId)}<div class="wrap"><h3>${cart.cafeName}</h3><div class="group">
    ${cart.lines.map((l, i) => { const it = itemOf(l.id), p = priceLine(it, l.sel); return H`<div class="row">
      <div class="grow"><div class="t">${it.name}</div><div class="d">${p.names.join(', ')}</div></div>
      <span class="end">${gbp(p.unit * l.qty)}</span><div class="step"><button data-a="qty" data-i="${i}" data-d="-1">−</button><b>${l.qty}</b><button data-a="qty" data-i="${i}" data-d="1">+</button></div></div>`; })}</div>
    <div class="sum"><span>Subtotal</span><b>${gbp(cartSub())}</b></div>
    <button class="btn" data-go="#/checkout">Checkout</button></div>`.raw;
}

// ---------- checkout (custom UI: Mollie Components for cards, Apple Pay JS for wallet) ----------
async function checkoutView() {
  if (!cart.lines.length) return (location.hash = '#/');
  await loadCafe(cart.cafeId); cleanCart();
  if (!cart.lines.length) return (location.hash = '#/');
  const me = ls.get('me', { name: '', email: '' });
  let pickup = cafe.asap ? 'asap' : cafe.slots[0], tip = 5, custom = false, customPence = 0;
  let service = cafe.sitin ? ls.get('svc', 'takeaway') : 'takeaway', offerOk = null, loy = null, useReward = false, tellKitchen = true, placed = null;
  const canOrder = !cafe.paused && !cafe.closed && pickup;
  const pm = () => toMins(pickup === 'asap' ? cafe.asap : pickup);
  const sub = cartSub();
  const isProd = () => cafe.loyalty.type === 'product'; // free-product reward: an item (or any item in a category) must be in the basket
  const pool = () => (isProd() ? cart.lines.filter((l) => { const it = itemOf(l.id); return it && (cafe.loyalty.category ? it.cat?.id === cafe.loyalty.category : it.id === cafe.loyalty.item); }) : []);
  const giftValue = () => { const v = Math.max(0, ...pool().map((l) => (cafe.loyalty.extras ? priceLine(itemOf(l.id), l.sel).unit : itemOf(l.id).price_pence))); return Math.min(cafe.loyalty.category && cafe.loyalty.cap ? Math.min(v, cafe.loyalty.cap) : v, sub); };
  const rewardOk = () => !!loy?.reward && (!isProd() || pool().length > 0);
  const disc = () => (useReward && rewardOk() ? (isProd() ? giftValue() : discountFor(loy.type, loy.value, sub, loy.cap)) : offerOk ? Math.min(offerOk.discount, sub) : 0), net = () => sub - disc();
  const tot = () => totals(net(), tip, cafe.vat, custom ? customPence : null);
  const blocked = () => canOrder ? cart.lines.map((l) => itemOf(l.id)).find((it) => it.cat && !catAvailable(it.cat, londonNow().dow, pm())) : null;
  const applePay = !cafe.test && window.ApplePaySession && ApplePaySession.canMakePayments();

  app.innerHTML = H`${nav('Checkout', '#/cart')}<div class="wrap">
    ${canOrder ? '' : H`<div class="banner">${cafe.closed ? cafe.closed : cafe.paused ? 'This café has paused new orders right now.' : 'No pickup times left today.'}</div>`}
    ${cafe.estimate && canOrder ? H`<div class="banner">This café prints orders straight to the kitchen, so your ready time is an estimate.</div>` : ''}
    <h3>Collect from</h3><div class="group"><div class="row"><div class="grow"><div class="t">${cafe.name}${cafe.branchName ? ' · ' + cafe.branchName : ''}</div><div class="d">${cafe.address}</div></div>${cafe.branches.length > 1 ? H`<button data-go="#/c/${cafe.id}/${cafe.branchId}" style="text-decoration:underline;font-weight:700">Change</button>` : ''}</div></div>
    <h3>Pickup</h3><div class="chips" id="pickup"></div>
    ${cafe.sitin ? H`<h3>Eating</h3><div class="chips" id="svc"></div>` : ''}
    ${cafe.offers || cafe.loyalty.enabled ? H`<h3>Offers</h3><div class="group" id="promo"></div>` : ''}
    ${av().length ? H`<div class="group"><label class="row"><span class="grow">Tell the café I avoid: ${allergenText(av())}</span><input type="checkbox" class="sw" id="tellk" checked></label></div>` : ''}
    <h3>Tip for the team</h3><div class="chips" id="tips"></div>
    <div id="customtip" hidden><div class="group"><label class="row"><span>Tip (£)</span><input id="ctip" type="number" step="0.01" min="0" max="100" inputmode="decimal" placeholder="0.00"></label></div></div>
    <h3>Your details</h3><div class="group"><input class="field" id="name" placeholder="Name" autocomplete="name" value="${me.name}">
      <input class="field" id="email" type="email" inputmode="email" placeholder="Email for your receipt" autocomplete="email" value="${me.email}"></div>
    <h3>Summary</h3><div class="group" style="padding:8px 16px" id="summary"></div>
    <div id="blocked" class="err"></div>
    ${canOrder && cafe.test ? H`<div class="banner">Test mode: nothing is charged. The order goes to your kitchen screen marked TEST.</div><button class="btn" id="pay"></button>` : ''}
    ${canOrder && !cafe.test ? H`<h3>Payment</h3>
      ${applePay ? H`<button class="applepay" id="ap"></button><div class="ground-sub" style="text-align:center;margin:14px 0;font-weight:700">or pay by card</div>` : ''}
      <div class="group"><div class="mf"><label>Name on card</label><div id="cardHolder"></div></div><div class="mf"><label>Card number</label><div id="cardNumber"></div></div>
        <div class="pair"><div class="mf"><label>Expiry</label><div id="expiry"></div></div><div class="mf"><label>Security code</label><div id="cvc"></div></div></div></div>
      <div id="cardErr" class="err"></div><button class="btn" id="pay"></button>` : ''}
    </div>`.raw;

  const drawPickup = () => {
    $('#pickup').innerHTML = H`${cafe.asap ? H`<button class="chip ${pickup === 'asap' ? 'on' : ''}" data-p="asap">As soon as possible · ~${cafe.asap}</button>` : ''}
      ${cafe.slots.map((t) => H`<button class="chip ${pickup === t ? 'on' : ''}" data-p="${t}">${t}–${String((toMins(t) + 15) / 60 | 0).padStart(2, '0')}:${String((toMins(t) + 15) % 60).padStart(2, '0')}</button>`)}`.raw;
  };
  const drawTotals = () => {
    $('#tips').innerHTML = H`${[0, 5, 10, 15].map((p) => H`<button class="chip ${!custom && tip === p ? 'on' : ''}" data-t="${p}">${p ? p + '% · ' + gbp(Math.round(net() * p / 100)) : 'No tip'}</button>`)}<button class="chip ${custom ? 'on' : ''}" data-t="custom">Custom</button>`.raw;
    const t = tot();
    $('#summary').innerHTML = H`<div class="sum"><span>Subtotal</span><span>${gbp(sub)}</span></div>
      ${disc() ? H`<div class="sum"><span>${useReward && rewardOk() ? cafe.loyalty.name : 'Offer ' + offerOk.code}</span><span>−${gbp(disc())}</span></div>` : ''}
      ${cafe.vat ? H`<div class="sum"><span>VAT (20%) included</span><span>${gbp(t.vat)}</span></div>` : ''}
      ${t.tip ? H`<div class="sum"><span>Tip</span><span>${gbp(t.tip)}</span></div>` : ''}
      <div class="sum tot"><span>Total</span><span>${gbp(t.total)}</span></div>`.raw;
    const bl = blocked();
    $('#blocked').textContent = bl ? `${bl.name} isn't available at that pickup time.` : '';
    if ($('#pay')) { $('#pay').textContent = cafe.test ? 'Place test order' : t.total ? 'Pay ' + gbp(t.total) : 'Place order'; $('#pay').disabled = !!bl; }
  };
  const drawSvc = () => { if ($('#svc')) $('#svc').innerHTML = H`<button class="chip ${service === 'takeaway' ? 'on' : ''}" data-s="takeaway">Takeaway</button><button class="chip ${service === 'sitin' ? 'on' : ''}" data-s="sitin">Eat in</button>`.raw; };
  const drawPromo = () => {
    const el = $('#promo'); if (!el) return; const L = cafe.loyalty;
    el.innerHTML = H`${L.enabled ? H`<div class="row"><div class="grow"><div class="t">${L.name}</div><div class="d">${loy ? (loy.reward ? 'Reward ready: ' + rewardText(L) + (loy.reward && !rewardOk() ? ` – add ${L.category ? 'something from ' + L.itemName : L.itemName ? 'a ' + L.itemName : 'it'} to your basket to claim` : '') : `${loy.stamps}/${loy.needed} Stamps Collected`) : `0/${L.needed} Stamps Collected`}</div></div>
        ${acct ? '' : H`<button data-go="#/settings" style="text-decoration:underline;font-weight:700">Sign in</button>`}
        ${rewardOk() ? H`<input type="checkbox" class="sw" data-a="rw" ${useReward ? H`checked` : ''} aria-label="Use reward">` : ''}</div>` : ''}
      ${cafe.offers && !useReward ? H`<div class="row"><input id="code" class="field" style="padding:0;background:none;text-transform:uppercase" placeholder="Offer code" value="${offerOk ? offerOk.code : ''}" autocapitalize="characters" ${offerOk ? 'readonly' : ''}>
        <button data-a="code" style="text-decoration:underline;font-weight:700">${offerOk ? 'Remove' : 'Apply'}</button></div>${offerOk ? H`<div class="row"><span class="grow sub">${offerOk.code} · ${offerOk.label} applied</span></div>` : ''}` : ''}`.raw;
  };
  const loadLoy = async () => {
    if (!cafe.loyalty.enabled || !acct) return;
    try { const r = await api('/loyalty?cafe=' + cafe.id); loy = r.enabled ? r : null; if (!loy?.reward) useReward = false; drawPromo(); drawTotals(); } catch { /* optional */ }
  };
  drawPickup(); drawTotals(); drawSvc(); drawPromo(); loadLoy();
  $('#svc')?.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { service = b.dataset.s; ls.set('svc', service); drawSvc(); } });
  $('#tellk')?.addEventListener('change', (e) => { tellKitchen = e.target.checked; });
  $('#promo')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'code') {
      if (offerOk) { offerOk = null; drawPromo(); drawTotals(); return; }
      try { offerOk = await api('/offers/check', { cafeId: cafe.id, code: $('#code').value, subtotal: sub }); drawPromo(); drawTotals(); } catch (err) { toast(err.message); }
    }
  });
  $('#promo')?.addEventListener('change', (e) => { if (e.target.dataset.a === 'rw') { useReward = e.target.checked; if (useReward) offerOk = null; drawPromo(); drawTotals(); } });
  $('#pickup').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { pickup = b.dataset.p; drawPickup(); drawTotals(); } };
  $('#tips').onclick = (e) => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    custom = b.dataset.t === 'custom'; $('#customtip').hidden = !custom;
    if (custom) $('#ctip').focus(); else tip = +b.dataset.t; // always starts at 5%
    drawTotals();
  };
  $('#ctip').oninput = (e) => { customPence = Math.max(0, Math.min(10000, Math.round(parseFloat(e.target.value) * 100) || 0)); drawTotals(); };
  if (!canOrder) return;

  const details = () => {
    const name = $('#name').value.trim(), email = $('#email').value.trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) { toast('Enter your name and a valid email'); return null; }
    ls.set('me', { name, email }); return { name, email };
  };
  const place = (d) => api('/orders', { cafeId: cafe.id, branchId: cafe.branchId, items: cart.lines.map(({ id, qty, sel }) => ({ id, qty, sel })), tipPct: tip, ...(custom ? { tipPence: customPence } : {}), pickup,
    service, allergy: tellKitchen ? av() : [], offer: useReward ? undefined : offerOk?.code, useReward: useReward && rewardOk(), ...d });
  // A declined card keeps the same order, so "try again" doesn't pile up unpaid orders (a changed basket/choice places a fresh one).
  const ensureOrder = async (d) => { const sig = JSON.stringify([d, pickup, tip, custom ? customPence : null, service, offerOk?.code, useReward, tellKitchen, cart.lines]); if (placed?.sig === sig) return placed.o; const o = await place(d); placed = { sig, o }; return o; };
  const remember = (id) => { orders.unshift({ id, cafe: cafe.name, at: Date.now() }); orders = orders.slice(0, 30); save(); };

  // Card
  if (!cafe.test) await loadScript('https://js.mollie.com/v1/mollie.js');
  const mollie = cafe.test ? null : Mollie(cafe.profileId, { locale: 'en_GB', testmode: cafe.testmode });
  const styles = { base: { color: '#000000', backgroundColor: '#FBFBF8', fontSize: '17px', '::placeholder': { color: '#4d4d4d' } }, invalid: { color: '#b00020' } }; // fields sit on white paper in every theme
  for (const [type, sel] of cafe.test ? [] : [['cardHolder', '#cardHolder'], ['cardNumber', '#cardNumber'], ['expiryDate', '#expiry'], ['verificationCode', '#cvc']]) {
    const c = mollie.createComponent(type, { styles }); c.mount(sel);
    c.addEventListener('change', (ev) => { $('#cardErr').textContent = ev.error && ev.touched ? ev.error : ''; });
  }
  $('#pay').onclick = async () => {
    const d = details(); if (!d) return;
    $('#pay').disabled = true; $('#pay').textContent = 'Processing…';
    try {
      let token; if (!cafe.test && tot().total > 0) { const r0 = await mollie.createToken(); if (r0.error) throw new Error(r0.error.message); token = r0.token; }
      const o = await ensureOrder(d), r = await api(`/orders/${o.id}/pay`, token ? { cardToken: token } : {});
      remember(o.id);
      if (r.checkoutUrl) location.href = r.checkoutUrl; else location.hash = '#/o/' + o.id; // 3-D Secure bounce
    } catch (err) { toast(err.message); drawTotals(); }
  };

  // Apple Pay (only rendered when the device supports it)
  if (applePay) $('#ap').onclick = () => {
    const d = details(); if (!d) return;
    const total = tot().total;
    const s = new ApplePaySession(3, {
      countryCode: 'GB', currencyCode: 'GBP', supportedNetworks: ['visa', 'masterCard', 'amex'], merchantCapabilities: ['supports3DS'],
      total: { label: cafe.name, amount: (total / 100).toFixed(2) },
    });
    s.onvalidatemerchant = async (ev) => {
      try { s.completeMerchantValidation(await api('/applepay/session', { cafeId: cafe.id, validationUrl: ev.validationURL })); } catch (err) { s.abort(); toast('Apple Pay setup failed: ' + err.message); }
    };
    s.onpaymentauthorized = async (ev) => {
      try {
        const o = await place(d);
        if (o.total !== total) throw new Error('Prices changed – please review your basket');
        await api(`/orders/${o.id}/pay`, { applePayToken: JSON.stringify(ev.payment.token) });
        s.completePayment({ status: ApplePaySession.STATUS_SUCCESS, ...(o.wallet ? { orderDetails: o.wallet } : {}) }); remember(o.id); // orderDetails hands the order to Apple Wallet's order tracking
        location.hash = '#/o/' + o.id;
      } catch (err) { s.completePayment(ApplePaySession.STATUS_FAILURE); toast(err.message); }
    };
    s.begin();
  };
}

// ---------- order tracking ----------
const STEPS = [['pending', 'Received'], ['accepted', 'Preparing'], ['ready', 'Ready'], ['completed', 'Collected']];
async function orderView(id) {
  let shown = null;
  app.innerHTML = H`${nav('Order', '#/orders')}<div class="spin"></div>`.raw;
  const draw = async () => {
    const o = await api('/orders/' + id);
    setAccent(o.cafe.color);
    if (o.status !== 'awaiting_payment') {
      if (cart.cafeId === o.cafe.id) { cart = { cafeId: null, lines: [] }; }
      if (!orders.some((x) => x.id === id)) orders.unshift({ id, cafe: o.cafe.name, at: Date.now() });
      save();
    }
    const at = STEPS.findIndex(([k]) => k === o.status);
    const fresh = shown !== o.status; shown = o.status;
    const canPush = 'PushManager' in window && Notification.permission === 'default' && o.status !== 'completed';
    app.innerHTML = H`${nav('Order #' + o.num, '#/orders')}<div class="wrap">
      ${o.status === 'refunded' ? H`<div class="banner" style="margin-top:16px">Sorry – the café couldn't make this order. You've been refunded ${gbp(o.total)}; it can take a few days to show.</div>`
        : o.status === 'awaiting_payment' ? (o.failed
          ? H`<div class="banner" style="margin-top:16px">${o.reason || 'Your payment didn’t go through.'}</div><button class="btn" data-go="#/checkout">Try again</button>`
          : H`<div class="spin"></div><div class="empty" style="padding-top:0">Confirming payment…</div>`)
        : H`<div class="group" style="margin-top:16px">
          <div class="docket-head"><div class="sub">${o.cafe.name}</div><div class="num">#${String(o.num).padStart(3, '0')}</div>
            <div style="margin:12px 0 4px"><span class="stamp ${o.status} ${fresh ? 'fresh' : ''}">${o.estimate ? (o.status === 'completed' ? 'Collected' : 'Order sent') : STEPS[at][1]}</span></div></div>
          ${o.estimate ? '' : H`<div class="progress">${STEPS.map(([, label], i) => H`<div class="${i < at ? 'done' : i === at ? 'cur done' : ''}"><i></i>${label}</div>`)}</div>`}
          <div class="row" style="border-top:1px dashed var(--rule);justify-content:space-between"><span>${o.estimate ? (o.status === 'completed' ? 'Enjoy!' : 'Estimated ready around ' + o.pickup_time) : o.status === 'ready' ? 'Collect from the counter' : o.status === 'completed' ? 'Enjoy!' : 'Pickup ' + (o.asap ? '~' : '') + o.pickup_time}<div class="sub">${o.service === 'sitin' ? 'Eating in' : 'Takeaway'}</div></span><span class="sub">${o.cafe.address}</span></div>
          <div style="padding:8px 16px;border-top:1px dashed var(--rule)">${o.items.map((i) => H`<div class="sum"><span>${i.qty} × ${i.name}<div class="sub">${i.opts.join(', ')}</div></span><span>${gbp(i.unit * i.qty)}</span></div>`)}
            ${o.discount ? H`<div class="sum"><span>${o.offer_code ? 'Offer ' + o.offer_code : 'Loyalty reward'}</span><span>−${gbp(o.discount)}</span></div>` : ''}
            ${o.vat ? H`<div class="sum sub"><span>Includes VAT</span><span>${gbp(o.vat)}</span></div>` : ''}
            ${o.tip ? H`<div class="sum"><span>Tip</span><span>${gbp(o.tip)}</span></div>` : ''}
            <div class="sum tot"><span>Total</span><span>${gbp(o.total)}</span></div>${o.refunded ? H`<div class="sum"><span>Refunded</span><span>−${gbp(o.refunded)}</span></div>` : ''}${barcode(o.id.slice(0, 12))}${(o.allergy || []).length ? H`<div class="al">Allergies sent to the café: ${allergenText(o.allergy)}</div>` : ''}</div></div>
          ${o.review ? H`<div class="banner">You rated this ${o.review.stars}/5 – thanks!</div>` : o.canReview ? H`<h3>How was it?</h3><div class="group" style="padding:12px 16px"><div class="rate" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((n) => H`<button class="star" data-a="rate" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}"><svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"/></svg></button>`)}</div>
            <textarea id="rc" class="field" maxlength="280" rows="2" placeholder="Anything to add? (optional)" style="margin-top:8px"></textarea><button class="btn" data-a="sendrev" data-id="${id}" style="margin-top:10px">Send review</button></div>` : ''}
          ${o.status !== 'awaiting_payment' && o.status !== 'refunded' ? H`<button class="btn sec" style="margin-bottom:10px" data-a="again" data-id="${id}">Order again</button>` : ''}
          ${o.status === 'completed' && !o.test ? H`<button class="btn sec" style="margin-bottom:10px" data-a="support" data-id="${id}">Support</button>` : ''}
          ${o.dispute ? disputeCard(o.dispute) : ''}
          ${o.wallet && /iphone|ipad/i.test(navigator.userAgent) && o.status !== 'awaiting_payment' && o.status !== 'refunded' ? H`<a class="btn sec" style="margin-bottom:10px;text-decoration:none;text-align:center" href="/api/orders/${id}/wallet">Track in Apple Wallet</a>` : ''}
          ${canPush && !o.estimate ? H`<button class="btn sec" data-a="push" data-id="${id}">Notify me about this order</button>`
            : o.status !== 'completed' && !o.estimate && !('PushManager' in window) ? H`<div class="sub ground-sub">Add this app to your Home Screen for push alerts – we'll email you too.</div>` : ''}`}</div>`.raw;
    if ('PushManager' in window && Notification.permission === 'granted' && ['pending', 'accepted', 'ready'].includes(o.status) && !o.estimate && !ls.get('pushed', []).includes(id)) enablePush(id, true);
    if (o.status !== 'completed' && !o.failed && !o.canReview) timer = setTimeout(draw, o.estimate ? 30000 : 4000);
  };
  await draw();
}
// ---------- support chat, complaints & refund requests ----------
const chats = {}; // order id -> chat history (kept while the page is open)
const DSTAT = { open: 'Waiting for the café', accepted: 'Refund approved', refused: 'Refund declined', auto_refunded: 'Refunded (the café didn’t reply in time)' };
const disputeCard = (d) => H`<h3>Refund request</h3><div class="group" style="padding:12px 16px"><b>${DSTAT[d.status] || d.status}</b>
  ${d.status === 'open' ? H`<div class="sub">The café has until ${new Date(d.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to reply. If they don’t, you’re refunded automatically.</div>` : ''}
  ${d.msgs.map((m) => H`<div class="msg ${m.who === 'merchant' ? 'merchant' : ''}"><small>${m.who === 'customer' ? 'You' : 'The café'}</small>${m.body}${m.pending ? H`<div class="sub">${m.pending} photo${m.pending === 1 ? '' : 's'} being checked for viruses</div>` : ''}${(m.imgs || []).map((n) => H`<a href="/api/disputes/${d.id}/img/${n}" target="_blank" rel="noopener"><img src="/api/disputes/${d.id}/img/${n}" alt="Photo" loading="lazy"></a>`)}</div>`)}</div>`;
async function supportSheet(id) {
  const o = await api('/orders/' + id), hist = (chats[id] ??= [{ role: 'assistant', content: `Hi! I’m Docket’s support assistant. How can I help with order #${o.num} from ${o.cafe.name}?` }]);
  const left = o.items.map((l, i) => l.qty - ((o.refunded_items || {})[i] || 0)), canRefund = o.status === 'completed' && left.some((n) => n > 0) && !(o.dispute && o.dispute.status === 'open');
  const sh = sheet(H`<h2>Support · #${o.num}</h2><div id="chat" style="max-height:42vh;overflow:auto"></div><div id="act" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"></div>
    <div style="display:flex;gap:8px"><input class="field" id="cin" placeholder="Type a message" maxlength="1000" style="flex:1"><button class="btn sm" id="csend" style="flex:none">Send</button></div>`);
  const draw = (busy) => {
    $('#chat', sh.el).innerHTML = H`${hist.map((m) => H`<div class="msg ${m.role === 'user' ? 'merchant' : ''}">${m.content}</div>`)}${busy ? H`<div class="msg"><small>Typing…</small></div>` : ''}`.raw;
    $('#chat', sh.el).scrollTop = 1e6;
  };
  const acts = (extra) => {
    $('#act', sh.el).innerHTML = H`${canRefund ? H`<button class="btn sec sm" data-x="refund">Request a refund</button>` : ''}<button class="btn sec sm" data-x="complaint">Report a problem with the café</button>`.raw;
    if (extra) $(`[data-x="${extra}"]`, sh.el)?.classList.remove('sec');
  };
  const back = () => { sh.set(H`<h2>Support · #${o.num}</h2><div id="chat" style="max-height:42vh;overflow:auto"></div><div id="act" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"></div>
    <div style="display:flex;gap:8px"><input class="field" id="cin" placeholder="Type a message" maxlength="1000" style="flex:1"><button class="btn sm" id="csend" style="flex:none">Send</button></div>`); wire(); draw(); acts(); };
  const form = (kind) => {
    if (kind === 'refund') {
      sh.set(H`<h2>Request a refund</h2><p class="sub">Tell ${o.cafe.name} what went wrong. They have 7 days to respond, and if they don’t you’re refunded automatically. Photos help.</p>
        <div class="group">${o.items.map((l, i) => left[i] > 0 ? H`<label class="row"><span class="grow">${l.name}</span><select data-rq="${i}">${Array.from({ length: left[i] + 1 }, (_, k) => H`<option value="${k}">${k}</option>`)}</select></label>` : '')}</div>
        <div class="sub">Pick the items to refund, or leave all at 0 to ask for the whole order.</div>
        <textarea class="field" id="rr" rows="4" maxlength="1500" placeholder="What went wrong?" style="margin-top:8px"></textarea>
        <label class="btn sec" style="margin-top:8px;display:block;text-align:center">Add photos (up to 3)<input id="rimg" type="file" accept="image/*" multiple hidden></label><div class="sub" id="rf"></div>
        <button class="btn" id="rsend" style="margin-top:10px">Send to ${o.cafe.name}</button><button class="btn sec" id="rback" style="margin-top:8px">Back</button>`);
      let imgs = [];
      $('#rimg', sh.el).onchange = async (e) => { try { imgs = await Promise.all([...e.target.files].slice(0, 3).map(toPhoto)); $('#rf', sh.el).textContent = imgs.length + ' photo(s) attached'; } catch { toast('Couldn’t read that photo'); } };
      $('#rback', sh.el).onclick = back;
      $('#rsend', sh.el).onclick = async (e) => {
        e.target.disabled = true;
        const items = $$('[data-rq]', sh.el).map((s) => ({ i: +s.dataset.rq, qty: +s.value })).filter((x) => x.qty > 0);
        try { await api(`/orders/${id}/dispute`, { reason: $('#rr', sh.el).value, items: items.length ? items : undefined, images: imgs }); toast('Sent – the café has 7 days to respond'); sh.close(); if (location.hash === '#/o/' + id) orderView(id); }
        catch (x) { toast(x.message); e.target.disabled = false; }
      };
    } else {
      const guess = hist.filter((m) => m.role === 'user').map((m) => m.content).join(' ').slice(0, 1400);
      sh.set(H`<h2>Report a problem</h2><p class="sub">This goes to the Docket team, who will look into ${o.cafe.name}. For a refund, use “Request a refund” instead.</p>
        <textarea class="field" id="cs" rows="5" maxlength="1500" placeholder="What happened?">${guess}</textarea>
        <button class="btn" id="csubmit" style="margin-top:10px">Send to Docket</button><button class="btn sec" id="rback" style="margin-top:8px">Back</button>`);
      $('#rback', sh.el).onclick = back;
      $('#csubmit', sh.el).onclick = async (e) => {
        e.target.disabled = true;
        try { await api(`/orders/${id}/complaint`, { summary: $('#cs', sh.el).value, transcript: hist }); toast('Thanks – we’ll look into it'); sh.close(); }
        catch (x) { toast(x.message); e.target.disabled = false; }
      };
    }
  };
  function wire() {
    $('#act', sh.el).onclick = (e) => { const b = e.target.closest('[data-x]'); if (b) form(b.dataset.x); };
    const send = async () => {
      const inp = $('#cin', sh.el), t = inp.value.trim(); if (!t) return;
      inp.value = ''; hist.push({ role: 'user', content: t }); draw(true); $('#csend', sh.el).disabled = true;
      try {
        const r = await api(`/orders/${id}/support`, { messages: hist });
        hist.push({ role: 'assistant', content: r.reply || 'Sorry, I didn’t catch that.' }); draw(); acts(r.action);
      } catch (x) { hist.pop(); draw(); inp.value = t; toast(x.message); }
      $('#csend', sh.el).disabled = false;
    };
    $('#csend', sh.el).onclick = send; $('#cin', sh.el).onkeydown = (e) => { if (e.key === 'Enter') send(); };
  }
  wire(); draw(); acts();
}
async function enablePush(id, quiet) { // quiet = permission already granted earlier: just subscribe this order
  try {
    if (!quiet && await Notification.requestPermission() !== 'granted') return toast('Notifications are blocked');
    if (quiet && Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready, { vapid } = await api('/config');
    const key = Uint8Array.from(atob(vapid.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api(`/orders/${id}/push`, { sub: sub.toJSON() });
    const done = ls.get('pushed', []); ls.set('pushed', [...done, id].slice(-50));
    if (!quiet) toast("We'll keep you posted on this order");
  } catch (e) { if (!quiet) toast(e.message); }
}

// ---------- lists ----------
async function favsView() {
  setAccent();
  app.innerHTML = H`<div class="nav"><b></b></div><div class="wrap"><h1 class="large">Favourites</h1>${acct ? '' : H`<div class="banner"><span class="grow">Sign in to keep your favourites and loyalty stamps on every device.</span><button class="btn sm" data-go="#/settings" style="flex:none;white-space:nowrap">Sign in</button></div>`}<div id="favlist"></div></div>`.raw;
  const draw = (live = []) => {
    $('#favlist').innerHTML = favCafes.length ? H`<div class="group">${favCafes.map((f) => cafeRow(live.find((c) => favMatch(f, c.id, c.branchId)) || f))}</div>
      <div class="sub" style="margin-top:12px">Favourite orders are saved inside each café’s menu.</div>`.raw
      : H`<div class="empty">Tap the heart on a café to save it here. Favourite orders show up inside that café’s menu.</div>`.raw;
  };
  draw();
  const pos = ls.get('pos');
  try { const live = await api('/cafes?' + new URLSearchParams(pos ? { lat: pos.lat, lng: pos.lng } : {})); if (location.hash === '#/favs') { upgradeFavs(live); draw(live); } } catch { /* snapshots are fine */ }
}
// ---------- settings (this device) ----------
const addDefault = () => {
  const v = $('#dv').value.trim().slice(0, 40); if (!v) return;
  if (!defaults.some((d) => d.toLowerCase() === v.toLowerCase())) defaults.push(v);
  ls.set('defaults', defaults); settingsView();
};
app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'dv') addDefault(); });
function settingsView() {
  setAccent();
  app.innerHTML = H`<div class="nav"><b></b></div><div class="wrap"><h1 class="large">Settings</h1>
    <h3>Account</h3><div class="group">${acct ? H`<div class="row"><span class="grow">Signed in<div class="sub">${acct}</div></span><button data-a="signout" style="text-decoration:underline;font-weight:700">Sign out</button></div>`
      : signin ? H`<div class="row"><span class="sub">We emailed a 6-digit code to ${signin.email}.</span></div>
        <div class="row"><input id="sc" class="field" style="padding:0;background:none;letter-spacing:.3em" placeholder="000000" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button data-a="codeverify" style="text-decoration:underline;font-weight:700">Sign in</button></div>
        <button class="row sub" data-a="codeback" style="text-decoration:underline">Use a different email</button>`
      : H`<div class="row"><span class="sub">Sign in to keep favourites and loyalty stamps on every device. No password – we email you a code.</span></div>
        <div class="row"><input id="se" class="field" type="email" style="padding:0;background:none" placeholder="Email" inputmode="email" autocomplete="email"><button data-a="codesend" style="text-decoration:underline;font-weight:700">Send code</button></div>`}</div>
    <h3>Allergens</h3><div class="group"><label class="row"><span class="grow">Show allergen information<div class="sub">Shows what each dish contains and warns you about allergens you avoid.</div></span><input type="checkbox" class="sw" data-a="alon" ${allergensOn ? H`checked` : ''}></label></div>
    ${allergensOn ? H`<h3>Allergens I avoid</h3><div class="sub" style="margin-bottom:10px">Dishes containing these are flagged on every menu, and you can tell the café when you order.</div>
      <div class="chips" style="flex-wrap:wrap;overflow:visible">${ALLERGENS.map(([k, l]) => H`<button class="chip ${avoid.includes(k) ? 'on' : ''}" data-a="avk" data-k="${k}">${l}</button>`)}</div>` : ''}
    <h3>Default customisations</h3><div class="sub" style="margin-bottom:10px">Preselected whenever a drink or dish offers a matching choice, e.g. “Oat milk” or “Decaf”. You can still change them on each item.</div>
    <div class="group">${defaults.map((d, i) => H`<div class="row"><span class="grow">${d}</span><button data-a="drm" data-i="${i}" class="sub" style="text-decoration:underline">Remove</button></div>`)}
      <div class="row"><input id="dv" class="field" style="padding:0;background:none" placeholder="Add a default (e.g. Oat milk)" maxlength="40" enterkeyhint="done"><button data-a="dadd" style="text-decoration:underline;font-weight:700">Add</button></div></div>
    <div class="sub" style="margin-top:14px">Favourites and loyalty stamps are saved to your account; these settings stay on this device.</div></div>`.raw;
}
function ordersView() {
  setAccent();
  app.innerHTML = H`<div class="nav"><b></b></div><div class="wrap"><h1 class="large">Orders</h1>
    ${orders.length ? H`<div class="group">${orders.map((o) => H`<div class="row"><button class="grow chev" style="text-align:left" data-go="#/o/${o.id}"><div class="t">${o.cafe}</div>
      <div class="d">${new Date(o.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div></button><button data-a="again" data-id="${o.id}" style="text-decoration:underline;font-weight:700">Again</button></div>`)}</div>`
      : H`<div class="empty">No orders yet</div>`}</div>`.raw;
}

// Who's signed in? Pull their favourites before the first render (anything saved as a guest is merged in and uploaded).
try {
  const r = await Promise.race([api('/me'), new Promise((_, no) => setTimeout(no, 1500))]);
  if ((acct = r.email)) { favs = unionFavs(r.favs, favs); favCafes = unionCafes(r.favCafes, favCafes); if (favs.length !== r.favs.length || favCafes.length !== r.favCafes.length) syncMe(); else { ls.set('favs', favs); ls.set('favCafes', favCafes); } }
} catch { /* offline: use the cached copy */ }
route();
