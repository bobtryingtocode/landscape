-- Landscape: accounts, credits and search log.
-- Run once in Supabase (SQL editor) or via `supabase db push`. The API uses the service role key, so
-- row-level security locks these tables away from the browser entirely.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'free',            -- free | starter | pro | max
  credits integer not null default 0,           -- 1 credit = 1 parcel record with owner data
  stripe_customer_id text,
  stripe_subscription_id text,
  renews_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_sub_idx on public.profiles (stripe_subscription_id);
create index if not exists profiles_customer_idx on public.profiles (stripe_customer_id);

create table if not exists public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  delta integer not null,                       -- + bought / refunded, - spent
  reason text not null,
  ref text,                                     -- Stripe event id or search reference
  created_at timestamptz not null default now()
);
-- A Stripe event delivered twice must not credit twice.
create unique index if not exists credit_ledger_ref_unique on public.credit_ledger (ref) where ref like 'evt_%';

-- A nationwide search is a background job: credits are reserved at start and settled when it finishes.
create table if not exists public.searches (
  id bigserial primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  kind text not null default 'export',          -- export | lookup
  run_id text,                                  -- Apify run id
  dataset_id text,
  status text not null default 'running',       -- running | done | failed
  reserved integer not null default 0,          -- credits held while it runs
  records integer not null default 0,           -- credits actually charged
  ref text,
  params jsonb,
  result jsonb,                                 -- the mapped parcels, so a refreshed page can re-read them
  notice text,
  created_at timestamptz not null default now()
);
create index if not exists searches_user_status_idx on public.searches (user_id, status);

alter table public.profiles enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.searches enable row level security;
-- No policies on purpose: only the service role (the Vercel API) reads or writes these.

-- Spend atomically: fails (ok=false) instead of going negative.
create or replace function public.spend_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql security definer as $$
declare cur integer;
begin
  select p.credits into cur from public.profiles p where p.user_id = p_user for update;
  if cur is null then return query select false, 0; return; end if;
  if cur < p_amount then return query select false, cur; return; end if;
  update public.profiles set credits = credits - p_amount, updated_at = now() where user_id = p_user;
  insert into public.credit_ledger (user_id, delta, reason, ref) values (p_user, -p_amount, p_reason, p_ref);
  return query select true, cur - p_amount;
end $$;

create or replace function public.add_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql security definer as $$
begin
  begin
    insert into public.credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount, p_reason, p_ref);
  exception when unique_violation then
    return query select false, (select p.credits from public.profiles p where p.user_id = p_user); return;
  end;
  update public.profiles set credits = credits + p_amount, updated_at = now() where user_id = p_user;
  return query select true, (select p.credits from public.profiles p where p.user_id = p_user);
end $$;

-- Monthly reset for subscribers: credits become the plan allowance (no rollover).
create or replace function public.set_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns table (ok boolean, credits integer) language plpgsql security definer as $$
declare cur integer;
begin
  select p.credits into cur from public.profiles p where p.user_id = p_user for update;
  begin
    insert into public.credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount - coalesce(cur, 0), p_reason, p_ref);
  exception when unique_violation then
    return query select false, cur; return;
  end;
  update public.profiles set credits = p_amount, updated_at = now() where user_id = p_user;
  return query select true, p_amount;
end $$;

revoke all on function public.spend_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.set_credits(uuid, integer, text, text) from public, anon, authenticated;
