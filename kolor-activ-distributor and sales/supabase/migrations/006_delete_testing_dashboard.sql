-- STEP 6 — run after 005. Safe to run more than once.
-- Adds: deleting a location (optionally moving its stock and its distributors elsewhere first),
-- a testing mode with "clear all data", each user's dashboard layout, and the functions behind
-- the dashboard charts and alerts.

-- ---------- Roles and settings ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'HO_ADMIN')
$$;

create table if not exists public.app_settings(
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "read settings" on public.app_settings;
create policy "read settings" on public.app_settings for select to authenticated using (true);
drop policy if exists "admins change settings" on public.app_settings;
create policy "admins change settings" on public.app_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into public.app_settings(key, value) values ('testing_mode', 'true'::jsonb) on conflict (key) do nothing;

-- Each user's own dashboard: which charts, in what order, with what options.
create table if not exists public.user_settings(
  user_id uuid primary key references auth.users(id) on delete cascade,
  dashboard jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.app_settings, public.user_settings to authenticated;

-- ---------- Deleting a location ----------
-- The other side of a transfer keeps its lines when a location is deleted; the location's name
-- stays on them as the party.
alter table public.inventory_transactions drop constraint if exists inventory_transactions_counterparty_id_fkey;
alter table public.inventory_transactions add constraint inventory_transactions_counterparty_id_fkey
  foreign key (counterparty_id) references public.distributors(id) on delete set null;

-- Deletes a godown, super stockist or distributor with everything recorded for it: its stock
-- lines, SO report lines, retailers and comments. p_move_to first moves the stock it still holds
-- to another location; p_children_to moves the distributors under a super stockist to another one.
create or replace function public.delete_location(
  p_location uuid, p_move_to uuid default null, p_children_to uuid default null, p_drop_unused_products boolean default false)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare loc distributors%rowtype; bid uuid; r record; bids uuid[]; own uuid[]; reps uuid[];
        n_moved int := 0; n_units numeric := 0; n_tx int := 0; n_so int := 0; n_ret int := 0; n_kids int := 0; n_prod int := 0;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can delete locations'; end if;
  select * into loc from distributors where id = p_location;
  if not found then raise exception 'That location no longer exists'; end if;

  if p_move_to is not null then
    if p_move_to = p_location then raise exception 'Pick a different location to move the stock to'; end if;
    if not exists (select 1 from distributors where id = p_move_to) then raise exception 'The location to move the stock to no longer exists'; end if;
    for r in select t.product_id, sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) q
               from inventory_transactions t where t.distributor_id = p_location
              group by t.product_id having sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) > 0 loop
      if bid is null then
        insert into inventory_batches(mode, created_by, source_file, distributor_id, as_of)
        values ('INPUT', auth.uid(), 'Stock moved from ' || loc.name || ' when it was deleted', p_move_to, current_date) returning id into bid;
      end if;
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, party)
      values (bid, p_move_to, r.product_id, 'INPUT', current_date, 'Moved from ' || loc.name, r.q,
              coalesce((select unit_price from products where id = r.product_id), 0), auth.uid(), 'TRANSFER', loc.name);
      n_moved := n_moved + 1; n_units := n_units + r.q;
    end loop;
  end if;

  if p_children_to is not null then
    if p_children_to = p_location then raise exception 'Pick a different super stockist for its distributors'; end if;
    update distributors set parent_id = p_children_to, super_stockist = (select name from distributors where id = p_children_to)
     where parent_id = p_location;
    get diagnostics n_kids = row_count;
  end if;

  select coalesce(array_agg(distinct batch_id), '{}') into bids from inventory_transactions where distributor_id = p_location;
  select coalesce(array_agg(id), '{}') into own from inventory_batches where distributor_id = p_location;
  select coalesce(array_agg(distinct report_id), '{}') into reps from so_report_lines where distributor_id = p_location;

  update inventory_transactions set party = coalesce(party, loc.name) where counterparty_id = p_location;
  delete from so_report_lines where distributor_id = p_location;
  get diagnostics n_so = row_count;
  delete from so_reports s where s.id = any(reps) and not exists (select 1 from so_report_lines l where l.report_id = s.id);
  delete from collections where distributor_id = p_location or retailer_id in (select id from retailers where distributor_id = p_location);
  delete from sales_invoices where distributor_id = p_location or retailer_id in (select id from retailers where distributor_id = p_location);
  delete from inventory_transactions where distributor_id = p_location;
  get diagnostics n_tx = row_count;
  -- Postings that also moved stock elsewhere keep those other lines.
  update inventory_batches set distributor_id = null where distributor_id = p_location;
  delete from inventory_batches b where (b.id = any(bids) or b.id = any(own))
     and not exists (select 1 from inventory_transactions t where t.batch_id = b.id);
  select count(*) into n_ret from retailers where distributor_id = p_location;
  delete from distributors where id = p_location;

  if p_drop_unused_products then
    delete from products p where not exists (select 1 from inventory_transactions t where t.product_id = p.id)
       and not exists (select 1 from so_report_lines l where l.product_id = p.id);
    get diagnostics n_prod = row_count;
  end if;
  return jsonb_build_object('moved_products', n_moved, 'moved_units', n_units, 'deleted_lines', n_tx, 'deleted_so_lines', n_so,
                            'deleted_retailers', n_ret, 'moved_distributors', n_kids, 'deleted_products', n_prod);
