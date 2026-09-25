-- STEP 7 — run after 006. Safe to run more than once.
-- Stock is valued at the super stockist (SS) rate: the price you bill super stockists, which is
-- what you get paid. Adds SS rate and MRP on products, the standard SS and distributor margins,
-- and schemes: date ranges with a billing discount for super stockists and/or different margins.

-- ---------- Prices on products ----------
alter table public.products add column if not exists ss_rate numeric(14,2);
alter table public.products add column if not exists mrp numeric(14,2);
drop policy if exists "managers update products" on public.products;
create policy "managers update products" on public.products for update to authenticated using (public.is_manager()) with check (public.is_manager());
grant select, update on public.products to authenticated;

-- The rate stock is valued at: the SS rate, or the last purchase rate until the SS rate is set.
create or replace function public.value_rate(p_product uuid) returns numeric
language sql stable set search_path=public as $$
  select coalesce(nullif(ss_rate, 0), unit_price, 0) from products where id = p_product
$$;

-- ---------- Margins and schemes ----------
insert into public.app_settings(key, value) values ('margins', '{"ss": 10, "distributor": 15}'::jsonb) on conflict (key) do nothing;
drop policy if exists "managers change margins" on public.app_settings;
create policy "managers change margins" on public.app_settings for all to authenticated
  using (key = 'margins' and public.is_manager()) with check (key = 'margins' and public.is_manager());

create table if not exists public.schemes(
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  starts_on date not null,
  ends_on date not null,
  ss_discount numeric(5,2) not null default 0 check (ss_discount >= 0 and ss_discount < 100),
  ss_margin numeric(5,2) check (ss_margin >= 0 and ss_margin < 100),
  distributor_margin numeric(5,2) check (distributor_margin >= 0 and distributor_margin < 100),
  applies_to uuid[],            -- super stockists it covers; null = all of them
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table public.schemes enable row level security;
drop policy if exists "read schemes" on public.schemes;
create policy "read schemes" on public.schemes for select to authenticated using (true);
drop policy if exists "managers change schemes" on public.schemes;
create policy "managers change schemes" on public.schemes for all to authenticated using (public.is_manager()) with check (public.is_manager());
grant select, insert, update, delete on public.schemes to authenticated;

-- Discount (%) a super stockist gets on billing on a date: the biggest scheme running then.
create or replace function public.ss_discount_on(p_ss uuid, p_on date) returns numeric
language sql stable set search_path=public as $$
  select coalesce(max(ss_discount), 0) from schemes
   where p_on between starts_on and ends_on and (applies_to is null or p_ss = any(applies_to))
$$;
-- What you bill a super stockist per unit on a date, after any scheme discount.
create or replace function public.ss_billing_rate(p_product uuid, p_ss uuid, p_on date) returns numeric
language sql stable set search_path=public as $$
  select value_rate(p_product) * (1 - ss_discount_on(p_ss, p_on) / 100)
$$;

-- The first time a godown dispatch to a super stockist carries a rate, it becomes the product's SS
-- rate (undoing any scheme discount running that day). Later changes are made on the Pricing page.
create or replace function public.fill_ss_rate() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.mode = 'INPUT' and new.source = 'TRANSFER' and coalesce(new.unit_price, 0) > 0
     and exists (select 1 from distributors where id = new.distributor_id and kind = 'SUPER_STOCKIST')
     and exists (select 1 from distributors where id = new.counterparty_id and kind = 'GODOWN') then
    update products set ss_rate = round(new.unit_price / (1 - ss_discount_on(new.distributor_id, new.transaction_date) / 100), 2)
     where id = new.product_id and ss_rate is null;
  end if;
  return new;
end $$;
drop trigger if exists fill_ss_rate on public.inventory_transactions;
create trigger fill_ss_rate after insert on public.inventory_transactions for each row execute function public.fill_ss_rate();

-- ---------- Everything that values stock uses the SS rate ----------
drop view if exists public.distributor_stock_summary;
create view public.distributor_stock_summary with (security_invoker=true) as
select d.id distributor_id, d.code distributor_code, d.name distributor_name, p.id product_id, p.sku, p.item_name,
  coalesce(nullif(p.ss_rate, 0), p.unit_price, 0) unit_price,
  sum(case when t.mode = 'INPUT' then t.quantity else 0 end) total_input,
  sum(case when t.mode = 'OUTPUT' then t.quantity else 0 end) total_output,
  sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) current_stock,
  round(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) * coalesce(nullif(p.ss_rate, 0), p.unit_price, 0), 2) stock_value,
  max(t.transaction_date) last_movement,
  max(t.transaction_date) filter (where t.mode = 'INPUT') last_in,
  max(t.transaction_date) filter (where t.mode = 'OUTPUT') last_out,
  d.kind
