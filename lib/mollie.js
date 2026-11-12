import { sql } from './db.js';

const { BASE_URL, MOLLIE_CLIENT_ID: ID, MOLLIE_CLIENT_SECRET: SECRET } = process.env;
export const TEST = process.env.MOLLIE_TESTMODE !== 'false';
export const amt = (p) => ({ currency: 'GBP', value: (p / 100).toFixed(2) });

const fail = (j) => Object.assign(new Error(j.detail || j.error_description || 'Payment provider error'), { status: 400, mollie: j });

export const authUrl = (state) => 'https://my.mollie.com/oauth2/authorize?' + new URLSearchParams({
  client_id: ID, redirect_uri: `${BASE_URL}/api/mollie/callback`, response_type: 'code', state, approval_prompt: 'auto',
  scope: 'payments.read payments.write refunds.write profiles.read onboarding.read organizations.read',
});

async function tokens(params) {
  const r = await fetch('https://api.mollie.com/oauth2/tokens', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json();
  if (!r.ok) throw fail(j);
  return j;
}

export const exchange = (code) => tokens({ grant_type: 'authorization_code', code, redirect_uri: `${BASE_URL}/api/mollie/callback` });

export const saveTokens = (id, t) => sql`update merchants set mollie_access=${t.access_token},
  mollie_refresh=coalesce(${t.refresh_token || null}, mollie_refresh), mollie_expires=now() + ${t.expires_in - 60} * interval '1 second' where id=${id}`;

async function accessToken(m) {
  if (new Date(m.mollie_expires) > new Date()) return m.mollie_access;
  const t = await tokens({ grant_type: 'refresh_token', refresh_token: m.mollie_refresh });
  await saveTokens(m.id, t);
  return t.access_token;
}

// Call Mollie *as the merchant* (Mollie Connect) so funds settle to them and applicationFee goes to the platform.
export async function api(m, path, { method = 'GET', body, token } = {}) {
  if (TEST && method === 'GET' && path.startsWith('/payments')) path += (path.includes('?') ? '&' : '?') + 'testmode=true';
  const r = await fetch('https://api.mollie.com/v2' + path, {
    method,
    headers: { Authorization: 'Bearer ' + (token || await accessToken(m)), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { console.error('mollie', path, j); throw fail(j); }
  return j;
}
