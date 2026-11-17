-- Landscape: accounts, sign-in codes, sessions, credits and search jobs — on Neon (Postgres).
-- The API applies this file itself on first use (every statement is idempotent), so you never
-- have to run it by hand. Kept here so you can read what the database holds.

create table if not exists profiles (
  user_id uuid primary key default gen_random_uuid(),
  email text not null unique,
  plan text not null default 'free',            -- free | starter | pro | max
  credits integer not null default 0,           -- 1 credit = 1 parcel record with owner data
  stripe_customer_id text,
  stripe_subscription_id text,
  renews_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_sub_idx on profiles (stripe_subscription_id);
create index if not exists profiles_customer_idx on profiles (stripe_customer_id);

-- Sign-in: a 6-digit code emailed to the address, good for 10 minutes, 5 tries.
create table if not exists login_codes (
  id bigserial primary key,
  email text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists login_codes_email_idx on login_codes (email, created_at desc);

-- A verified sign-in becomes a session token the app keeps (hashed here), good for 90 days.
create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists credit_ledger (
  id bigserial primary key,
  user_id uuid not null references profiles(user_id) on delete cascade,
  delta integer not null,                       -- + bought / refunded, - spent
  reason text not null,
  ref text,                                     -- Stripe event id or search reference
  created_at timestamptz not null default now()
);
-- A Stripe event delivered twice must not credit twice.
create unique index if not exists credit_ledger_ref_unique on credit_ledger (ref) where ref like 'evt_%';

-- A nationwide search is a background job: credits are reserved at start and settled when it finishes.
create table if not exists searches (
  id bigserial primary key,
  user_id uuid not null references profiles(user_id) on delete cascade,
  kind text not null default 'export',
  run_id text,
  dataset_id text,
  status text not null default 'running',       -- running | done | failed
  reserved integer not null default 0,
  records integer not null default 0,
  ref text,
  params jsonb,
  result jsonb,
  notice text,
  created_at timestamptz not null default now()
);
create index if not exists searches_user_status_idx on searches (user_id, status);

-- Spend atomically: fails (ok=false) instead of going negative.
create or replace function spend_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql as $$
declare cur integer;
begin
  select p.credits into cur from profiles p where p.user_id = p_user for update;
  if cur is null then return query select false, 0; return; end if;
  if cur < p_amount then return query select false, cur; return; end if;
  update profiles set credits = profiles.credits - p_amount, updated_at = now() where user_id = p_user;
  insert into credit_ledger (user_id, delta, reason, ref) values (p_user, -p_amount, p_reason, p_ref);
  return query select true, cur - p_amount;
end $$;

create or replace function add_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql as $$
begin
  begin
    insert into credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount, p_reason, p_ref);
  exception when unique_violation then
    return query select false, (select p.credits from profiles p where p.user_id = p_user); return;
  end;
  update profiles set credits = profiles.credits + p_amount, updated_at = now() where user_id = p_user;
  return query select true, (select p.credits from profiles p where p.user_id = p_user);
end $$;

-- Monthly reset for subscribers: credits become the plan allowance (no rollover).
create or replace function set_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql as $$
declare cur integer;
begin
  select p.credits into cur from profiles p where p.user_id = p_user for update;
  begin
    insert into credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount - coalesce(cur, 0), p_reason, p_ref);
  exception when unique_violation then
    return query select false, cur; return;
  end;
  update profiles set credits = p_amount, updated_at = now() where user_id = p_user;
  return query select true, p_amount;
end $$;
