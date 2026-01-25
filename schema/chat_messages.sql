-- Supabase/Postgres schema for chat messages

drop table if exists public.chat_messages cascade;

create table public.chat_messages (
  id bigserial primary key,
  order_id uuid not null,
  sender text not null check (sender in ('customer','delivery')),
  message_text text,
  image_url text,
  seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index chat_messages_order_idx
  on public.chat_messages (order_id, created_at asc);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select"
  on public.chat_messages for select
  to anon, authenticated
  using (true);

drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert"
  on public.chat_messages for insert
  to anon, authenticated
  with check (true);

drop policy if exists "chat_messages_update" on public.chat_messages;
create policy "chat_messages_update"
  on public.chat_messages for update
  to anon, authenticated
  using (true)
  with check (true);
