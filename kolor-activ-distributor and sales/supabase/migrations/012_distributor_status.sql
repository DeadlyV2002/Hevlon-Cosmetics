-- STEP 12 — run after 011. Safe to run more than once.
-- Distributors and super stockists can be marked dormant when they are dropped: they stay in the
-- records (with their history) but are left out of reminders and can be hidden from lists.
alter table public.distributors add column if not exists status text not null default 'ACTIVE';
do $$ begin
  alter table public.distributors add constraint distributors_status_check check (status in ('ACTIVE', 'DORMANT'));
exception when duplicate_object then null; end $$;

-- Dormant locations get no stock reminders.
create or replace function public.reminder_status(p_period date default (date_trunc('month', current_date) - interval '1 month')::date)
returns table(location_id uuid, code text, name text, kind text, email text, phone text, received_on date,
              first_sent timestamptz, follow_ups int, last_sent timestamptz, last_error text)
language sql stable security definer set search_path=public as $$
  with s as (select coalesce((value->>'super_stockists')::boolean, true) ss from app_settings where key = 'reminders')
  select d.id, d.code, d.name, d.kind, d.email, d.phone,
    (select min(b.created_at)::date from inventory_batches b
      where b.distributor_id = d.id and b.created_at >= (date_trunc('month', p_period) + interval '1 month')),
    (select min(l.sent_at) from reminder_log l where l.location_id = d.id and l.period = p_period and l.kind = 'FIRST' and l.ok),
    (select count(distinct l.sent_at::date)::int from reminder_log l where l.location_id = d.id and l.period = p_period and l.kind = 'FOLLOW_UP' and l.ok),
    (select max(l.sent_at) from reminder_log l where l.location_id = d.id and l.period = p_period and l.ok),
    (select l.error from reminder_log l where l.location_id = d.id and l.period = p_period and not l.ok order by l.sent_at desc limit 1)
  from distributors d
  where coalesce(d.status, 'ACTIVE') = 'ACTIVE'
    and (d.kind = 'DISTRIBUTOR' or (d.kind = 'SUPER_STOCKIST' and coalesce((select ss from s), true)))
$$;

-- ---------- Products: active / dormant ----------
-- Dormant products stay in the product list (distributors still return old stock of them).
alter table public.products add column if not exists status text not null default 'ACTIVE';
do $$ begin
  alter table public.products add constraint products_status_check check (status in ('ACTIVE', 'DORMANT'));
exception when duplicate_object then null; end $$;
-- Only the status changes here, so the pricing lock on the rest of the product stays in force.
create or replace function public.set_product_status(p_ids uuid[], p_status text) returns int
language sql security definer set search_path=public as $$
  with u as (update products set status = p_status where id = any(p_ids) and is_manager() and p_status in ('ACTIVE', 'DORMANT') returning 1)
  select count(*)::int from u
$$;
revoke all on function public.set_product_status(uuid[], text) from public, anon;
grant execute on function public.set_product_status(uuid[], text) to authenticated;

-- ---------- Linking DSR "DB Name" spellings to distributors ----------
-- p_map: [{db_name, distributor_id}]. Every DSR day with that DB name (and no distributor yet)
-- is linked, and the spelling is saved as the distributor's other name so later uploads match.
create or replace function public.link_dsr_distributors(p_map jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare m jsonb; k int; days int := 0; names int := 0;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can link distributors.'; end if;
  for m in select * from jsonb_array_elements(p_map) loop
    update dsr_days set distributor_id = (m->>'distributor_id')::uuid
     where distributor_id is null and norm_name(db_name) = norm_name(m->>'db_name');
    get diagnostics k = row_count; days := days + k;
    update distributors set aliases = array_append(coalesce(aliases, '{}'), m->>'db_name')
     where id = (m->>'distributor_id')::uuid and norm_name(name) <> norm_name(m->>'db_name')
       and not exists (select 1 from unnest(coalesce(aliases, '{}')) a where norm_name(a) = norm_name(m->>'db_name'));
    names := names + 1;
  end loop;
  return jsonb_build_object('days', days, 'names', names);
end $$;
revoke all on function public.link_dsr_distributors(jsonb) from public, anon;
grant execute on function public.link_dsr_distributors(jsonb) to authenticated;

-- ---------- Retailers: their own state and region ----------
-- A retailer can sit outside its distributor's area (a Delhi retailer supplied from elsewhere).
alter table public.retailers add column if not exists state text;
alter table public.retailers add column if not exists region text;

-- ---------- DSR state totals per workbook ----------
-- Two workbooks can both call their state "Bihar" (North and South Bihar). Each state total now
-- carries the SOs of its own workbook (team: their names, sorted), and is checked against them only.
alter table public.dsr_state_days add column if not exists team text not null default '';
alter table public.dsr_state_days drop constraint if exists dsr_state_days_pkey;
alter table public.dsr_state_days add primary key (state, day, team);

-- ---------- Product categories (from the DSR category heads) ----------
alter table public.products add column if not exists category text;
update public.products p set category = d.category
  from public.dsr_products d where coalesce(p.category, '') = '' and coalesce(d.category, '') <> '' and norm_name(d.name) in (norm_name(p.item_name), norm_name(p.sku));
-- Adding DSR products also sets categories, for new and existing products.
create or replace function public.products_from_dsr() returns jsonb
language plpgsql security definer set search_path=public as $$
declare added int := 0; rated int := 0; r record; pid uuid;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can change the product list.'; end if;
  for r in select * from dsr_products order by position loop
    pid := coalesce(find_product(null, r.name), (select id from products where lower(sku) = lower(r.name) limit 1));
    if pid is null then
      insert into products(sku, item_name, unit_price, ss_rate, category) values (r.name, r.name, coalesce(r.rate, 0), r.rate, nullif(r.category, ''));
      added := added + 1;
    else
      update products set category = coalesce(nullif(category, ''), nullif(r.category, '')) where id = pid;
      if r.rate is not null then
        update products set ss_rate = r.rate where id = pid and ss_rate is null;
        if found then rated := rated + 1; end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'rated', rated);
