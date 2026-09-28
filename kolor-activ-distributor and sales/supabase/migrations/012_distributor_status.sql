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
