-- STEP 11 — run after 010. Safe to run more than once.
-- Product list from the DSR price list; SO bookings checked against each distributor's stock; and
-- merging two entries for the same salesperson.

-- Adds every DSR product that isn't in the product list yet (quantities in dozens, SS rate per
-- dozen), and fills the SS rate of listed products that have none.
create or replace function public.products_from_dsr() returns jsonb
language plpgsql security definer set search_path=public as $$
declare added int := 0; rated int := 0; r record; pid uuid;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can change the product list.'; end if;
  for r in select * from dsr_products order by position loop
    pid := coalesce(find_product(null, r.name), (select id from products where lower(sku) = lower(r.name) limit 1));
    if pid is null then
      insert into products(sku, item_name, unit_price, ss_rate) values (r.name, r.name, coalesce(r.rate, 0), r.rate);
      added := added + 1;
    elsif r.rate is not null then
      update products set ss_rate = r.rate where id = pid and ss_rate is null;
      if found then rated := rated + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'rated', rated);
end $$;
revoke all on function public.products_from_dsr() from public, anon;
grant execute on function public.products_from_dsr() to authenticated;

-- What SOs booked at each distributor, product by product, against that distributor's stock:
-- stock before the period, stock received during it, and stock at the end (with whether a stock
-- count was posted in the period).
create or replace function public.dsr_stock_check(p_from date, p_to date)
returns table(distributor_id uuid, product text, product_id uuid, so_qty numeric, so_value numeric,
              opening numeric, received numeric, closing numeric, counted boolean, has_before boolean)
language sql stable security definer set search_path=public as $$
  with s as (
    select d.distributor_id, l.product, sum(l.qty) q, sum(l.value) v
      from dsr_lines l join dsr_days d on d.id = l.day_id
     where d.day between p_from and p_to and d.distributor_id is not null
     group by 1, 2),
  sp as (select s.*, find_product(null, s.product) pid from s)
  select sp.distributor_id, sp.product, sp.pid, sp.q, sp.v,
    coalesce((select sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) from inventory_transactions t
               where t.distributor_id = sp.distributor_id and t.product_id = sp.pid and t.transaction_date < p_from), 0),
    coalesce((select sum(t.quantity) from inventory_transactions t
               where t.distributor_id = sp.distributor_id and t.product_id = sp.pid and t.mode = 'INPUT' and t.source in ('PURCHASE', 'TRANSFER')
                 and t.transaction_date between p_from and p_to), 0),
    coalesce((select sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) from inventory_transactions t
               where t.distributor_id = sp.distributor_id and t.product_id = sp.pid and t.transaction_date <= p_to), 0),
    exists (select 1 from inventory_transactions t where t.distributor_id = sp.distributor_id and t.source = 'COUNT' and t.transaction_date between p_from and p_to),
    exists (select 1 from inventory_transactions t where t.distributor_id = sp.distributor_id and t.transaction_date < p_from)
  from sp
$$;
revoke all on function public.dsr_stock_check(date, date) from public, anon;
grant execute on function public.dsr_stock_check(date, date) to authenticated;

-- Two entries for the same person (different spellings): everything moves to p_keep, the other
-- spelling becomes an alias, and p_drop is deleted. Days both have logged keep p_keep's figures.
create or replace function public.merge_staff(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare moved int; nm text;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can merge staff.'; end if;
  if p_keep = p_drop then raise exception 'Pick two different people.'; end if;
  select name into nm from sales_officers where id = p_drop;
  if nm is null then raise exception 'That person no longer exists.'; end if;
  update dsr_days d set so_id = p_keep where d.so_id = p_drop and not exists (select 1 from dsr_days k where k.so_id = p_keep and k.day = d.day);
  get diagnostics moved = row_count;
  delete from dsr_days where so_id = p_drop;
  update so_report_lines set so_id = p_keep where so_id = p_drop;
  update distributors set so_id = p_keep where so_id = p_drop;
  update sales_officers set manager_id = p_keep where manager_id = p_drop and id <> p_keep;
  update sales_officers k set
    aliases = (select array(select distinct x from unnest(coalesce(k.aliases, '{}') || nm || coalesce(o.aliases, '{}')) x where norm_name(x) <> norm_name(k.name))),
    phone = coalesce(k.phone, o.phone), hq = coalesce(k.hq, o.hq), zone = coalesce(k.zone, o.zone), areas = coalesce(k.areas, o.areas),
    manager_id = coalesce(k.manager_id, nullif(o.manager_id, k.id))
  from sales_officers o where k.id = p_keep and o.id = p_drop;
  delete from sales_officers where id = p_drop;
  return jsonb_build_object('days_moved', moved);
end $$;
revoke all on function public.merge_staff(uuid, uuid) from public, anon;
grant execute on function public.merge_staff(uuid, uuid) to authenticated;
