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

-- Pieces in a box, for sheets that give some quantities in boxes.
alter table public.products add column if not exists box_pcs int;

-- ---------- Company billing to super stockists ----------
-- Each invoice line becomes stock received by that super stockist (bought from the company), and
-- the same quantity leaves the company godown it was sent from: a bill means the goods left.
-- Lines already saved (same SS, invoice and product) are skipped, so the same growing sheet can be
-- uploaded every month and only new invoices go in. Billing dated on or before a stock count already
-- posted (the SS's or the godown's) is also set against that count: the count says what was held that
-- day, and the difference shows up as the gap. Display items (POP) are free: they carry no rate.
-- A line with no quantity or SS only adds the item to the SKU list.
drop function if exists public.post_primary_sales(jsonb, text);
create or replace function public.post_primary_sales(p_lines jsonb, p_source_file text default null, p_godown uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare l jsonb; t record; bid uuid; sid uuid; pid uuid; tid uuid; q numeric; rate numeric; d date; ref text; old numeric; cnt date; last_d date; free boolean;
        n_add int := 0; n_kept int := 0; n_changed int := 0; n_new int := 0; n_count int := 0; n_godown int := 0; changed jsonb := '[]'::jsonb;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can save company billing.'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'No lines to save'; end if;
  if p_godown is not null and not exists (select 1 from distributors where id = p_godown and kind = 'GODOWN') then raise exception 'That godown was not found.'; end if;
  insert into inventory_batches(mode, created_by, source_file) values ('INPUT', auth.uid(), p_source_file) returning id into bid;
  for l in select value from jsonb_array_elements(p_lines) loop
    sid := nullif(l->>'ss_id', '')::uuid;
    q := coalesce(nullif(l->>'qty', '')::numeric, 0);
    free := coalesce((l->>'free')::boolean, false);
    rate := case when free then 0 else nullif(l->>'rate', '')::numeric end;
    d := coalesce(nullif(l->>'date', '')::date, current_date);
    ref := coalesce(nullif(trim(l->>'invoice'), ''), 'Billing ' || d::text);
    pid := coalesce(nullif(l->>'product_id', '')::uuid, find_product(null, l->>'item'));
    if pid is null then
      insert into products(sku, item_name, unit_price, category, box_pcs)
      values (trim(l->>'item'), trim(l->>'item'), coalesce(rate, 0), nullif(trim(l->>'category'), ''), nullif(l->>'box_pcs', '')::int)
      returning id into pid;
      n_new := n_new + 1;
    else
      -- Existing SKUs keep their category (from the DSR list); only an empty one is filled.
      update products set category = coalesce(nullif(category, ''), nullif(trim(l->>'category'), '')),
                          box_pcs = coalesce(nullif(l->>'box_pcs', '')::int, box_pcs),
                          unit_price = case when free then 0 else unit_price end where id = pid;
    end if;
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
    tid := case when p_godown is null then null else gen_random_uuid() end;
    insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, party, counterparty_id, transfer_id)
    values (bid, sid, pid, 'INPUT', d, ref, q, coalesce(rate, 0), auth.uid(), 'PURCHASE', 'Company billing', p_godown, tid);
    n_add := n_add + 1;
    last_d := greatest(coalesce(last_d, d), d);
    select min(as_of) into cnt from inventory_batches where distributor_id = sid and mode = 'COUNT' and as_of >= d;
    if cnt is not null then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source)
      values (bid, sid, pid, 'OUTPUT', cnt, 'Stock count (billed before this count)', q, coalesce(rate, 0), auth.uid(), 'COUNT');
      n_count := n_count + 1;
    end if;
  end loop;
  -- The godown side, for this upload and for billing saved earlier without it.
  if p_godown is not null then
    for t in select * from inventory_transactions s where party = 'Company billing' and mode = 'INPUT' and source = 'PURCHASE'
               and (s.counterparty_id is null or (s.counterparty_id = p_godown and not exists (select 1 from inventory_transactions o where o.transfer_id = s.transfer_id and o.distributor_id = p_godown))) loop
      tid := coalesce(t.transfer_id, gen_random_uuid());
      update inventory_transactions set counterparty_id = p_godown, transfer_id = tid where id = t.id;
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id, party)
      values (bid, p_godown, t.product_id, 'OUTPUT', t.transaction_date, t.reference, t.quantity, t.unit_price, auth.uid(), 'TRANSFER', t.distributor_id, tid, 'Company billing');
      n_godown := n_godown + 1;
      select min(as_of) into cnt from inventory_batches where distributor_id = p_godown and mode = 'COUNT' and as_of >= t.transaction_date;
      if cnt is not null then
        insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source)
        values (bid, p_godown, t.product_id, 'INPUT', cnt, 'Stock count (billed before this count)', t.quantity, t.unit_price, auth.uid(), 'COUNT');
      end if;
      last_d := greatest(coalesce(last_d, t.transaction_date), t.transaction_date);
    end loop;
  end if;
  update inventory_batches set as_of = last_d where id = bid;
  if n_add = 0 and n_godown = 0 then delete from inventory_batches where id = bid; end if;
  return jsonb_build_object('added', n_add, 'kept', n_kept, 'changed', n_changed, 'changed_lines', changed, 'new_products', n_new, 'count_adjusted', n_count, 'godown_lines', n_godown);
