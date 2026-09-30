-- STEP 10 — run after 009. Safe to run more than once.
-- Sales staff hierarchy (ASM → ASE → SO/ISR/SR) with zones and HQs; DSR uploads that add new days
-- and keep days already logged unless asked to replace them; state totals to check SO sheets against;
-- product totals by zone; and a log book of who used the app and for how long.

-- ---------- Staff ----------
alter table public.sales_officers add column if not exists designation text not null default 'SO';
alter table public.sales_officers add column if not exists manager_id uuid references public.sales_officers(id) on delete set null;
alter table public.sales_officers add column if not exists hq text;
alter table public.sales_officers add column if not exists zone text;    -- sales zone as the staff list names it, e.g. North Bihar
alter table public.sales_officers add column if not exists areas text;   -- towns and beats covered

-- ---------- DSR state totals ----------
create table if not exists public.dsr_state_days(
  state text not null, day date not null,
  total_calls int, productive_calls int, sale_value numeric(14,2),
  source_file text, updated_at timestamptz not null default now(),
  primary key (state, day)
);
alter table public.dsr_state_days enable row level security;
drop policy if exists "read dsr state days" on public.dsr_state_days;
create policy "read dsr state days" on public.dsr_state_days for select to authenticated using (true);
grant select on public.dsr_state_days to authenticated;

-- A whole number from a sheet, or null when it isn't one or is too large for the column.
create or replace function public.safe_int(t text) returns int
language sql immutable as $$
  select case when trim(t) ~ '^-?[0-9]+([.][0-9]+)?$' then case when abs(trim(t)::numeric) < 2147483647 then round(trim(t)::numeric)::int end end
$$;
-- A money figure from a sheet, or null when it isn't one or is too large for the column.
create or replace function public.safe_money(t text) returns numeric
language sql immutable as $$
  select case when trim(t) ~ '^-?[0-9]+([.][0-9]+)?$' then case when abs(trim(t)::numeric) < 1000000000000 then round(trim(t)::numeric, 2) end end
$$;

-- Adds DSR days. A person's day that is already logged is kept unless p_replace is true, so the
-- same workbook can be uploaded every day and only the new days go in. The reporting manager on
-- the sheet becomes the person's senior (added as an ASM if not on the staff list).
drop function if exists public.post_dsr(jsonb, jsonb, text);
create or replace function public.post_dsr(p_days jsonb, p_products jsonb, p_source text, p_state_days jsonb default '[]'::jsonb, p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare d jsonb; sid uuid; mid uuid; did uuid; n_new int := 0; n_kept int := 0; n_replaced int := 0; n_lines int := 0; k int; new_sos int := 0; nm text; mg text; existed boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  insert into dsr_products(name, category, rate, position)
    select distinct on (x->>'name') x->>'name', x->>'category', safe_money(x->>'rate'), safe_int(x->>'position') from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) x where nullif(trim(x->>'name'), '') is not null
    on conflict (name) do update set category = coalesce(nullif(excluded.category, ''), dsr_products.category), rate = coalesce(excluded.rate, dsr_products.rate), position = excluded.position, updated_at = now();
  -- Products without a category take the DSR's (by name or another spelling), so stock is grouped the DSR way.
  update products p set category = d.category from dsr_products d
   where coalesce(p.category, '') = '' and coalesce(d.category, '') <> ''
     and (norm_name(d.name) in (norm_name(p.item_name), norm_name(p.sku)) or exists (select 1 from product_aliases a where a.product_id = p.id and norm_name(a.alias) = norm_name(d.name)));
  -- A state total saved before totals were kept per workbook (no team) gives way to the per-workbook one.
  delete from dsr_state_days s using jsonb_array_elements(coalesce(p_state_days, '[]'::jsonb)) x
   where s.state = x->>'state' and s.day = (x->>'day')::date and s.team = '' and coalesce(x->>'team', '') <> '';
  insert into dsr_state_days(state, day, team, total_calls, productive_calls, sale_value, source_file)
    select distinct on (x->>'state', (x->>'day')::date, coalesce(x->>'team', '')) x->>'state', (x->>'day')::date, coalesce(x->>'team', ''), safe_int(x->>'total_calls'), safe_int(x->>'productive_calls'), safe_money(x->>'sale_value'), p_source
      from jsonb_array_elements(coalesce(p_state_days, '[]'::jsonb)) x
    on conflict (state, day, team) do update set total_calls = excluded.total_calls, productive_calls = excluded.productive_calls, sale_value = excluded.sale_value,
      source_file = excluded.source_file, updated_at = now();
  for d in select * from jsonb_array_elements(p_days) loop
    nm := trim(d->>'so');
    sid := find_so(nm);
    if sid is null then
      insert into sales_officers(code, name, state, region, zone, hq, designation)
      values ('SO' || lpad((coalesce((select max(substring(code from '^SO(\d+)$')::int) from sales_officers), 0) + 1)::text, 3, '0'), nm, d->>'state', d->>'hq', d->>'state', d->>'hq', 'SO')
      returning id into sid;
      new_sos := new_sos + 1;
    end if;
    mg := trim(coalesce(d->>'manager', ''));
    if mg <> '' then
      mid := find_so(mg);
      if mid is null then
        insert into sales_officers(code, name, state, zone, designation)
        values ('SO' || lpad((coalesce((select max(substring(code from '^SO(\d+)$')::int) from sales_officers), 0) + 1)::text, 3, '0'), mg, d->>'state', d->>'state', 'ASM')
        returning id into mid;
        new_sos := new_sos + 1;
      end if;
      update sales_officers set manager_id = mid where id = sid and manager_id is null and mid <> sid;
    end if;
    select id into did from dsr_days where so_id = sid and day = (d->>'day')::date;
    existed := did is not null;
    if existed and not p_replace then n_kept := n_kept + 1; continue; end if;
    insert into dsr_days(so_id, day, state, manager, hq, db_name, distributor_id, town, beat, remark, attendance, total_calls, productive_calls, sale_value, source_file, updated_at)
    values (sid, (d->>'day')::date, d->>'state', d->>'manager', d->>'hq', nullif(d->>'db_name', ''), find_distributor(nullif(d->>'db_name', '')),
            d->>'town', d->>'beat', d->>'remark', d->>'attendance',
            coalesce(safe_int(d->>'total_calls'), 0), coalesce(safe_int(d->>'productive_calls'), 0),
            coalesce(safe_money(d->>'sale_value'), 0), p_source, now())
    on conflict (so_id, day) do update set state = excluded.state, manager = excluded.manager, hq = excluded.hq, db_name = excluded.db_name,
      distributor_id = excluded.distributor_id, town = excluded.town, beat = excluded.beat, remark = excluded.remark, attendance = excluded.attendance,
      total_calls = excluded.total_calls, productive_calls = excluded.productive_calls, sale_value = excluded.sale_value,
      source_file = excluded.source_file, updated_at = now()
    returning id into did;
    delete from dsr_lines where day_id = did;
    -- The same product twice on one day (two columns with the same name in a sheet) is added up first:
    -- one statement can't update the same line twice.
    insert into dsr_lines(day_id, product, category, qty, rate, value)
      select did, l->>'product', max(l->>'category'), sum(safe_money(l->>'qty')), max(safe_money(l->>'rate')),
             round(sum(safe_money(l->>'qty') * coalesce(safe_money(l->>'rate'), 0)), 2)
        from jsonb_array_elements(coalesce(d->'lines', '[]'::jsonb)) l
       where coalesce(safe_money(l->>'qty'), 0) <> 0 and nullif(trim(l->>'product'), '') is not null
       group by l->>'product'
      on conflict (day_id, product) do update set qty = dsr_lines.qty + excluded.qty, value = dsr_lines.value + excluded.value;
    get diagnostics k = row_count;
    n_lines := n_lines + k;
    if existed then n_replaced := n_replaced + 1; else n_new := n_new + 1; end if;
  end loop;
  return jsonb_build_object('added', n_new, 'kept', n_kept, 'replaced', n_replaced, 'lines', n_lines, 'new_sos', new_sos);
