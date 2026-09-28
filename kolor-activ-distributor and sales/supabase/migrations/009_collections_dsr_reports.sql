-- STEP 9 — run after 008. Safe to run more than once.
-- Payments (collections) from retailers, distributors and super stockists; billing vs collection
-- per party; SO daily sales reports (DSR) with attendance; month-by-month figures for one location.

-- ---------- Collections ----------
create table if not exists public.payments(
  id uuid primary key default gen_random_uuid(),
  payer_id uuid references public.distributors(id) on delete cascade,        -- distributor or super stockist paying
  payer_retailer_id uuid references public.retailers(id) on delete cascade,  -- or a retailer paying its distributor
  payee_id uuid references public.distributors(id) on delete set null,       -- who received it; null = the company
  paid_on date not null,
  amount numeric(14,2) not null check (amount > 0),
  mode text, reference text, note text, source_file text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (payer_id is not null or payer_retailer_id is not null)
);
create index if not exists payments_payer on public.payments(payer_id, paid_on);
create index if not exists payments_retailer on public.payments(payer_retailer_id, paid_on);
alter table public.payments enable row level security;
drop policy if exists "read payments" on public.payments;
create policy "read payments" on public.payments for select to authenticated using (true);
drop policy if exists "managers change payments" on public.payments;
create policy "managers change payments" on public.payments for all to authenticated using (public.is_manager()) with check (public.is_manager());
grant select, insert, update, delete on public.payments to authenticated;

-- What each party was billed and what it paid. Billing is the stock it received from its supplier
-- (godown dispatch for a super stockist, SS dispatch or purchase for a distributor, distributor sale
-- for a retailer), at the invoice rate when the file had one, otherwise at the SS rate with the margins.
create or replace function public.billing_summary(p_from date, p_to date)
returns table(party_type text, party_id uuid, billed numeric, collected numeric, billed_all numeric, collected_all numeric, last_bill date, last_payment date)
language sql stable security definer set search_path=public as $$
  with m as (select coalesce((value->>'ss')::numeric, 10) ss, coalesce((value->>'distributor')::numeric, 15) dist from app_settings where key = 'margins'),
  bills as (
    select 'LOCATION'::text pt, t.distributor_id pid, t.transaction_date d,
           t.quantity * case when coalesce(t.unit_price, 0) > 0 then t.unit_price
                             when l.kind = 'SUPER_STOCKIST' then ss_billing_rate(t.product_id, l.id, t.transaction_date)
                             else value_rate(t.product_id) * (1 + coalesce((select ss from m), 10) / 100) end v
      from inventory_transactions t join distributors l on l.id = t.distributor_id
     where t.mode = 'INPUT' and t.source in ('TRANSFER', 'PURCHASE') and l.kind in ('SUPER_STOCKIST', 'DISTRIBUTOR')
    union all
    select 'RETAILER', t.retailer_id, t.transaction_date,
           t.quantity * case when coalesce(t.unit_price, 0) > 0 then t.unit_price
                             else value_rate(t.product_id) * (1 + coalesce((select ss from m), 10) / 100) * (1 + coalesce((select dist from m), 15) / 100) end
      from inventory_transactions t
     where t.mode = 'OUTPUT' and t.retailer_id is not null),
  pays as (
    select case when payer_retailer_id is not null then 'RETAILER' else 'LOCATION' end pt, coalesce(payer_retailer_id, payer_id) pid, paid_on d, amount v from payments),
  bs as (select pt, pid, sum(v) filter (where d between p_from and p_to) b, sum(v) filter (where d <= p_to) ba, max(d) filter (where d <= p_to) lb from bills group by 1, 2),
  ps as (select pt, pid, sum(v) filter (where d between p_from and p_to) c, sum(v) filter (where d <= p_to) ca, max(d) filter (where d <= p_to) lp from pays group by 1, 2)
  select coalesce(bs.pt, ps.pt), coalesce(bs.pid, ps.pid), coalesce(bs.b, 0), coalesce(ps.c, 0), coalesce(bs.ba, 0), coalesce(ps.ca, 0), bs.lb, ps.lp
  from bs full join ps on ps.pt = bs.pt and ps.pid = bs.pid
  where coalesce(bs.pid, ps.pid) is not null
