# Order Ahead

Customer PWA at `/`, kitchen/merchant dashboard at `/m/`, one serverless function (`api/[...path].js`), Neon Postgres.

## Deploy
1. `npm i -g vercel && vercel` (add **Neon** from Vercel → Storage; it sets `DATABASE_URL`. Tables auto-create on first request).
2. `npm run keys` → VAPID keys. Set env vars (Vercel → Settings → Environment Variables):

| Var | Value |
|---|---|
| `BASE_URL` | `https://your-domain` (no trailing slash) |
| `SESSION_SECRET` | long random string |
| `MOLLIE_CLIENT_ID` / `MOLLIE_CLIENT_SECRET` | your Mollie **Connect** app (redirect URI: `BASE_URL/api/mollie/callback`) |
| `MOLLIE_TESTMODE` | `true` until live (set `false` for production) |
| `RESEND_API_KEY` / `EMAIL_FROM` | Resend key + verified sender, e.g. `Order Ahead <orders@yourdomain>` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | from step 2 |
| `SUPPORT_API_KEY` | key for the customer support chat (OpenAI-compatible API at `api.pawan.krd`, model `openai/gpt-oss-20b`; override with `SUPPORT_API_URL` / `SUPPORT_MODEL`) |
| `CRON_SECRET` | any random string; lets you ping `/api/cron/housekeeping?key=…` every minute (e.g. cron-job.org) so scheduled-order alerts and 7-day dispute refunds fire with no device open |

3. Apple Pay: enable it in your Mollie dashboard and verify `BASE_URL`'s domain (host the Apple file Mollie gives you under `public/.well-known/`).
4. Merchants register at `/m/`, connect Mollie, add a menu. Cafés appear to customers once Mollie is connected.

## Money model
Menu prices are VAT-inclusive and what the customer pays (+ optional tip, default 5%). No surcharge.
The platform fee is 5% of the total paid (food and tip), sent as a Mollie `applicationFee` and deducted from the merchant's settlement.

## Refunds, disputes & support
- Merchants tap **Refund…** on an order to refund chosen items or everything left, from their Mollie balance. Application fees are non-refundable, so your 5% is kept and the merchant absorbs it.
- Customers get a **Support** button on completed orders (AI chat). Refund requests (with optional photos) go to the café's **Disputes** tab; no reply in 7 days means an automatic refund. Café complaints go to the admin dashboard (`/admin/`, linked from the merchant Settings page for admin emails).
- Scheduled orders alert the kitchen at pickup time minus prep time. Merchants can enable *Test mode* (fake orders, no payment) and *Off-hand service fee* (prices raised so they receive the full menu price).

## Domains (placemyorder.online)
- `placemyorder.online` (and `www`): the landing page, `public/site/index.html`, served by the same Vercel project (host rewrite in `vercel.json`). DNS: A `@` → `76.76.21.21`, CNAME `www` → `cname.vercel-dns.com`.
- `app.placemyorder.online` (customers), `merchant.placemyorder.online` (kitchen app), `admin.placemyorder.online` (admin + `/escalations/` desk): all three are domains on the one Vercel project; `vercel.json` serves the right app at `/` per host.
- Env: `BASE_URL=https://app.placemyorder.online`, `MERCHANT_URL=https://merchant.placemyorder.online`, `ADMIN_URL=https://admin.placemyorder.online`, `COOKIE_DOMAIN=.placemyorder.online` (shares the café sign-in with the admin site), `EMAIL_FROM=Docket <orders@placemyorder.online>`.

## Merchant support desk (merchantsupport@placemyorder.online)
Resend receives the email and calls `/api/support-inbound` (webhook `email.received`, signing secret in `RESEND_WEBHOOK_SECRET`). The AI (`SUPPORT_API_KEY`) answers from the knowledge base in `lib/desk.js`. It escalates to `hello@thecaffeinemediacompany.com` when the merchant replies twice, or the AI can't help; escalated chains are answered from `admin.placemyorder.online/escalations/`.

## File safety
Logos, dispute photos and email attachments are checked with VirusTotal (`VIRUSTOTAL_API_KEY`) before they are stored. Without the key uploads are allowed and a warning is logged.
