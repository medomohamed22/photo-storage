-- Supabase/Postgres RPC for completing delivery with OTP validation.
-- Ensures a single, unambiguous signature using UUID order IDs.

drop function if exists public.complete_delivery(p_order_id text, p_otp text, p_delivery_id text);
drop function if exists public.complete_delivery(p_order_id uuid, p_otp text, p_delivery_id text);

create or replace function public.complete_delivery(
  p_order_id uuid,
  p_otp text,
  p_delivery_id text
)
returns void
language plpgsql
security definer
as $$
declare
  v_order record;
begin
  select *
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order is null then
    raise exception 'Order not found';
  end if;

  if v_order.delivery_id is distinct from p_delivery_id then
    raise exception 'Delivery mismatch';
  end if;

  if v_order.otp_code is null or v_order.otp_code <> p_otp then
    raise exception 'Invalid OTP';
  end if;

  update public.orders
     set status = 'delivered'
   where id = p_order_id;
end;
$$;

grant execute on function public.complete_delivery(uuid, text, text) to anon, authenticated;