$$;

-- ---------- SO daily sales reports (DSR) ----------
create table if not exists public.dsr_days(
  id uuid primary key default gen_random_uuid(),
  so_id uuid not null references public.sales_officers(id) on delete cascade,
  day date not null,
  state text, manager text, hq text, db_name text,
  distributor_id uuid references public.distributors(id) on delete set null,
  town text, beat text, remark text, attendance text,
  total_calls int not null default 0, productive_calls int not null default 0,
  sale_value numeric(14,2) not null default 0,
  source_file text, updated_at timestamptz not null default now(),
  unique (so_id, day)
);
create index if not exists dsr_days_day on public.dsr_days(day);
create index if not exists dsr_days_dist on public.dsr_days(distributor_id, day);
create table if not exists public.dsr_lines(
  day_id uuid not null references public.dsr_days(id) on delete cascade,
  product text not null, category text,
  qty numeric(12,3) not null, rate numeric(12,2), value numeric(14,2),
  primary key (day_id, product)
);
-- The DSR's own price list: SS rate per dozen by product.
create table if not exists public.dsr_products(
  name text primary key, category text, rate numeric(12,2), position int, updated_at timestamptz not null default now()
);
alter table public.dsr_days enable row level security;
alter table public.dsr_lines enable row level security;
alter table public.dsr_products enable row level security;
drop policy if exists "read dsr days" on public.dsr_days;
create policy "read dsr days" on public.dsr_days for select to authenticated using (true);
drop policy if exists "read dsr lines" on public.dsr_lines;
create policy "read dsr lines" on public.dsr_lines for select to authenticated using (true);
drop policy if exists "read dsr products" on public.dsr_products;
create policy "read dsr products" on public.dsr_products for select to authenticated using (true);
drop policy if exists "managers delete dsr days" on public.dsr_days;
create policy "managers delete dsr days" on public.dsr_days for delete to authenticated using (public.is_manager());
grant select on public.dsr_days, public.dsr_lines, public.dsr_products to authenticated;
grant delete on public.dsr_days to authenticated;

-- Posts a DSR workbook. Each SO-day replaces what was there, so the same sheet can be uploaded
-- again every day. SOs are found by name or other name, and added if new.
create or replace function public.post_dsr(p_days jsonb, p_products jsonb, p_source text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare d jsonb; sid uuid; did uuid; n_days int := 0; n_lines int := 0; k int; new_sos int := 0; nm text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  insert into dsr_products(name, category, rate, position)
    select x->>'name', x->>'category', nullif(x->>'rate', '')::numeric, (x->>'position')::int from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) x
    on conflict (name) do update set category = coalesce(nullif(excluded.category, ''), dsr_products.category), rate = coalesce(excluded.rate, dsr_products.rate), position = excluded.position, updated_at = now();
  for d in select * from jsonb_array_elements(p_days) loop
    nm := trim(d->>'so');
    sid := find_so(nm);
    if sid is null then
      insert into sales_officers(code, name, state, region)
      values ('SO' || lpad((coalesce((select max(substring(code from '^SO(\d+)$')::int) from sales_officers), 0) + 1)::text, 3, '0'), nm, d->>'state', d->>'hq')
      returning id into sid;
      new_sos := new_sos + 1;
    end if;
    insert into dsr_days(so_id, day, state, manager, hq, db_name, distributor_id, town, beat, remark, attendance, total_calls, productive_calls, sale_value, source_file, updated_at)
    values (sid, (d->>'day')::date, d->>'state', d->>'manager', d->>'hq', nullif(d->>'db_name', ''), find_distributor(nullif(d->>'db_name', '')),
            d->>'town', d->>'beat', d->>'remark', d->>'attendance',
            coalesce(nullif(d->>'total_calls', '')::numeric, 0)::int, coalesce(nullif(d->>'productive_calls', '')::numeric, 0)::int,
            coalesce(nullif(d->>'sale_value', '')::numeric, 0), p_source, now())
    on conflict (so_id, day) do update set state = excluded.state, manager = excluded.manager, hq = excluded.hq, db_name = excluded.db_name,
      distributor_id = excluded.distributor_id, town = excluded.town, beat = excluded.beat, remark = excluded.remark, attendance = excluded.attendance,
      total_calls = excluded.total_calls, productive_calls = excluded.productive_calls, sale_value = excluded.sale_value,
      source_file = excluded.source_file, updated_at = now()
    returning id into did;
    delete from dsr_lines where day_id = did;
    insert into dsr_lines(day_id, product, category, qty, rate, value)
      select did, l->>'product', l->>'category', (l->>'qty')::numeric, nullif(l->>'rate', '')::numeric,
             round((l->>'qty')::numeric * coalesce(nullif(l->>'rate', '')::numeric, 0), 2)
        from jsonb_array_elements(coalesce(d->'lines', '[]'::jsonb)) l
       where coalesce(nullif(l->>'qty', '')::numeric, 0) <> 0
      on conflict (day_id, product) do update set qty = dsr_lines.qty + excluded.qty, value = dsr_lines.value + excluded.value;
    get diagnostics k = row_count;
    n_days := n_days + 1; n_lines := n_lines + k;
  end loop;
  return jsonb_build_object('days', n_days, 'lines', n_lines, 'new_sos', new_sos);
