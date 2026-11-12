// Plain-text kitchen ticket for thermal printers (Star CloudPRNT "text/plain"). ASCII only: most printers can't render £ or emoji.
import { allergenText } from '../public/allergens.js';

const W = 42;
const clean = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/£/g, 'GBP ').replace(/[^\x20-\x7E]/g, '');
const gbp = (p) => 'GBP ' + (p / 100).toFixed(2);
const center = (s) => { s = clean(s).slice(0, W); return ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s; };
const row = (l, r) => { l = clean(l); r = clean(r); return (l.slice(0, W - r.length - 1).padEnd(W - r.length) + r); };
const wrap = (s, indent = 0) => { const out = []; let line = ''; for (const w of clean(s).split(/\s+/)) { if ((line + ' ' + w).trim().length > W - indent) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out.map((l) => ' '.repeat(indent) + l); };

export function ticket(o, m, br, many) {
  const hr = '-'.repeat(W), dbl = '='.repeat(W), L = [];
  L.push(center(m.name + (many ? ' - ' + br.name : '')), dbl, center('ORDER ' + o.num), center((o.service === 'sitin' ? 'EAT IN' : 'TAKEAWAY') + '  |  ' + (o.asap ? 'ASAP ~' : 'PICKUP ') + o.pickup_time), dbl);
  L.push(...wrap('Name: ' + o.customer_name));
  if ((o.allergy || []).length) L.push('', '*** ALLERGY ALERT ***', ...wrap(allergenText(o.allergy).toUpperCase()), '*********************');
  L.push(hr);
  for (const i of o.items || []) {
    L.push(...wrap(`${i.qty} x ${i.name}`));
    if (i.opts?.length) L.push(...wrap(i.opts.join(', '), 4));
  }
  L.push(hr);
  if (o.discount) L.push(row('Offer' + (o.offer_code ? ' ' + o.offer_code : ''), '-' + gbp(o.discount)));
  if (o.tip) L.push(row('Tip', gbp(o.tip)));
  L.push(row('TOTAL (PAID)', gbp(o.total)), dbl, center(new Date(o.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' })), '', '', '');
  return L.join('\n');
}
