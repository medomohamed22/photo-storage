-- Supabase/Postgres schema for delivery wallet + withdrawals

create table if not exists public.delivery_wallet (
  delivery_id text primary key,
  balance_pi numeric(20, 6) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.withdrawals (
  id bigserial primary key,
  delivery_id text not null,
  username text,
  amount numeric(20, 6) not null check (amount > 0),
  wallet_address text not null,
  txid text,
  created_at timestamptz not null default now()
);

create index if not exists withdrawals_delivery_id_idx
  on public.withdrawals (delivery_id, created_at desc);

create table if not exists public.withdraw_requests (
  id bigserial primary key,
  delivery_id text not null,
  amount_pi numeric(20, 6) not null check (amount_pi > 0),
  wallet_address text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists withdraw_requests_delivery_id_idx
  on public.withdraw_requests (delivery_id, status, created_at desc);