end $$;

-- Products sold in DSRs over a period (dozens and value), optionally for one SO.
create or replace function public.dsr_product_totals(p_from date, p_to date, p_so uuid default null)
returns table(product text, category text, qty numeric, value numeric)
language sql stable set search_path=public as $$
  select l.product, max(l.category), sum(l.qty), sum(l.value)
    from dsr_lines l join dsr_days d on d.id = l.day_id
   where d.day between p_from and p_to and (p_so is null or d.so_id = p_so)
   group by l.product
$$;

-- ---------- One location, month by month ----------
create or replace function public.location_months(p_location uuid, p_months int default 13)
returns table(month date, bought_units numeric, bought_value numeric, sold_units numeric, sold_value numeric,
              closing_units numeric, closing_value numeric, paid numeric, so_value numeric)
language sql stable security definer set search_path=public as $$
  with m as (select (date_trunc('month', current_date) - make_interval(months => g))::date ms
               from generate_series(0, least(greatest(p_months, 1), 60) - 1) g),
  t as (select t.mode, t.source, t.quantity q, t.transaction_date d, coalesce(nullif(p.ss_rate, 0), p.unit_price, 0) r
          from inventory_transactions t join products p on p.id = t.product_id where t.distributor_id = p_location)
  select m.ms,
    coalesce(sum(t.q) filter (where t.mode = 'INPUT' and t.source in ('TRANSFER', 'PURCHASE') and date_trunc('month', t.d) = m.ms), 0),
    coalesce(sum(t.q * t.r) filter (where t.mode = 'INPUT' and t.source in ('TRANSFER', 'PURCHASE') and date_trunc('month', t.d) = m.ms), 0),
    coalesce(sum(t.q) filter (where t.mode = 'OUTPUT' and date_trunc('month', t.d) = m.ms), 0),
    coalesce(sum(t.q * t.r) filter (where t.mode = 'OUTPUT' and date_trunc('month', t.d) = m.ms), 0),
    coalesce(sum(case when t.mode = 'INPUT' then t.q else -t.q end) filter (where t.d < m.ms + interval '1 month'), 0),
    coalesce(sum(case when t.mode = 'INPUT' then t.q else -t.q end * t.r) filter (where t.d < m.ms + interval '1 month'), 0),
    (select coalesce(sum(amount), 0) from payments y where y.payer_id = p_location and date_trunc('month', y.paid_on) = m.ms),
    (select coalesce(sum(sale_value), 0) from dsr_days s where s.distributor_id = p_location and date_trunc('month', s.day) = m.ms)
  from m left join t on true
  group by m.ms order by m.ms
$$;

revoke all on function public.billing_summary(date, date) from public, anon;
grant execute on function public.billing_summary(date, date) to authenticated;
revoke all on function public.post_dsr(jsonb, jsonb, text) from public, anon;
grant execute on function public.post_dsr(jsonb, jsonb, text) to authenticated;
revoke all on function public.dsr_product_totals(date, date, uuid) from public, anon;
grant execute on function public.dsr_product_totals(date, date, uuid) to authenticated;
revoke all on function public.location_months(uuid, int) from public, anon;
grant execute on function public.location_months(uuid, int) to authenticated;