end $$;

-- ---------- Distributors that deal with the company directly ----------
-- Some distributors with good billing buy straight from the company: no super stockist is needed.
alter table public.distributors add column if not exists direct boolean not null default false;

-- ---------- Stock sent through another distributor ----------
-- A distributor billed under one super stockist can get its goods through a nearby distributor
-- (Balaji Traders: SS Garg Enterprises, stock carried by Gupta Enterprises).
alter table public.distributors add column if not exists via_id uuid references public.distributors(id) on delete set null;

-- ---------- Faster checks ----------
-- SO bookings against stock, worked out in one pass: each DSR product name is looked up once, and
-- each distributor's stock movements are added up once, instead of once per distributor and product.
create or replace function public.dsr_stock_check(p_from date, p_to date)
returns table(distributor_id uuid, product text, product_id uuid, so_qty numeric, so_value numeric,
              opening numeric, received numeric, closing numeric, counted boolean, has_before boolean)
language sql stable security definer set search_path=public as $$
  with s as (
    select d.distributor_id, l.product, sum(l.qty) q, sum(l.value) v
      from dsr_lines l join dsr_days d on d.id = l.day_id
     where d.day between p_from and p_to and d.distributor_id is not null
     group by 1, 2),
  names as materialized (select x.product, find_product(null, x.product) pid from (select distinct product from s) x),
  dists as (select distinct distributor_id from s),
  t as (
    select t.distributor_id, t.product_id,
           sum(case when t.transaction_date < p_from then case when t.mode = 'INPUT' then t.quantity else -t.quantity end else 0 end) opening,
           sum(case when t.mode = 'INPUT' and t.source in ('PURCHASE', 'TRANSFER') and t.transaction_date >= p_from then t.quantity else 0 end) received,
           sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) closing
      from inventory_transactions t join dists using (distributor_id)
     where t.transaction_date <= p_to
     group by 1, 2),
  loc as (
    select t.distributor_id, bool_or(t.source = 'COUNT' and t.transaction_date >= p_from) counted, bool_or(t.transaction_date < p_from) before
      from inventory_transactions t join dists using (distributor_id)
     where t.transaction_date <= p_to
     group by 1)
  select s.distributor_id, s.product, n.pid, s.q, s.v, coalesce(t.opening, 0), coalesce(t.received, 0), coalesce(t.closing, 0),
         coalesce(loc.counted, false), coalesce(loc.before, false)
    from s join names n on n.product = s.product
    left join t on t.distributor_id = s.distributor_id and t.product_id = n.pid
    left join loc on loc.distributor_id = s.distributor_id
$$;
revoke all on function public.dsr_stock_check(date, date) from public, anon;
grant execute on function public.dsr_stock_check(date, date) to authenticated;