from inventory_transactions t
join distributors d on d.id = t.distributor_id
join products p on p.id = t.product_id
group by d.id, d.code, d.name, d.kind, p.id, p.sku, p.item_name, p.ss_rate, p.unit_price;
grant select on public.distributor_stock_summary to authenticated;

create or replace function public.stock_trend(p_weeks int default 12, p_locations uuid[] default null)
returns table(week_end date, kind text, state text, units numeric, value numeric)
language sql stable set search_path=public as $$
  with w as (
    select (date_trunc('week', current_date)::date + 6 - 7 * g)::date week_end
      from generate_series(0, least(greatest(p_weeks, 1), 104) - 1) g)
  select w.week_end, d.kind, coalesce(d.state, ''),
         coalesce(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end), 0),
         coalesce(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end * coalesce(nullif(p.ss_rate, 0), p.unit_price, 0)), 0)
    from w
    left join (inventory_transactions t
               join distributors d on d.id = t.distributor_id
               join products p on p.id = t.product_id)
      on t.transaction_date <= w.week_end and (p_locations is null or t.distributor_id = any(p_locations))
   group by 1, 2, 3
$$;

-- Dispatches from godowns are valued at what you bill: the SS rate less any scheme discount for
-- super stockists, the SS rate plus the SS margin for distributors supplied directly.
create or replace function public.weekly_flows(p_weeks int default 12, p_locations uuid[] default null)
returns table(week_start date, dispatched_units numeric, dispatched_value numeric, sold_units numeric, sold_value numeric, so_units numeric, so_value numeric)
language sql stable set search_path=public as $$
  with w as (
    select (date_trunc('week', current_date)::date - 7 * g)::date ws
      from generate_series(0, least(greatest(p_weeks, 1), 104) - 1) g),
  m as (select coalesce((value->>'ss')::numeric, 10) ss from app_settings where key = 'margins'),
  tx as (
    select date_trunc('week', t.transaction_date)::date ws, d.kind, t.source, t.quantity q,
           t.quantity * case
             when d.kind = 'GODOWN' and c.kind = 'SUPER_STOCKIST' then ss_billing_rate(t.product_id, c.id, t.transaction_date)
             when d.kind = 'GODOWN' and c.kind = 'DISTRIBUTOR' then coalesce(nullif(p.ss_rate, 0), p.unit_price, 0) * (1 + coalesce((select ss from m), 10) / 100)
             else coalesce(nullif(p.ss_rate, 0), p.unit_price, 0) end v
      from inventory_transactions t join distributors d on d.id = t.distributor_id join products p on p.id = t.product_id
      left join distributors c on c.id = t.counterparty_id
     where t.mode = 'OUTPUT' and t.transaction_date >= (select min(ws) from w)
       and (p_locations is null or t.distributor_id = any(p_locations))),
  so as (
    select date_trunc('week', l.report_date)::date ws, sum(l.quantity) q,
           sum(l.quantity * coalesce(nullif(p.ss_rate, 0), p.unit_price, 0)) v
      from so_report_lines l join products p on p.id = l.product_id
     where l.report_date >= (select min(ws) from w) and (p_locations is null or l.distributor_id = any(p_locations))
     group by 1)
  select w.ws,
    coalesce(sum(tx.q) filter (where tx.kind = 'GODOWN'), 0), coalesce(sum(tx.v) filter (where tx.kind = 'GODOWN'), 0),
    coalesce(sum(tx.q) filter (where tx.kind <> 'GODOWN' and tx.source in ('SALE', 'COUNT')), 0),
    coalesce(sum(tx.v) filter (where tx.kind <> 'GODOWN' and tx.source in ('SALE', 'COUNT')), 0),
    coalesce(max(so.q), 0), coalesce(max(so.v), 0)
  from w left join tx on tx.ws = w.ws left join so on so.ws = w.ws
  group by w.ws
$$;

revoke all on function public.value_rate(uuid) from public, anon;
grant execute on function public.value_rate(uuid) to authenticated;
revoke all on function public.ss_discount_on(uuid,date) from public, anon;
grant execute on function public.ss_discount_on(uuid,date) to authenticated;
revoke all on function public.ss_billing_rate(uuid,uuid,date) from public, anon;
grant execute on function public.ss_billing_rate(uuid,uuid,date) to authenticated;
revoke all on function public.stock_trend(int,uuid[]) from public, anon;
grant execute on function public.stock_trend(int,uuid[]) to authenticated;
revoke all on function public.weekly_flows(int,uuid[]) from public, anon;
grant execute on function public.weekly_flows(int,uuid[]) to authenticated;
