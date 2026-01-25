-- Supabase/Postgres schema for delivery ratings

drop table if exists public.delivery_ratings cascade;

create table public.delivery_ratings (
  id bigserial primary key,
  order_id uuid not null,
  delivery_id text,
  customer_pi_username text not null,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

create index delivery_ratings_order_idx
  on public.delivery_ratings (order_id, created_at desc);

create index delivery_ratings_delivery_idx
  on public.delivery_ratings (delivery_id, created_at desc);

alter table public.delivery_ratings enable row level security;

create policy "delivery_ratings_select"
  on public.delivery_ratings for select
  to anon, authenticated
  using (true);

create policy "delivery_ratings_insert"
  on public.delivery_ratings for insert
  to anon, authenticated
  with check (true);