end $$;

-- Products that no stock line or SO report uses any more.
create or replace function public.delete_unused_products() returns int
language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can delete products'; end if;
  delete from products p where not exists (select 1 from inventory_transactions t where t.product_id = p.id)
     and not exists (select 1 from so_report_lines l where l.product_id = p.id);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Testing: clear everything ----------
-- Only while testing mode is on, only for HO admins, and only with the word DELETE.
-- Logins, roles and dashboard layouts stay.
create or replace function public.clear_all_data(p_confirm text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare n_loc int; n_lines int;
begin
  if not is_admin() then raise exception 'Only HO admins can clear all data'; end if;
  if (select value from app_settings where key = 'testing_mode') is distinct from 'true'::jsonb then
    raise exception 'Testing mode is off. Turn it on in Settings to clear all data.';
  end if;
  if p_confirm is distinct from 'DELETE' then raise exception 'Type DELETE to confirm'; end if;
  select count(*) into n_loc from distributors;
  select count(*) into n_lines from inventory_transactions;
  delete from so_report_lines where true;
  delete from so_reports where true;
  delete from collections where true;
  delete from sales_invoices where true;
  delete from inventory_transactions where true;
  delete from inventory_batches where true;
  delete from distributor_comments where true;
  delete from retailers where true;
  delete from product_aliases where true;
  delete from products where true;
  delete from import_formats where true;
  delete from sales_officers where true;
  update distributors set parent_id = null where parent_id is not null;
  delete from distributors where true;
  return jsonb_build_object('deleted_locations', n_loc, 'deleted_lines', n_lines);
end $$;

-- ---------- Dashboard ----------
-- Stock held at the end of each week (this week's end included), by location type and state.
-- Every week gets at least one row (kind null when nothing was held). Value uses current rates.
create or replace function public.stock_trend(p_weeks int default 12, p_locations uuid[] default null)
returns table(week_end date, kind text, state text, units numeric, value numeric)
language sql stable set search_path=public as $$
  with w as (
    select (date_trunc('week', current_date)::date + 6 - 7 * g)::date week_end
      from generate_series(0, least(greatest(p_weeks, 1), 104) - 1) g)
  select w.week_end, d.kind, coalesce(d.state, ''),
         coalesce(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end), 0),
         coalesce(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end * p.unit_price), 0)
    from w
    left join (inventory_transactions t
               join distributors d on d.id = t.distributor_id
               join products p on p.id = t.product_id)
      on t.transaction_date <= w.week_end and (p_locations is null or t.distributor_id = any(p_locations))
   group by 1, 2, 3
