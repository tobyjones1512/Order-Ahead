// Tiny helpers shared by both apps. H`` auto-escapes interpolations (merchant text is untrusted); nest H`` results freely.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(val).join('') : v.raw !== undefined ? v.raw : esc(v));
export const H = (s, ...v) => ({ raw: s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), '') });
// Star rating as SVG (the pixel fonts have no ★ glyph and fall back to an asterisk). n may be fractional-free 0–5.
export const stars = (n) => ({ raw: `<span class="stars" role="img" aria-label="${n} out of 5 stars">${[1, 2, 3, 4, 5].map((i) => `<svg viewBox="0 0 24 24" class="${i <= Math.round(n) ? 'f' : ''}"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"/></svg>`).join('')}</span>` });
export const gbp = (p) => '£' + (p / 100).toFixed(2);
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export async function api(path, body, method) {
  const r = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong'), { status: r.status });
  return j;
}

export function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(t); requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

// Bottom sheet. Returns {el, close, set(html)}; clicks inside are handled by caller via el.addEventListener.
export function sheet(content) {
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = `<div class="sheet"><div class="grab"></div><div class="sbody">${content.raw}</div></div>`;
  document.body.append(el); requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  return { el, close, set: (c) => { el.querySelector('.sbody').innerHTML = c.raw; } };
}

export const loadScript = (src) => new Promise((ok, no) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  document.head.append(Object.assign(document.createElement('script'), { src, onload: ok, onerror: no }));
});

export const registerSW = () => 'serviceWorker' in navigator && navigator.serviceWorker.register('/sw.js');

// Sets the café colour and picks a readable text colour for it (WCAG luminance).
const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const lum = (c) => { const [R, G, B] = [1, 3, 5].map((i) => lin(parseInt(c.slice(i, i + 2), 16) / 255)); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const onColor = (c) => (contrast(c, '#ffffff') >= contrast(c, '#14161b') ? '#ffffff' : '#14161B'); // whichever text colour reads best
// Controls on white docket paper need 3:1 to stand out: keep the hue, darken until they do. The exact brand colour still paints the café header band.
export function accentFor(c) {
  let k = 0, out = c;
  while (contrast(out, '#FBFBF8') < 3 && k < 0.9) { k += 0.03; out = '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * (1 - k)).toString(16).padStart(2, '0')).join(''); }
  return out;
}
export function setAccent(c) {
  const r = document.documentElement.style;
  if (!/^#[0-9a-f]{6}$/i.test(c || '')) { ['--accent', '--on-accent', '--brand', '--on-brand'].forEach((v) => r.removeProperty(v)); return; }
  const a = accentFor(c);
  r.setProperty('--brand', c); r.setProperty('--on-brand', onColor(c)); r.setProperty('--accent', a); r.setProperty('--on-accent', onColor(a));
}

// Decorative docket barcode, bar widths derived from the text so each order has its own.
export function barcode(s) {
  let x = 0, bars = '';
  for (const ch of `*${s}*`) {
    const c = ch.charCodeAt(0);
    for (let k = 0; k < 6; k++) { const w = ((c >> k) & 3) + 1; if (k % 2 === 0) bars += `<rect x="${x}" width="${w}" height="40"/>`; x += w; }
    x += 3;
  }
  return { raw: `<svg class="barcode" viewBox="0 0 ${x} 40" preserveAspectRatio="none" aria-hidden="true" fill="currentColor">${bars}</svg>` };
}

// Resize a chosen photo to a small JPEG data URL (evidence for disputes)
export async function toPhoto(file) {
  const img = await createImageBitmap(file), k = Math.min(1, 1100 / Math.max(img.width, img.height));
  const cv = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.72);
}