-- Linking DSR DB names in one statement rather than one pass over the DSR days per name.
create index if not exists dsr_days_unlinked on public.dsr_days(public.norm_name(db_name)) where distributor_id is null;
create or replace function public.link_dsr_distributors(p_map jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare days int := 0; names int := 0;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can link distributors.'; end if;
  with m as (select distinct on (norm_name(x->>'db_name')) norm_name(x->>'db_name') k, (x->>'distributor_id')::uuid did
               from jsonb_array_elements(p_map) x where nullif(x->>'distributor_id', '') is not null)
  update dsr_days d set distributor_id = m.did from m where d.distributor_id is null and norm_name(d.db_name) = m.k;
  get diagnostics days = row_count;
  with m as (select (x->>'distributor_id')::uuid did, array_agg(distinct x->>'db_name') nms
               from jsonb_array_elements(p_map) x where nullif(x->>'distributor_id', '') is not null group by 1)
  update distributors t set aliases = coalesce(t.aliases, '{}') || array(
      select a from unnest(m.nms) a where norm_name(a) <> norm_name(t.name)
         and not exists (select 1 from unnest(coalesce(t.aliases, '{}')) o where norm_name(o) = norm_name(a)))
    from m where t.id = m.did;
  select count(*) into names from jsonb_array_elements(p_map) x where nullif(x->>'distributor_id', '') is not null;
  return jsonb_build_object('days', days, 'names', names);
end $$;
revoke all on function public.link_dsr_distributors(jsonb) from public, anon;
grant execute on function public.link_dsr_distributors(jsonb) to authenticated;

-- Undoing a wrong link: that spelling's DSR days go back to unlinked and it stops being one of the distributor's other names.
create or replace function public.unlink_dsr_name(p_distributor uuid, p_name text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare k int;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can unlink distributors.'; end if;
  update dsr_days set distributor_id = null where distributor_id = p_distributor and norm_name(db_name) = norm_name(p_name);
  get diagnostics k = row_count;
  update distributors set aliases = array(select a from unnest(coalesce(aliases, '{}')) a where norm_name(a) <> norm_name(p_name)) where id = p_distributor;
  return jsonb_build_object('days', k);
end $$;
revoke all on function public.unlink_dsr_name(uuid, text) from public, anon;
grant execute on function public.unlink_dsr_name(uuid, text) to authenticated;

-- ---------- Company billing to super stockists ----------
-- Each invoice line becomes stock received by that super stockist (bought from the company).
-- Lines already saved (same SS, invoice and product) are skipped, so the same growing sheet can be
-- uploaded every month and only new invoices go in. Billing dated on or before a stock count the SS
-- already sent is also taken off at that count: the count says what they held that day, and the
-- difference shows up as stock the billing says they should have had.
create or replace function public.post_primary_sales(p_lines jsonb, p_source_file text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare l jsonb; bid uuid; sid uuid; pid uuid; q numeric; rate numeric; d date; ref text; old numeric; cnt date; last_d date;
        n_add int := 0; n_kept int := 0; n_changed int := 0; n_new int := 0; n_count int := 0; changed jsonb := '[]'::jsonb;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can save company billing.'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'No lines to save'; end if;
  insert into inventory_batches(mode, created_by, source_file) values ('INPUT', auth.uid(), p_source_file) returning id into bid;
  for l in select value from jsonb_array_elements(p_lines) loop
    sid := nullif(l->>'ss_id', '')::uuid;
    q := coalesce(nullif(l->>'qty', '')::numeric, 0);
    rate := nullif(l->>'rate', '')::numeric;
    d := coalesce(nullif(l->>'date', '')::date, current_date);
    ref := coalesce(nullif(trim(l->>'invoice'), ''), 'Billing ' || d::text);
    pid := coalesce(nullif(l->>'product_id', '')::uuid, find_product(null, l->>'item'));
    if pid is null then
      insert into products(sku, item_name, unit_price, ss_rate, category)
      values (trim(l->>'item'), trim(l->>'item'), coalesce(rate, 0), rate, nullif(trim(l->>'category'), ''))
      returning id into pid;
      n_new := n_new + 1;
    else
      update products set category = coalesce(nullif(category, ''), nullif(trim(l->>'category'), '')),
                          ss_rate = coalesce(ss_rate, rate) where id = pid;
    end if;
    -- A line without a quantity or SS only adds the item to the SKU list (display items not billed yet).
    if q <= 0 or sid is null then continue; end if;
    if not exists (select 1 from distributors where id = sid) then raise exception 'Super stockist not found for "%"', l->>'item'; end if;
    select sum(quantity) into old from inventory_transactions
     where distributor_id = sid and product_id = pid and mode = 'INPUT' and source = 'PURCHASE' and reference = ref;
    if old is not null then
      n_kept := n_kept + 1;
      if abs(old - q) > 0.001 then
        n_changed := n_changed + 1;
        if jsonb_array_length(changed) < 50 then changed := changed || jsonb_build_object('invoice', ref, 'item', l->>'item', 'saved', old, 'now', q); end if;
      end if;
      continue;
    end if;
    insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, party)
    values (bid, sid, pid, 'INPUT', d, ref, q, coalesce(rate, 0), auth.uid(), 'PURCHASE', 'Company billing');
    n_add := n_add + 1;
    last_d := greatest(coalesce(last_d, d), d);
    select min(as_of) into cnt from inventory_batches where distributor_id = sid and mode = 'COUNT' and as_of >= d;
    if cnt is not null then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source)
      values (bid, sid, pid, 'OUTPUT', cnt, 'Stock count (billed before this count)', q, coalesce(rate, 0), auth.uid(), 'COUNT');
      n_count := n_count + 1;
    end if;
  end loop;
  update inventory_batches set as_of = last_d where id = bid;
  if n_add = 0 then delete from inventory_batches where id = bid; end if;
  return jsonb_build_object('added', n_add, 'kept', n_kept, 'changed', n_changed, 'changed_lines', changed, 'new_products', n_new, 'count_adjusted', n_count);
end $$;
revoke all on function public.post_primary_sales(jsonb, text) from public, anon;
grant execute on function public.post_primary_sales(jsonb, text) to authenticated;