$$;

-- Each week: stock dispatched from godowns, stock distributors and super stockists sold
-- (their sales files and stock count drops), and what SOs reported.
create or replace function public.weekly_flows(p_weeks int default 12, p_locations uuid[] default null)
returns table(week_start date, dispatched_units numeric, dispatched_value numeric, sold_units numeric, sold_value numeric, so_units numeric, so_value numeric)
language sql stable set search_path=public as $$
  with w as (
    select (date_trunc('week', current_date)::date - 7 * g)::date ws
      from generate_series(0, least(greatest(p_weeks, 1), 104) - 1) g),
  tx as (
    select date_trunc('week', t.transaction_date)::date ws, d.kind, t.source, t.quantity q, t.quantity * p.unit_price v
      from inventory_transactions t join distributors d on d.id = t.distributor_id join products p on p.id = t.product_id
     where t.mode = 'OUTPUT' and t.transaction_date >= (select min(ws) from w)
       and (p_locations is null or t.distributor_id = any(p_locations))),
  so as (
    select date_trunc('week', l.report_date)::date ws, sum(l.quantity) q,
           sum(l.quantity * coalesce(nullif(l.unit_price, 0), p.unit_price)) v
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

-- Each SO's latest reporting day against their usual day (average of the days they reported in
-- the p_base_days before it) and their last 7 days.
create or replace function public.so_activity(p_base_days int default 30)
returns table(so_id uuid, so_name text, last_day date, last_units numeric, last_value numeric,
              base_days int, base_units numeric, base_value numeric, week_days int, week_units numeric, week_value numeric)
language sql stable set search_path=public as $$
  with daily as (
    select l.so_id, l.report_date, sum(l.quantity) as u, sum(l.quantity * coalesce(nullif(l.unit_price, 0), p.unit_price)) as v
      from so_report_lines l join products p on p.id = l.product_id
     where l.report_date > current_date - (p_base_days + 120)
     group by 1, 2),
  latest as (select distinct on (so_id) so_id, report_date, u, v from daily order by so_id, report_date desc),
  usual as (
    select daily.so_id, count(*)::int as n, avg(daily.u) as u, avg(daily.v) as v from daily join latest on latest.so_id = daily.so_id
     where daily.report_date < latest.report_date and daily.report_date >= latest.report_date - p_base_days group by daily.so_id),
  recent as (
    select daily.so_id, count(*)::int as n, avg(daily.u) as u, avg(daily.v) as v from daily join latest on latest.so_id = daily.so_id
     where daily.report_date > latest.report_date - 7 group by daily.so_id)
  select s.id, s.name, latest.report_date, latest.u, latest.v,
         coalesce(usual.n, 0), usual.u, usual.v, coalesce(recent.n, 0), recent.u, recent.v
    from latest join sales_officers s on s.id = latest.so_id
    left join usual on usual.so_id = latest.so_id left join recent on recent.so_id = latest.so_id
$$;