end $$;
revoke all on function public.post_primary_sales(jsonb, text, uuid) from public, anon;
grant execute on function public.post_primary_sales(jsonb, text, uuid) to authenticated;

-- ---------- Stock returned to the godown ----------
-- A super stockist (or distributor) sends stock back: it leaves their stock and comes into the godown,
-- with why, what the freight cost, and how long it had sat with them.
create table if not exists public.stock_returns(
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.inventory_batches(id) on delete cascade,
  from_id uuid references public.distributors(id) on delete set null,
  to_id uuid references public.distributors(id) on delete set null,
  returned_on date not null,
  reason text not null,
  freight numeric(12,2),
  note text,
  quantity numeric(14,3) not null default 0,
  value numeric(14,2) not null default 0,
  days_held numeric(8,1),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.stock_returns enable row level security;
drop policy if exists "read stock returns" on public.stock_returns;
create policy "read stock returns" on public.stock_returns for select to authenticated using (true);
grant select on public.stock_returns to authenticated;

create or replace function public.post_return(p_from uuid, p_to uuid, p_date date, p_reason text, p_freight numeric, p_note text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare l jsonb; bid uuid; tid uuid; pid uuid; q numeric; rate numeric; have numeric; last_in date; n int := 0; tq numeric := 0; tv numeric := 0; td numeric := 0; ref text;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can record returns.'; end if;
  if p_from = p_to then raise exception 'Pick two different locations.'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add the products that came back.'; end if;
  ref := 'Return: ' || coalesce(nullif(trim(p_reason), ''), 'returned');
  insert into inventory_batches(mode, created_by, source_file, distributor_id, as_of)
  values ('OUTPUT', auth.uid(), 'Returned from ' || (select name from distributors where id = p_from) || ' to ' || (select name from distributors where id = p_to), p_from, p_date)
  returning id into bid;
  for l in select value from jsonb_array_elements(p_lines) loop
    pid := (l->>'product_id')::uuid; q := coalesce(nullif(l->>'qty', '')::numeric, 0);
    if q <= 0 then continue; end if;
    perform pg_advisory_xact_lock(hashtext(p_from::text || pid::text));
    have := stock_of(p_from, pid);
    if have < q - 0.001 then raise exception '% holds only % dz of %', (select name from distributors where id = p_from), round(have, 2), (select item_name from products where id = pid); end if;
    select coalesce(nullif(ss_rate, 0), unit_price, 0) into rate from products where id = pid;
    select max(transaction_date) into last_in from inventory_transactions where distributor_id = p_from and product_id = pid and mode = 'INPUT' and transaction_date <= p_date;
    tid := gen_random_uuid();
    insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id)
    values (bid, p_from, pid, 'OUTPUT', p_date, ref, q, rate, auth.uid(), 'TRANSFER', p_to, tid),
           (bid, p_to, pid, 'INPUT', p_date, ref, q, rate, auth.uid(), 'TRANSFER', p_from, tid);
    n := n + 1; tq := tq + q; tv := tv + q * rate; td := td + q * coalesce(p_date - last_in, 0);
  end loop;
  if n = 0 then raise exception 'Add the quantities that came back.'; end if;
  insert into stock_returns(batch_id, from_id, to_id, returned_on, reason, freight, note, quantity, value, days_held)
  values (bid, p_from, p_to, p_date, coalesce(nullif(trim(p_reason), ''), 'returned'), p_freight, nullif(trim(p_note), ''), tq, tv, case when tq > 0 then round(td / tq, 1) end);
  return jsonb_build_object('lines', n, 'quantity', tq, 'value', tv);
end $$;
revoke all on function public.post_return(uuid, uuid, date, text, numeric, text, jsonb) from public, anon;
grant execute on function public.post_return(uuid, uuid, date, text, numeric, text, jsonb) to authenticated;

-- ---------- Staff with similar names who are different people ----------
alter table public.sales_officers add column if not exists not_same uuid[] not null default '{}';
create or replace function public.mark_different_staff(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can change the sales team.'; end if;
  update sales_officers set not_same = array(select distinct x from unnest(not_same || p_b) x) where id = p_a;
  update sales_officers set not_same = array(select distinct x from unnest(not_same || p_a) x) where id = p_b;
end $$;
revoke all on function public.mark_different_staff(uuid, uuid) from public, anon;
grant execute on function public.mark_different_staff(uuid, uuid) to authenticated;

-- ---------- Merging two entries for the same location ----------
-- Everything that points at p_drop (stock, bills, payments, DSR days, retailers, distributors under it,
-- comments, reminders, returns...) moves to p_keep; p_drop's names become p_keep's other names, and
-- p_drop is removed. Every table with a link to a location is found from the database itself, so none is missed.
create or replace function public.merge_locations(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r record; n int; total int := 0; keep_name text;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can merge locations.'; end if;
  if p_keep = p_drop then raise exception 'Pick two different locations.'; end if;
  if not exists (select 1 from distributors where id = p_drop) then raise exception 'That location no longer exists.'; end if;
  select name into keep_name from distributors where id = p_keep;
  if keep_name is null then raise exception 'The location to keep no longer exists.'; end if;
  -- Details the kept entry is missing, and every spelling of the other one.
  update distributors k set
    aliases = array(select distinct x from unnest(coalesce(k.aliases, '{}') || d.name || coalesce(d.company_name, d.name) || coalesce(d.aliases, '{}')) x where norm_name(x) <> norm_name(k.name)),
    company_name = coalesce(k.company_name, d.company_name), owner_name = coalesce(k.owner_name, d.owner_name), phone = coalesce(k.phone, d.phone),
    email = coalesce(k.email, d.email), state = coalesce(k.state, d.state), region = coalesce(k.region, d.region), territory = coalesce(k.territory, d.territory),
    so_id = coalesce(k.so_id, d.so_id)
  from distributors d where k.id = p_keep and d.id = p_drop;
  for r in select c.conrelid::regclass::text tbl, a.attname col
             from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = 'public.distributors'::regclass and array_length(c.conkey, 1) = 1 loop
    begin
      execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_keep, p_drop;
      get diagnostics n = row_count; total := total + n;
    exception when unique_violation then
      -- A one-per-location record both already have (a reminder for the same month, say): the kept one stays.
      execute format('delete from %s where %I = $1', r.tbl, r.col) using p_drop;
    end;
  end loop;
  update distributors set parent_id = null where id = p_keep and parent_id = p_keep;
  update distributors set via_id = null where via_id = id;
  update distributors set super_stockist = keep_name where parent_id = p_keep;
  delete from distributors where id = p_drop;
  return jsonb_build_object('moved', total);
end $$;
revoke all on function public.merge_locations(uuid, uuid) from public, anon;
grant execute on function public.merge_locations(uuid, uuid) to authenticated;

-- ---------- Separating a name that was merged into the wrong person ----------
-- The other name becomes its own person again (same zone and state), and the two are marked as
-- different people so they aren't offered for merging again. Days already merged stay where they are:
-- the app can't tell which of them came from the other name. Sheets from now on match the new person.
create or replace function public.split_staff_name(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path=public as $$
declare src sales_officers%rowtype; nid uuid;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can change the sales team.'; end if;
  select * into src from sales_officers where id = p_id;
  if src.id is null then raise exception 'That person no longer exists.'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'No name to separate.'; end if;
  update sales_officers set aliases = array(select a from unnest(coalesce(aliases, '{}')) a where norm_name(a) <> norm_name(p_name)) where id = p_id;
  select id into nid from sales_officers where norm_name(name) = norm_name(p_name) and id <> p_id limit 1;
  if nid is null then
    insert into sales_officers(code, name, state, zone, designation, active)
    values ('SO' || lpad((coalesce((select max(substring(code from '^SO(\d+)$')::int) from sales_officers), 0) + 1)::text, 3, '0'), trim(p_name), src.state, src.zone, 'SO', true)
    returning id into nid;
  end if;
  update sales_officers set not_same = array(select distinct x from unnest(not_same || nid) x) where id = p_id;
  update sales_officers set not_same = array(select distinct x from unnest(not_same || p_id) x) where id = nid;
  return nid;
end $$;
revoke all on function public.split_staff_name(uuid, text) from public, anon;
grant execute on function public.split_staff_name(uuid, text) to authenticated;

-- ---------- Every SKU in a category ----------
-- A SKU added without a category (from a stock file, a billing sheet or the DSR) gets one straight
-- away, so nothing is listed under "Other": the category of the same SKU under another name, else
-- words in its name ("Lipcolor", "Kajal", "Sindoor"), else the SKUs either side of it in the DSR.
create or replace function public.guess_category(p_name text) returns text
language plpgsql stable security definer set search_path=public as $$
declare n text := lower(coalesce(p_name, '')); c text; pos int;
begin
  if trim(n) = '' then return null; end if;
  select p.category into c from products p
   where coalesce(p.category, '') <> '' and (norm_name(p.item_name) = norm_name(p_name) or norm_name(p.sku) = norm_name(p_name)
      or exists (select 1 from product_aliases a where a.product_id = p.id and norm_name(a.alias) = norm_name(p_name)))
   limit 1;
  if c is not null then return c; end if;
  c := case
    when n ~ '(stand|display|tray|poster|banner|dangler)' then 'POP'
    when n ~ 'makeup remover' then 'Makeup'
    when n ~ '(nail paint|nail polish|waa+h|crystel|crystal)' then 'Nail Paint'
    when n ~ '(npr|nail cleanser|remover|wipes)' then 'NPR'
    when n ~ '(sindoor|sindur)' then 'Sindoor'
    when n ~ '(lip bal|glycerin|glycrine|glycerine|strawberry blast)' then 'Lip Care'
    when n ~ '(lip ?colou?r|lip gloss|lip oil|lip shine|liquid)' then 'Liquid Lipstick'
    when n ~ '(lipstick|lip cra?yon|lip cryon)' then 'Stick Lipstick'
    when n ~ '(kajal|eye ?shadow|blush|eyebrow)' then 'Eye Shadow'
    when n ~ '(eye ?liner|mascara|maskara)' then 'Eye'
    when n ~ '(foundation|compact|illuminator)' then 'Compact'
    when n ~ '(primer|concea?ler|conceler|fixer|highlighter|makeup|sponge|puff)' then 'Makeup'
    when n ~ 'rose water' then 'Rose Water'
    when n ~ 'aloe' then 'Aloevera Gel'
    when n ~ 'cotton' then 'Cotton Buds'
    when n ~ '(lotion|moisturi)' then 'Lotion'
    when n ~ 'cleansing milk' then 'Cleansing Milk'
  end;
  if c is not null then return c; end if;
  -- The DSR lists SKUs group by group: the nearest neighbour with a category, the one above first.
  select position into pos from dsr_products where norm_name(name) = norm_name(p_name) and position is not null limit 1;
  if pos is not null then
    select x.pc into c from (
      select (select p.category from products p where coalesce(p.category, '') <> '' and (norm_name(p.item_name) = norm_name(d.name) or norm_name(p.sku) = norm_name(d.name)) limit 1) pc,
             abs(d.position - pos) dist, d.position < pos above
        from dsr_products d where d.position is not null and d.position <> pos and abs(d.position - pos) <= 3) x
     where x.pc is not null order by x.dist, x.above desc limit 1;
  end if;
  return c;
end $$;
revoke all on function public.guess_category(text) from public, anon;
grant execute on function public.guess_category(text) to authenticated;

create or replace function public.fill_product_category() returns trigger
language plpgsql set search_path=public as $$
begin
  if coalesce(trim(new.category), '') = '' then new.category := coalesce(guess_category(new.item_name), guess_category(new.sku)); end if;
  return new;
end $$;
drop trigger if exists products_fill_category on public.products;
create trigger products_fill_category before insert or update on public.products for each row execute function public.fill_product_category();

-- The DSR's first group is nail paint, and some names say nothing about what the SKU is.
update public.products set category = v.c
  from (values ('waah', 'Nail Paint'), ('mystic', 'Nail Paint'), ('true wear', 'Nail Paint'), ('passion', 'Nail Paint'), ('power play', 'Nail Paint'),
               ('color play', 'Nail Paint'), ('love affair', 'Nail Paint'), ('stunning', 'Nail Paint'), ('sweet sparkle', 'Liquid Lipstick'),
               ('cosmics love', 'Liquid Lipstick'), ('velvet mat', 'Stick Lipstick'), ('ultra mat', 'Stick Lipstick'), ('touch me', 'Compact'),
               ('pink magic', 'Lip Care'), ('flat pink 30ml', 'NPR')) v(n, c)
 where coalesce(products.category, '') = '' and norm_name(products.item_name) = norm_name(v.n);
update public.products set category = guess_category(item_name) where coalesce(category, '') = '';

-- DSR product totals by category: DSR sheets carry no category, so each product takes its SKU's.
create or replace function public.dsr_product_totals(p_from date, p_to date, p_sos uuid[] default null, p_state text default null)
returns table(product text, category text, qty numeric, value numeric)
language sql stable set search_path=public as $$
  select t.product, coalesce(nullif(t.category, ''), guess_category(t.product)), t.qty, t.value from (
    select l.product, max(l.category) category, sum(l.qty) qty, sum(l.value) value
      from dsr_lines l join dsr_days d on d.id = l.day_id
     where d.day between p_from and p_to and (p_sos is null or d.so_id = any(p_sos)) and (p_state is null or d.state = p_state)
     group by l.product) t
$$;
revoke all on function public.dsr_product_totals(date, date, uuid[], text) from public, anon;
grant execute on function public.dsr_product_totals(date, date, uuid[], text) to authenticated;

-- ---------- One SKU entered under two names ----------
-- "Strawberry Blast Tube" and "Strawberry Blast Tube 10 Gm" are one SKU: everything recorded for the
-- second moves to the first, and its names are kept so files match it. A stock count is a count of the
-- whole SKU, so each location's counts are worked through again in the order they were posted: a count
-- sets the SKU's stock to what that file said (both names added up when one file had both), instead of
-- the two names' stock being added together.
create or replace function public.merge_products(p_keep uuid, p_drop uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r record; c record; moved int := 0; locs int := 0; bal numeric; diff numeric; first_id uuid; keep_name text; keep_sku text;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can merge SKUs.'; end if;
  if p_keep = p_drop then raise exception 'Pick two different SKUs.'; end if;
  select item_name, sku into keep_name, keep_sku from products where id = p_keep;
  if keep_name is null then raise exception 'The SKU to keep no longer exists.'; end if;
  if not exists (select 1 from products where id = p_drop) then raise exception 'That SKU no longer exists.'; end if;
  -- What each stock count said, per name, before the two names are joined.
  create temp table if not exists merge_counted(batch_id uuid, location_id uuid, at timestamptz, qty numeric) on commit drop;
  delete from merge_counted where true; -- the API refuses a delete without a where
  insert into merge_counted
    select t.batch_id, t.distributor_id, t.created_at,
           (select coalesce(sum(case when x.mode = 'INPUT' then x.quantity else -x.quantity end), 0) from inventory_transactions x
             where x.distributor_id = t.distributor_id and x.product_id = t.product_id and x.created_at <= t.created_at)
      from inventory_transactions t
     where t.product_id in (p_keep, p_drop) and t.source = 'COUNT' and t.batch_id is not null;
  update inventory_transactions set product_id = p_keep where product_id = p_drop;
  get diagnostics moved = row_count;
  for r in select c2.conrelid::regclass::text tbl, a.attname col
             from pg_constraint c2 join pg_attribute a on a.attrelid = c2.conrelid and a.attnum = c2.conkey[1]
            where c2.contype = 'f' and c2.confrelid = 'public.products'::regclass and array_length(c2.conkey, 1) = 1
              and c2.conrelid not in ('public.inventory_transactions'::regclass, 'public.product_aliases'::regclass) loop
    begin
      execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_keep, p_drop;
    exception when unique_violation then
      execute format('delete from %s where %I = $1', r.tbl, r.col) using p_drop;
    end;
  end loop;
  update product_aliases set product_id = p_keep where product_id = p_drop;
  insert into product_aliases(product_id, alias)
    select distinct p_keep, x from (select item_name x from products where id = p_drop union select sku from products where id = p_drop) s
     where nullif(trim(x), '') is not null and norm_name(x) not in (norm_name(keep_name), norm_name(keep_sku))
    on conflict do nothing;
  -- Counts again, location by location, in the order they were posted.
  for c in select distinct location_id from merge_counted loop
    locs := locs + 1;
    for r in select batch_id, max(at) at, sum(qty) q from merge_counted where location_id = c.location_id group by batch_id order by max(at) loop
      select coalesce(sum(case when mode = 'INPUT' then quantity else -quantity end), 0) into bal from inventory_transactions
       where distributor_id = c.location_id and product_id = p_keep and created_at <= r.at and not (source = 'COUNT' and batch_id is not distinct from r.batch_id);
      diff := r.q - bal;
      select id into first_id from inventory_transactions
       where distributor_id = c.location_id and product_id = p_keep and batch_id = r.batch_id and source = 'COUNT' order by created_at, id limit 1;
      delete from inventory_transactions
       where distributor_id = c.location_id and product_id = p_keep and batch_id = r.batch_id and source = 'COUNT' and id <> first_id;
      if diff = 0 then delete from inventory_transactions where id = first_id;
      else update inventory_transactions set mode = case when diff > 0 then 'INPUT' else 'OUTPUT' end, quantity = abs(diff) where id = first_id;
      end if;
    end loop;
  end loop;
  update products k set category = coalesce(nullif(k.category, ''), d.category), box_pcs = coalesce(k.box_pcs, d.box_pcs),
    ss_rate = coalesce(k.ss_rate, d.ss_rate), mrp = coalesce(k.mrp, d.mrp),
    unit_price = case when coalesce(k.unit_price, 0) = 0 then d.unit_price else k.unit_price end
    from products d where k.id = p_keep and d.id = p_drop;
  delete from products where id = p_drop;
  return jsonb_build_object('moved', moved, 'locations', locs);
end $$;
revoke all on function public.merge_products(uuid, uuid) from public, anon;
grant execute on function public.merge_products(uuid, uuid) to authenticated;

-- ---------- Distributors in the same market ----------
-- For each distributor and SO: the first and last day the SO booked there, from the DSRs and SO reports.
-- A new party opened next to an old one, with the same SO moving across, is a red flag.
create or replace function public.distributor_booking_span() returns table(distributor_id uuid, so_id uuid, first_day date, last_day date, days int)
language sql stable set search_path=public as $$
  select distributor_id, so_id, min(d), max(d), count(distinct d)::int from (
    select distributor_id, so_id, day d from dsr_days where distributor_id is not null
    union all
    select distributor_id, so_id, report_date from so_report_lines) x
   group by 1, 2
$$;
revoke all on function public.distributor_booking_span() from public, anon;
grant execute on function public.distributor_booking_span() to authenticated;
