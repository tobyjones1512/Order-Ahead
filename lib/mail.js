// Branded HTML email shell – the "thermal docket" look: grey ground, paper receipt, mono type, dashed rules, café-colour stamp.
// Tables + inline styles only (email clients ignore most CSS); emails stay light in every client so the paper never inverts.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const onColor = (h) => (lum(h) > 0.4 ? '#14161B' : '#FFFFFF');
const MONO = "'Courier New',Courier,ui-monospace,Menlo,monospace";
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#2B39F0');

// opts: { cafe:{name,color}, kicker, title, preheader, body (html), stamp, cta:{label,url}, base }
export function layout({ cafe, kicker, title, preheader = '', body, stamp, cta, base = '', platform = false }) {
  const brand = hex(cafe.color), on = onColor(brand);
  const teeth = `<div style="height:8px;line-height:8px;font-size:0;background:linear-gradient(135deg,#CDD3DC 4px,transparent 0) 0 0/8px 8px,linear-gradient(225deg,#CDD3DC 4px,transparent 0) 0 0/8px 8px;background-color:#FBFBF8">&nbsp;</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#CDD3DC;color:#14161B">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#CDD3DC"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 4px 12px;font:700 12px ${MONO};letter-spacing:.18em;text-transform:uppercase;color:#14161B">Docket${kicker ? ' &middot; ' + esc(kicker) : ''}</td></tr>
<tr><td style="background:${brand};color:${on};padding:20px 20px 18px;font:900 26px/1.1 ${MONO};letter-spacing:.02em;text-transform:uppercase;border-radius:6px 6px 0 0">${esc(cafe.name)}</td></tr>
<tr><td style="background:#FBFBF8;color:#14161B;padding:22px 20px;font:15px/1.55 ${MONO}">
${stamp ? `<div style="margin:0 0 16px"><span style="display:inline-block;border:3px solid ${brand};color:#14161B;padding:4px 12px;font:900 15px ${MONO};letter-spacing:.2em;text-transform:uppercase;transform:rotate(-3deg)">${esc(stamp)}</span></div>` : ''}
<div style="font:700 19px/1.3 ${MONO};margin:0 0 12px">${esc(title)}</div>
${body}
${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${brand};border-radius:8px"><a href="${esc(cta.url)}" style="display:inline-block;padding:14px 22px;font:700 14px ${MONO};letter-spacing:.08em;text-transform:uppercase;color:${on};text-decoration:none">${esc(cta.label)}</a></td></tr></table>` : ''}
</td></tr>
<tr><td>${teeth}</td></tr>
<tr><td align="center" style="padding:14px 8px;font:12px/1.5 ${MONO};color:#4A505C">${platform ? 'Sent by Docket.' : `Sent by Docket on behalf of ${esc(cafe.name)}.`}${base ? ` <a href="${esc(base)}" style="color:#4A505C">${esc(base.replace(/^https?:\/\//, ''))}</a>` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

const rule = 'border-top:1px dashed #14161B';
// rows: [[label, value, {bold, small}]] – dot leaders like the on-screen receipt
export const rows = (r) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0">${r.map(([l, v, o = {}], i) =>
  `<tr><td style="padding:6px 0;${i && o.rule ? rule + ';' : ''}font:${o.bold ? 700 : 400} ${o.small ? 13 : 15}px/1.4 ${MONO};color:#14161B">${l}</td><td align="right" style="padding:6px 0 6px 12px;${i && o.rule ? rule + ';' : ''}font:${o.bold ? 700 : 400} ${o.small ? 13 : 15}px/1.4 ${MONO};color:#14161B;white-space:nowrap">${v}</td></tr>`).join('')}</table>`;
export const para = (t) => `<p style="margin:0 0 12px;font:15px/1.55 ${MONO};color:#14161B">${t}</p>`;
export const small = (t) => `<p style="margin:12px 0 0;font:13px/1.5 ${MONO};color:#4A505C">${t}</p>`;