end $$;
revoke all on function public.post_dsr(jsonb, jsonb, text, jsonb, boolean) from public, anon;
grant execute on function public.post_dsr(jsonb, jsonb, text, jsonb, boolean) to authenticated;

-- Products in DSRs over a period, optionally for some people or one zone/state.
drop function if exists public.dsr_product_totals(date, date, uuid);
create or replace function public.dsr_product_totals(p_from date, p_to date, p_sos uuid[] default null, p_state text default null)
returns table(product text, category text, qty numeric, value numeric)
language sql stable set search_path=public as $$
  select l.product, max(l.category), sum(l.qty), sum(l.value)
    from dsr_lines l join dsr_days d on d.id = l.day_id
   where d.day between p_from and p_to and (p_sos is null or d.so_id = any(p_sos)) and (p_state is null or d.state = p_state)
   group by l.product
$$;
revoke all on function public.dsr_product_totals(date, date, uuid[], text) from public, anon;
grant execute on function public.dsr_product_totals(date, date, uuid[], text) to authenticated;

-- ---------- Log book ----------
create table if not exists public.user_sessions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active_seconds int not null default 0,
  user_agent text
);
create index if not exists user_sessions_user on public.user_sessions(user_id, started_at);
alter table public.user_sessions enable row level security;
drop policy if exists "start own session" on public.user_sessions;
create policy "start own session" on public.user_sessions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "read sessions" on public.user_sessions;
create policy "read sessions" on public.user_sessions for select to authenticated using (user_id = auth.uid() or public.is_admin());
grant select, insert on public.user_sessions to authenticated;

-- Called every minute while the app is open; p_active is how many of those seconds had someone using it.
create or replace function public.touch_session(p_id uuid, p_active int) returns void
language sql security definer set search_path=public as $$
  update user_sessions set last_seen = now(), active_seconds = active_seconds + greatest(0, least(coalesce(p_active, 0), 120))
   where id = p_id and user_id = auth.uid()
$$;
revoke all on function public.touch_session(uuid, int) from public, anon;
grant execute on function public.touch_session(uuid, int) to authenticated;
