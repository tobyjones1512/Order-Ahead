import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL || '');

const SCHEMA = [
  `create table if not exists merchants (
    id serial primary key, email text unique not null,
    name text not null, address text default '', postcode text not null, lat float8, lng float8,
    logo text, color text default '#0a84ff',
    vat_registered bool default false, vat_number text default '',
    prep_minutes int default 10, extra_minutes int default 0, paused bool default false,
    open_time text default '07:00', close_time text default '17:00',
    mollie_access text, mollie_refresh text, mollie_expires timestamptz, mollie_profile text)`,
  `create table if not exists categories (
    id serial primary key, merchant_id int not null, name text not null, sort int default 0,
    from_time text, to_time text, days int[] default '{0,1,2,3,4,5,6}')`,
  `create table if not exists items (
    id serial primary key, merchant_id int not null, category_id int, name text not null,
    description text default '', price_pence int not null, available bool default true, options jsonb default '[]')`,
  `create table if not exists orders (
    id uuid primary key default gen_random_uuid(), num serial, merchant_id int not null,
    status text not null, customer_name text, customer_email text,
    pickup_time text, asap bool, items jsonb, subtotal int, tip int, vat int, total int, fee int,
    payment_id text, push_sub jsonb, created_at timestamptz default now())`,
  `alter table merchants drop column if exists pw`,
  `alter table items add column if not exists allergens jsonb default '[]'`,
  `create table if not exists branches (
    id serial primary key, merchant_id int not null, name text not null default 'Main', address text default '', postcode text default '',
    lat float8, lng float8, open_time text default '07:00', close_time text default '17:00',
    prep_minutes int default 10, extra_minutes int default 0, paused bool default false, sort int default 0)`,
  `alter table orders add column if not exists branch_id int`,
  `create table if not exists merchant_push (endpoint text primary key, merchant_id int not null, branch_id int, sub jsonb not null)`, // kitchen devices that get new-order alerts (branch_id null = all branches)
  `create table if not exists branch_off (branch_id int not null, kind text not null, ref_id int not null, primary key (branch_id, kind, ref_id))`, // items/categories a branch does NOT sell
  // every café account gets one branch (copied from its old single-location settings); existing orders are attached to it
  `insert into branches (merchant_id,name,address,postcode,lat,lng,open_time,close_time,prep_minutes,extra_minutes,paused)
    select id,'Main',address,postcode,lat,lng,open_time,close_time,prep_minutes,extra_minutes,paused from merchants m where not exists (select 1 from branches b where b.merchant_id=m.id)`,
  `update orders o set branch_id=(select min(id) from branches b where b.merchant_id=o.merchant_id) where branch_id is null`,
  // order numbers are 6-digit and random; re-number any old sequential ones once
  `update orders set num = 100000 + (abs(hashtext(id::text)) % 900000) where num < 100000`,
  `alter table orders add column if not exists updated_at timestamptz`,
  `update orders set updated_at=created_at where updated_at is null`,
  `alter table orders alter column updated_at set default now()`,
  `create table if not exists wallet_regs (device text not null, order_id uuid not null, push_token text not null, primary key (device, order_id))`,
  `alter table merchants add column if not exists referral_code text, add column if not exists referred_by int, add column if not exists reduced_until timestamptz,
    add column if not exists allow_sitin bool default true, add column if not exists created_at timestamptz default now(), add column if not exists first_paid bool default false, add column if not exists loyalty jsonb`,
  `update merchants set referral_code = upper(substr(md5(random()::text || id::text),1,6)) where referral_code is null`,
  `create unique index if not exists merchants_ref on merchants (referral_code)`,
  `update merchants m set first_paid=true where not first_paid and exists (select 1 from orders o where o.merchant_id=m.id and o.status in ('pending','accepted','ready','completed'))`,
  `alter table branches add column if not exists fhrs_id int, add column if not exists fhrs_name text, add column if not exists fhrs_rating text, add column if not exists fhrs_date text,
    add column if not exists fhrs_checked timestamptz, add column if not exists printer_token text, add column if not exists printer_on bool default false`,
  `create table if not exists branch_closures (id serial primary key, merchant_id int not null, branch_id int not null, from_date text not null, to_date text not null,
    kind text not null default 'closed', open_time text, close_time text, note text default '')`,
  `alter table items add column if not exists dietary jsonb default '[]'`,
  `alter table orders add column if not exists service text default 'takeaway', add column if not exists allergy jsonb default '[]', add column if not exists discount int default 0,
    add column if not exists offer_code text, add column if not exists reward_used bool default false, add column if not exists printed_at timestamptz, add column if not exists stamped bool default false`,
  `create table if not exists offers (id serial primary key, merchant_id int not null, code text not null, kind text not null, value int not null, min_spend int default 0,
    max_uses int, used int default 0, expires_at timestamptz, active bool default true, unique (merchant_id, code))`,
  `create table if not exists loyalty (merchant_id int not null, email text not null, stamps int not null default 0, primary key (merchant_id, email))`,
  `create table if not exists reviews (order_id uuid primary key, merchant_id int not null, branch_id int, stars int not null, comment text default '', created_at timestamptz default now())`,
  `create table if not exists referrals (referred int primary key, referrer int not null, granted_at timestamptz default now())`,
  `alter table orders add column if not exists account text, add column if not exists stamps_earned int default 0`,
  `alter table merchants add column if not exists terms_at timestamptz, add column if not exists terms_version text`,
  `create table if not exists customers (email text primary key, favs jsonb not null default '[]', fav_cafes jsonb not null default '[]', updated_at timestamptz default now())`,
  `create table if not exists customer_codes (email text primary key, code_hash text not null, expires_at timestamptz not null, tries int not null default 0, sent_at timestamptz not null default now())`,
  `alter table merchants add column if not exists pass_fee bool default false, add column if not exists test_mode bool default false`,
  `alter table orders add column if not exists test bool default false, add column if not exists alert_at timestamptz, add column if not exists alerted bool default false,
    add column if not exists refunded int default 0, add column if not exists refunded_items jsonb default '{}'`,
  `create table if not exists disputes (id uuid primary key default gen_random_uuid(), order_id uuid not null, merchant_id int not null, status text not null default 'open', reason text not null,
    items jsonb, created_at timestamptz default now(), due_at timestamptz not null, responded_at timestamptz, resolved_at timestamptz)`,
  `create index if not exists disputes_m on disputes (merchant_id, status)`,
  `create table if not exists dispute_msgs (id serial primary key, dispute_id uuid not null, who text not null, body text default '', imgs jsonb default '[]', created_at timestamptz default now())`,
  `create table if not exists dispute_imgs (id serial primary key, dispute_id uuid not null, data text not null)`,
  `create table if not exists complaints (id serial primary key, order_id uuid, merchant_id int, cafe_name text, customer_name text, customer_email text, summary text, transcript jsonb,
    status text default 'new', created_at timestamptz default now())`,
  `alter table merchants add column if not exists fee_pct numeric`, // admin override of the platform fee (percent) for one café; null = standard/reduced rate
  `alter table merchants add column if not exists logo_pending text`,
  `alter table dispute_imgs add column if not exists status text not null default 'clean'`,
  `create table if not exists scan_queue (id serial primary key, kind text not null, ref text not null, sha256 text not null, mime text default '', data text, status text not null default 'queued', analysis_id text, created_at timestamptz default now(), started_at timestamptz, polled_at timestamptz, done_at timestamptz)`,
  `create index if not exists scan_queue_s on scan_queue (status, id)`,
  `create table if not exists scanned_files (sha256 text primary key, verdict text not null, malicious int default 0, suspicious int default 0, at timestamptz default now())`,
  `create table if not exists support_threads (id text primary key, email text not null, name text, subject text not null, status text not null default 'open', escalated bool not null default false, reason text, bot_replies int not null default 0, created_at timestamptz default now(), updated_at timestamptz default now())`,
  `create table if not exists support_msgs (id serial primary key, thread_id text not null, key text unique, dir text not null, by text not null, body text not null default '', msg_id text, files jsonb not null default '[]', created_at timestamptz default now())`,
  `create index if not exists support_msgs_t on support_msgs (thread_id, id)`,
  `create index if not exists orders_m on orders (merchant_id, status)`,
  `create index if not exists orders_mc on orders (merchant_id, created_at)`,
];

let ready;
// ponytail: auto-migrate on cold start; swap for real migrations once the schema starts changing.
export const init = () => (ready ??= (async () => { for (const q of SCHEMA) await sql.query(q); })().catch((e) => { ready = null; throw e; }));