-- Stock received in the last p_days by a distributor or super stockist that already held more
-- than p_cover_days of it at its selling rate (or had not sold any). Needs 14 days of history.
create or replace function public.reorders_while_stocked(p_days int default 30, p_cover_days int default 60, p_locations uuid[] default null)
returns table(location_id uuid, product_id uuid, received_on date, qty_received numeric, stock_before numeric, daily_sales numeric, cover_days numeric)
language sql stable set search_path=public as $$
  with rc as (
    select t.distributor_id, t.product_id, t.transaction_date d, sum(t.quantity) q
      from inventory_transactions t join distributors l on l.id = t.distributor_id
     where t.mode = 'INPUT' and t.source in ('TRANSFER', 'PURCHASE') and l.kind <> 'GODOWN'
       and t.transaction_date > current_date - p_days
       and (p_locations is null or t.distributor_id = any(p_locations))
     group by 1, 2, 3),
  x as (
    select rc.*,
      (select coalesce(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end), 0) from inventory_transactions t
        where t.distributor_id = rc.distributor_id and t.product_id = rc.product_id and t.transaction_date < rc.d) as held,
      (select min(t.transaction_date) from inventory_transactions t where t.distributor_id = rc.distributor_id) as first_seen,
      (select coalesce(sum(t.quantity), 0) from inventory_transactions t
        where t.distributor_id = rc.distributor_id and t.product_id = rc.product_id and t.mode = 'OUTPUT'
          and t.transaction_date >= rc.d - 90 and t.transaction_date < rc.d) as sold
    from rc),
  y as (select x.*, x.sold / greatest(least(90, x.d - x.first_seen), 1) as rate from x)
  select distributor_id, product_id, d, q, held, round(rate, 2), case when rate > 0 then round(held / rate, 1) end
    from y
   where held > 0 and d - first_seen >= 14 and (rate = 0 or held / rate > p_cover_days)
$$;

-- last_file: the latest file posted as this location's own (stock counts, its sales, dispatch or
-- purchase registers). A super stockist that sends its dispatch register isn't "quiet".
create or replace view public.location_data_status with (security_invoker=true) as
select d.id location_id,
  (select max(b.as_of) from inventory_batches b where b.distributor_id = d.id and b.mode = 'COUNT') last_count,
  (select max(t.transaction_date) from inventory_transactions t where t.distributor_id = d.id and t.source = 'SALE') last_sale,
  (select max(t.transaction_date) from inventory_transactions t where t.distributor_id = d.id) last_movement,
  (select max(b.as_of) from inventory_batches b where b.distributor_id = d.id) last_file
from distributors d;
grant select on public.location_data_status to authenticated;

-- Stock count differences, leaving out each location's first posting (its opening stock).
create or replace function public.count_changes(p_from date, p_to date, p_locations uuid[] default null)
returns table(id uuid, location_id uuid, product_id uuid, counted_on date, change numeric, source_file text)
language sql stable set search_path=public as $$
  select t.id, t.distributor_id, t.product_id, t.transaction_date,
         case when t.mode = 'INPUT' then t.quantity else -t.quantity end, b.source_file
    from inventory_transactions t join inventory_batches b on b.id = t.batch_id
   where t.source = 'COUNT' and t.transaction_date between p_from and p_to
     and (p_locations is null or t.distributor_id = any(p_locations))
     and exists (select 1 from inventory_transactions e
                  where e.distributor_id = t.distributor_id and e.batch_id <> t.batch_id and e.created_at < t.created_at)
$$;

-- ---------- Permissions ----------
revoke all on function public.delete_location(uuid,uuid,uuid,boolean) from public, anon;
grant execute on function public.delete_location(uuid,uuid,uuid,boolean) to authenticated;
revoke all on function public.delete_unused_products() from public, anon;
grant execute on function public.delete_unused_products() to authenticated;
revoke all on function public.clear_all_data(text) from public, anon;
grant execute on function public.clear_all_data(text) to authenticated;
revoke all on function public.stock_trend(int,uuid[]) from public, anon;
grant execute on function public.stock_trend(int,uuid[]) to authenticated;
revoke all on function public.weekly_flows(int,uuid[]) from public, anon;
grant execute on function public.weekly_flows(int,uuid[]) to authenticated;
revoke all on function public.so_activity(int) from public, anon;
grant execute on function public.so_activity(int) to authenticated;
revoke all on function public.reorders_while_stocked(int,int,uuid[]) from public, anon;
grant execute on function public.reorders_while_stocked(int,int,uuid[]) to authenticated;
revoke all on function public.count_changes(date,date,uuid[]) from public, anon;
grant execute on function public.count_changes(date,date,uuid[]) to authenticated;
