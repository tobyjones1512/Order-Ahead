// Shared by browser and server. All times are Europe/London "HH:MM" for *today* (ponytail: no multi-day pre-orders).
export const FEE_RATE = 0.05, REDUCED_FEE_RATE = 0.025, VAT_RATE = 0.2; // reduced rate applies while a café has a referral reward

export function londonNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), mins: +p.hour * 60 + +p.minute };
}
export const toMins = (t) => { const [h, m] = t.split(':'); return +h * 60 + +m; };
export const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function catAvailable(c, dow, mins) {
  if (c.days && !c.days.includes(dow)) return false;
  if (c.from_time && mins < toMins(c.from_time)) return false;
  if (c.to_time && mins >= toMins(c.to_time)) return false;
  return true;
}

// asap: dynamic from prep time + rush "extra" minutes. slots: 15-minute pickup windows (start times).
export function slots(m, now = londonNow()) {
  const open = toMins(m.open_time), close = toMins(m.close_time);
  const ready = now.mins + m.prep_minutes + m.extra_minutes;
  const list = [];
  for (let t = Math.ceil(Math.max(ready, open) / 15) * 15; t + 15 <= close; t += 15) list.push(fmt(t));
  return { asap: now.mins >= open && ready <= close ? fmt(ready) : null, slots: list };
}

export function priceLine(item, sel = {}) {
  let unit = item.price_pence; const names = [];
  item.options.forEach((g, gi) => {
    const picks = (sel[gi] || []).map(Number);
    if (new Set(picks).size !== picks.length || (!g.multi && picks.length !== 1)) throw new Error(`Choose ${g.name}`);
    for (const ci of picks) {
      const c = Number.isInteger(ci) && g.choices[ci];
      if (!c) throw new Error('Invalid option');
      unit += c.price; names.push(c.name);
    }
  });
  return { unit, names };
}

// Prices are VAT-inclusive (UK norm); tips are not VATable. Platform fee = 5% of everything paid (so 5% of the tip too),
// deducted from the merchant's payout – never added to the customer's total.
export function totals(subtotal, tipPct, vatRegistered, tipPence = null, rate = FEE_RATE) { // tipPence = custom £ amount, overrides the percentage
  const tip = tipPence ?? Math.round(subtotal * tipPct / 100), total = subtotal + tip;
  return { tip, total, fee: Math.round(total * rate), vat: vatRegistered ? Math.round(subtotal * VAT_RATE / (1 + VAT_RATE)) : 0 };
}

// Offer codes and loyalty rewards reduce the basket (never the tip). kind: 'percent' (value = %) or 'fixed' (value = pence); cap = max pence off (0 = none).
export function discountFor(kind, value, subtotal, cap = 0) {
  const d = kind === 'percent' ? Math.round(subtotal * Math.min(value, 100) / 100) : value;
  return Math.max(0, Math.min(subtotal, cap ? Math.min(d, cap) : d));
}

// "Off-hand service fee to customer": raise a price so the café still receives the full amount after the platform fee (rounded up to the penny).
export const gross = (pence, rate = FEE_RATE) => Math.ceil(pence / (1 - rate));

// Amount (pence) to refund when pick = [{ i, qty }] items of order o are refunded; `all` = this clears the order, so refund everything left (tip included).
// Item refunds are scaled by any discount the order had, and never exceed what's still refundable.
export function refundAmount(o, pick, all) {
  const left = o.total - (o.refunded || 0);
  if (all) return left;
  const lines = pick.reduce((n, x) => n + o.items[x.i].unit * x.qty, 0), f = o.subtotal > 0 ? (o.subtotal - (o.discount || 0)) / o.subtotal : 1;
  return Math.max(0, Math.min(Math.round(lines * f), left));
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('pricing.js')) {
  const assert = (await import('node:assert')).strict;
  const s = slots({ prep_minutes: 10, extra_minutes: 0, open_time: '07:00', close_time: '09:00' }, { dow: 1, mins: 425 });
  assert.equal(s.asap, '07:15'); assert.equal(s.slots[0], '07:15'); assert.equal(s.slots.at(-1), '08:45');
  assert.equal(slots({ prep_minutes: 10, extra_minutes: 10, open_time: '07:00', close_time: '09:00' }, { dow: 1, mins: 425 }).asap, '07:25');
  assert.equal(slots({ prep_minutes: 10, extra_minutes: 0, open_time: '07:00', close_time: '09:00' }, { dow: 1, mins: 300 }).asap, null);
  assert.deepEqual(totals(400, 5, true), { tip: 20, total: 420, fee: 21, vat: 67 });
  assert.equal(totals(400, 0, false).vat, 0);
  assert.deepEqual(totals(400, 5, false, 150), { tip: 150, total: 550, fee: 28, vat: 0 });
  assert.equal(totals(400, 0, false, null, 0.025).fee, 10);
  assert.equal(discountFor('percent', 10, 450), 45); assert.equal(discountFor('fixed', 500, 300), 300); assert.equal(discountFor('percent', 100, 800, 500), 500);
  assert.equal(catAvailable({ to_time: '11:00', days: [1] }, 1, 600), true);
  assert.equal(catAvailable({ to_time: '11:00', days: [1] }, 1, 660), false);
  assert.equal(catAvailable({ days: [1] }, 2, 600), false);
  const it = { price_pence: 300, options: [{ name: 'Milk', multi: false, choices: [{ name: 'Whole', price: 0 }, { name: 'Oat', price: 50 }] }, { name: 'X', multi: true, choices: [{ name: 'Shot', price: 60 }] }] };
  assert.equal(priceLine(it, { 0: [1], 1: [0] }).unit, 410);
  assert.throws(() => priceLine(it, {}));
  assert.equal(gross(100), 106); assert.equal(gross(0), 0); assert.equal(gross(100, 0.025), 103); assert.ok(Math.round(gross(350) * 0.95) >= 350);
  const ord = { items: [{ unit: 300, qty: 2 }, { unit: 400, qty: 1 }], subtotal: 1000, discount: 100, total: 925, tip: 25, refunded: 0 };
  assert.equal(refundAmount(ord, [{ i: 1, qty: 1 }], false), 360); assert.equal(refundAmount(ord, [], true), 925);
  assert.equal(refundAmount({ ...ord, refunded: 900 }, [{ i: 1, qty: 1 }], false), 25); assert.equal(refundAmount({ ...ord, discount: 0 }, [{ i: 0, qty: 1 }], false), 300);
  console.log('pricing ok');
}
