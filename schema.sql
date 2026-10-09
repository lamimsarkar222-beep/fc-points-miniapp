
create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique not null,
  username text,
  first_name text,
  display_name text,
  balance bigint not null default 0 check (balance >= 0),
  is_blocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.daily_activity (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.users(telegram_id),
  activity_date date not null default current_date,
  normal_earned integer not null default 0,
  total_earned integer not null default 0,
  daily_task_claimed boolean not null default false,
  checkin_claimed boolean not null default false,
  unique (telegram_id, activity_date)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.users(telegram_id),
  amount bigint not null,
  type text not null,
  description text,
  reference_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_telegram_id text not null references public.users(telegram_id),
  referred_telegram_id text unique not null references public.users(telegram_id),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists public.social_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  url text,
  platform text not null default 'telegram',
  channel_username text,
  reward integer not null default 0 check (reward >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.social_task_claims (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.social_tasks(id),
  telegram_id text not null references public.users(telegram_id),
  claimed_at timestamptz not null default now(),
  unique (task_id, telegram_id)
);

create table if not exists public.badges (
  badge_key text primary key,
  name text not null,
  price integer not null check (price >= 0)
);

insert into public.badges (badge_key, name, price) values
  ('blueberry', 'Blueberry', 5000),
  ('green_berry', 'Green Berry', 10000),
  ('blue_tick', 'Verified Blue Tick', 15000),
  ('black_vip', 'Black VIP', 25000)
on conflict (badge_key) do update
set name = excluded.name, price = excluded.price;

create table if not exists public.user_badges (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.users(telegram_id),
  badge_key text not null references public.badges(badge_key),
  created_at timestamptz not null default now(),
  unique (telegram_id, badge_key)
);

create table if not exists public.shop_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.users(telegram_id),
  badge_key text not null references public.badges(badge_key),
  price integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null references public.users(telegram_id),
  amount bigint not null check (amount >= 20000),
  method text not null check (method in ('bKash', 'Nagad', 'Binance')),
  account text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create table if not exists public.vip_offers (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  required_badge_key text references public.badges(badge_key),
  enabled boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vip_offer_claims (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.vip_offers(id),
  telegram_id text not null references public.users(telegram_id),
  claimed_at timestamptz not null default now(),
  unique (offer_id, telegram_id)
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_logs (
  id uuid primary key default gen_random_uuid(),
  admin_telegram_id text not null,
  target_telegram_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_transactions_user
  on public.transactions (telegram_id, created_at desc);

create index if not exists idx_withdrawals_status
  on public.withdrawals (status, created_at desc);

create index if not exists idx_shop_requests_status
  on public.shop_requests (status, created_at desc);

create index if not exists idx_social_tasks_enabled
  on public.social_tasks (enabled, created_at desc);

create index if not exists idx_daily_activity_date
  on public.daily_activity (activity_date, telegram_id);

alter table public.users enable row level security;
alter table public.daily_activity enable row level security;
alter table public.transactions enable row level security;
alter table public.referrals enable row level security;
alter table public.social_tasks enable row level security;
alter table public.social_task_claims enable row level security;
alter table public.badges enable row level security;
alter table public.user_badges enable row level security;
alter table public.shop_requests enable row level security;
alter table public.withdrawals enable row level security;
alter table public.vip_offers enable row level security;
alter table public.vip_offer_claims enable row level security;
alter table public.app_settings enable row level security;
alter table public.admin_logs enable row level security;

-- Access to these tables is intended to go through the backend service role.
-- Never expose SUPABASE_SERVICE_ROLE_KEY in frontend code.
