-- Fix ambiguous accept_order_once overloads by keeping only uuid version

drop function if exists public.accept_order_once(text, text);
drop function if exists public.accept_order_once(uuid, text);

create or replace function public.accept_order_once(
  p_order_id uuid,
  p_delivery_id text
) returns void
language plpgsql
security definer
as $$
begin
  update public.orders
  set status = 'accepted',
      delivery_id = p_delivery_id
  where id = p_order_id
    and status = 'pending'
    and (delivery_id is null or delivery_id = '');

  if not found then
    raise exception 'ORDER_NOT_AVAILABLE';
  end if;
end;
$$;

grant execute on function public.accept_order_once(uuid, text) to anon, authenticated;
