-- STEP 5 — run after 004. Safe to run more than once.
-- Adds: godowns and super stockists as stock locations (with state and region), stock
-- transfers between locations, retailer details, comments on distributors, sales officers
-- and their daily reports, and the functions behind stock downloads and SO checks.
-- The v3 app keeps working after this runs, so it can be run before the new code goes live.

-- ---------- Locations: godown → super stockist → distributor ----------
-- The distributors table now holds every place that keeps stock. kind says which it is;
-- parent_id links a distributor to its super stockist.
alter table public.distributors add column if not exists kind text not null default 'DISTRIBUTOR';
alter table public.distributors drop constraint if exists distributors_kind_check;
alter table public.distributors add constraint distributors_kind_check check (kind in ('GODOWN','SUPER_STOCKIST','DISTRIBUTOR'));
alter table public.distributors add column if not exists parent_id uuid references public.distributors(id) on delete set null;
alter table public.distributors add column if not exists state text;
alter table public.distributors add column if not exists region text;
create index if not exists distributors_parent on public.distributors(parent_id);
create index if not exists distributors_state on public.distributors(state, region);

-- v3 stored the super stockist as free text. Turn each name into a super stockist record and link it.
do $$
declare s text; n int; sid uuid;
begin
  for s in select distinct trim(super_stockist) from public.distributors
            where kind = 'DISTRIBUTOR' and parent_id is null and nullif(trim(super_stockist), '') is not null loop
    select id into sid from public.distributors where kind = 'SUPER_STOCKIST' and public.norm_name(name) = public.norm_name(s) limit 1;
    if sid is null then
      select coalesce(max(substring(code from '^SS(\d+)$')::int), 0) + 1 into n from public.distributors where code ~ '^SS\d+$';
      insert into public.distributors(code, name, kind) values ('SS' || lpad(n::text, 3, '0'), s, 'SUPER_STOCKIST') returning id into sid;
    end if;
    update public.distributors set parent_id = sid
     where kind = 'DISTRIBUTOR' and parent_id is null and public.norm_name(super_stockist) = public.norm_name(s);
  end loop;
end $$;

-- ---------- Stock movements: where stock came from and went to ----------
-- source: PURCHASE (from a supplier), SALE (to a retailer or outside party),
-- TRANSFER (between two of your locations), COUNT (stock count difference).
alter table public.inventory_transactions add column if not exists source text;
alter table public.inventory_transactions drop constraint if exists inventory_transactions_source_check;
alter table public.inventory_transactions add constraint inventory_transactions_source_check check (source in ('PURCHASE','SALE','TRANSFER','COUNT'));
alter table public.inventory_transactions add column if not exists counterparty_id uuid references public.distributors(id);
alter table public.inventory_transactions add column if not exists party text;
alter table public.inventory_transactions add column if not exists transfer_id uuid;
create index if not exists inv_tx_date on public.inventory_transactions(transaction_date);
create index if not exists inv_tx_loc_date on public.inventory_transactions(distributor_id, transaction_date);
create index if not exists inv_tx_transfer on public.inventory_transactions(transfer_id);

-- Rows written by the v3 functions get a source too.
create or replace function public.tx_default_source() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.source is null then
    new.source := case when new.reference = 'Stock count' then 'COUNT'
                       when new.counterparty_id is not null then 'TRANSFER'
                       when new.mode = 'INPUT' then 'PURCHASE' else 'SALE' end;
  end if;
  return new;
end $$;
drop trigger if exists tx_default_source on public.inventory_transactions;
create trigger tx_default_source before insert on public.inventory_transactions
  for each row execute function public.tx_default_source();
update public.inventory_transactions
   set source = case when reference = 'Stock count' then 'COUNT' when mode = 'INPUT' then 'PURCHASE' else 'SALE' end
 where source is null;

-- as_of: the stock count date, or the last date in a movement file.
alter table public.inventory_batches add column if not exists as_of date;
update public.inventory_batches b
   set as_of = (select max(t.transaction_date) from public.inventory_transactions t where t.batch_id = b.id)
 where as_of is null;

create or replace function public.stock_of(p_location uuid, p_product uuid) returns numeric
language sql stable set search_path=public as $$
  select coalesce(sum(case when mode = 'INPUT' then quantity else -quantity end), 0)
    from inventory_transactions where distributor_id = p_location and product_id = p_product
$$;

-- ---------- Stock received / sent out, including transfers ----------
-- p_type IN:  stock received at the location. If the party ("retailer" field) is one of your
--             locations it's a transfer: the sender's stock goes down by the same amount
--             (skipped with p_reduce_sender = false when the sender's stock isn't in the app).
-- p_type OUT: stock sent out. To one of your locations = transfer (their stock goes up);
--             otherwise a sale to a retailer (created if new) or, from a godown, an outside party.
create or replace function public.post_movements(
  p_type text, p_rows jsonb, p_holder text default null, p_source_file text default null,
  p_file_hash text default null, p_allow_duplicate boolean default false, p_reduce_sender boolean default true)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  r jsonb; bid uuid; hid uuid; first_hid uuid; many boolean := false; hkind text; cid uuid; pid uuid; rid uuid; tid uuid;
  q numeric; rate numeric; d date; last_d date; ref text; party text; what text; who text; avail numeric;
  n int := 0; n_tr int := 0; prev timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_type not in ('IN','OUT') then raise exception 'Invalid type %', p_type; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to post'; end if;
  if p_file_hash is not null and not p_allow_duplicate then
    select created_at into prev from inventory_batches where file_hash = p_file_hash order by created_at desc limit 1;
    if prev is not null then raise exception 'DUPLICATE_FILE: this file was already posted on %', to_char(prev at time zone 'Asia/Kolkata','DD Mon YYYY HH24:MI'); end if;
  end if;

  insert into inventory_batches(mode, created_by, source_file, file_hash)
  values (case when p_type = 'IN' then 'INPUT' else 'OUTPUT' end, auth.uid(), p_source_file, p_file_hash) returning id into bid;

  for r in select value from jsonb_array_elements(p_rows) loop
    who := coalesce(nullif(trim(r->>'distributor'), ''), p_holder);
    hid := find_distributor(who);
    if hid is null then raise exception 'Location not found: "%". Add it on the Distributors page, or save this spelling as its other name.', coalesce(who, ''); end if;
    select kind into hkind from distributors where id = hid;
    if first_hid is null then first_hid := hid; elsif first_hid <> hid then many := true; end if;

    what := coalesce(nullif(trim(r->>'item_name'), ''), nullif(trim(r->>'sku'), ''));
    if what is null then raise exception 'Row without product name or SKU'; end if;
    q := coalesce(nullif(r->>'quantity', '')::numeric, 0);
    if q <= 0 then raise exception 'Invalid quantity for "%"', what; end if;
    rate := coalesce(nullif(r->>'unit_price', '')::numeric, 0);
    d := coalesce(nullif(r->>'date', '')::date, current_date);
    last_d := greatest(coalesce(last_d, d), d);
    ref := nullif(trim(r->>'reference'), '');
    party := nullif(trim(r->>'retailer'), '');
    cid := find_distributor(party);
    if cid = hid then cid := null; end if;
    pid := find_product(r->>'sku', r->>'item_name');
    rid := null; tid := null;

    if p_type = 'IN' then
      if pid is null then
        insert into products(sku, item_name, unit_price)
        values (coalesce(nullif(trim(r->>'sku'), ''), trim(r->>'item_name')), coalesce(nullif(trim(r->>'item_name'), ''), trim(r->>'sku')), rate)
        returning id into pid;
      elsif rate > 0 then
        update products set unit_price = rate where id = pid;
      end if;
      if cid is not null then
        if p_reduce_sender then
          perform pg_advisory_xact_lock(hashtext(cid::text || pid::text));
          avail := stock_of(cid, pid);
          if avail < q then
            raise exception 'Not enough stock at % for %: the app shows %, the file says % came from there',
              (select name from distributors where id = cid), what, avail, q;
          end if;
          tid := gen_random_uuid();
          insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id)
          values (bid, cid, pid, 'OUTPUT', d, ref, q, rate, auth.uid(), 'TRANSFER', hid, tid);
        end if;
        insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id)
        values (bid, hid, pid, 'INPUT', d, ref, q, rate, auth.uid(), 'TRANSFER', cid, tid);
        n_tr := n_tr + 1;
      else
        insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, party)
        values (bid, hid, pid, 'INPUT', d, ref, q, rate, auth.uid(), 'PURCHASE', party);
      end if;
    else
      if pid is null then raise exception 'Product "%" has never been stocked in', what; end if;
      if cid is null or p_reduce_sender then
        perform pg_advisory_xact_lock(hashtext(hid::text || pid::text));
        avail := stock_of(hid, pid);
        if avail < q then
          raise exception 'Not enough stock at % for %: available %, this file sends out %',
            (select name from distributors where id = hid), what, avail, q;
        end if;
      end if;
      if cid is not null then
        if p_reduce_sender then
          tid := gen_random_uuid();
          insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id)
          values (bid, hid, pid, 'OUTPUT', d, ref, q, rate, auth.uid(), 'TRANSFER', cid, tid);
        end if;
        insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, counterparty_id, transfer_id)
        values (bid, cid, pid, 'INPUT', d, ref, q, rate, auth.uid(), 'TRANSFER', hid, tid);
        n_tr := n_tr + 1;
      else
        if party is null then raise exception 'Row for "%" has no party (who received it)', what; end if;
        if hkind <> 'GODOWN' then
          select id into rid from retailers where distributor_id = hid and norm_name(name) = norm_name(party) limit 1;
          if rid is null then insert into retailers(distributor_id, name) values (hid, party) returning id into rid; end if;
        end if;
        insert into inventory_transactions(batch_id, distributor_id, retailer_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source, party)
        values (bid, hid, rid, pid, 'OUTPUT', d, ref, q, rate, auth.uid(), 'SALE', party);
      end if;
    end if;
    n := n + 1;
  end loop;

  update inventory_batches set distributor_id = case when many then null else first_hid end, as_of = last_d where id = bid;
  return jsonb_build_object('batch_id', bid, 'posted_rows', n, 'transfers', n_tr);
end $$;

-- Same as v3, plus the count date on the posting and source = COUNT on its lines.
create or replace function public.post_stock_count(
  p_distributor text, p_rows jsonb, p_date date default current_date,
  p_source_file text default null, p_file_hash text default null, p_allow_duplicate boolean default false)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r jsonb; bid uuid; did uuid; pid uuid; q numeric; cur numeric; diff numeric; totals jsonb := '{}'::jsonb; rates jsonb := '{}'::jsonb;
        k text; v jsonb; n_in int := 0; n_out int := 0; n_same int := 0; prev timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  did := find_distributor(p_distributor);
  if did is null then raise exception 'Location not found: "%"', p_distributor; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to post'; end if;
  if p_file_hash is not null and not p_allow_duplicate then
    select created_at into prev from inventory_batches where file_hash = p_file_hash order by created_at desc limit 1;
    if prev is not null then raise exception 'DUPLICATE_FILE: this file was already posted on %', to_char(prev at time zone 'Asia/Kolkata','DD Mon YYYY HH24:MI'); end if;
  end if;

  insert into inventory_batches(mode, created_by, source_file, file_hash, distributor_id, as_of)
  values ('COUNT', auth.uid(), p_source_file, p_file_hash, did, coalesce(p_date, current_date)) returning id into bid;

  for r in select value from jsonb_array_elements(p_rows) loop
    q := coalesce(nullif(r->>'quantity', '')::numeric, 0);
    if q < 0 then raise exception 'Negative stock for "%" — fix it in Tally or remove the row', r->>'item_name'; end if;
    pid := find_product(r->>'sku', r->>'item_name');
    if pid is null then
      insert into products(sku, item_name, unit_price)
      values (coalesce(nullif(trim(r->>'sku'), ''), trim(r->>'item_name')),
              coalesce(nullif(trim(r->>'item_name'), ''), trim(r->>'sku')),
              coalesce(nullif(r->>'unit_price', '')::numeric, 0))
      returning id into pid;
    end if;
    totals := jsonb_set(totals, array[pid::text], to_jsonb(coalesce((totals->>pid::text)::numeric, 0) + q));
    rates := jsonb_set(rates, array[pid::text], to_jsonb(coalesce(nullif(r->>'unit_price', '')::numeric, 0)));
  end loop;

  for k, v in select * from jsonb_each(totals) loop
    pid := k::uuid;
    perform pg_advisory_xact_lock(hashtext(did::text || pid::text));
    cur := stock_of(did, pid);
    diff := (v #>> '{}')::numeric - cur;
    if diff > 0 then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source)
      values (bid, did, pid, 'INPUT', coalesce(p_date, current_date), 'Stock count', diff, (rates->>k)::numeric, auth.uid(), 'COUNT');
      n_in := n_in + 1;
    elsif diff < 0 then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by, source)
      values (bid, did, pid, 'OUTPUT', coalesce(p_date, current_date), 'Stock count', -diff, (rates->>k)::numeric, auth.uid(), 'COUNT');
      n_out := n_out + 1;
    else
      n_same := n_same + 1;
    end if;
  end loop;

  return jsonb_build_object('batch_id', bid, 'increased', n_in, 'decreased', n_out, 'unchanged', n_same);
end $$;

-- ---------- Retailers ----------
alter table public.retailers add column if not exists owner_name text;
alter table public.retailers add column if not exists phone text;
create index if not exists retailers_dist on public.retailers(distributor_id);
create index if not exists retailers_norm on public.retailers(public.norm_name(name));
drop policy if exists "managers insert retailers" on public.retailers;
create policy "managers insert retailers" on public.retailers for insert to authenticated with check (public.is_manager());
drop policy if exists "managers update retailers" on public.retailers;
create policy "managers update retailers" on public.retailers for update to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "managers delete retailers" on public.retailers;
create policy "managers delete retailers" on public.retailers for delete to authenticated using (public.is_manager());

-- ---------- Comments on distributors (and any other location) ----------
create table if not exists public.distributor_comments(
  id uuid primary key default gen_random_uuid(),
  distributor_id uuid not null references public.distributors(id) on delete cascade,
  body text not null check (length(trim(body)) > 0),
  author_id uuid,
  author_email text,
  created_at timestamptz not null default now()
);
create index if not exists distributor_comments_dist on public.distributor_comments(distributor_id, created_at);
alter table public.distributor_comments enable row level security;

-- The author is always the signed-in user; the browser can't set it.
create or replace function public.comment_author() returns trigger
language plpgsql set search_path=public as $$
begin
  new.author_id := auth.uid();
  new.author_email := coalesce(auth.jwt() ->> 'email', '');
  new.created_at := now();
  return new;
end $$;
drop trigger if exists comment_author on public.distributor_comments;
create trigger comment_author before insert on public.distributor_comments for each row execute function public.comment_author();

drop policy if exists "read comments" on public.distributor_comments;
create policy "read comments" on public.distributor_comments for select to authenticated using (true);
drop policy if exists "add comments" on public.distributor_comments;
create policy "add comments" on public.distributor_comments for insert to authenticated with check (auth.uid() is not null);
drop policy if exists "delete own comments" on public.distributor_comments;
create policy "delete own comments" on public.distributor_comments for delete to authenticated using (author_id = auth.uid() or public.is_manager());

-- ---------- Sales officers and their daily reports ----------
create table if not exists public.sales_officers(
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  phone text,
  state text,
  region text,
  aliases text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz default now()
);
alter table public.sales_officers enable row level security;
drop policy if exists "read sales officers" on public.sales_officers;
create policy "read sales officers" on public.sales_officers for select to authenticated using (true);
drop policy if exists "managers insert sales officers" on public.sales_officers;
create policy "managers insert sales officers" on public.sales_officers for insert to authenticated with check (public.is_manager());
drop policy if exists "managers update sales officers" on public.sales_officers;
create policy "managers update sales officers" on public.sales_officers for update to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "managers delete sales officers" on public.sales_officers;
create policy "managers delete sales officers" on public.sales_officers for delete to authenticated using (public.is_manager());

create or replace function public.find_so(p text) returns uuid
language sql stable set search_path=public as $$
  select s.id from sales_officers s
   where nullif(trim(p), '') is not null
     and ( lower(trim(s.code)) = lower(trim(p))
        or norm_name(s.name) = norm_name(p)
        or exists (select 1 from unnest(s.aliases) a where norm_name(a) = norm_name(p)) )
   order by (lower(trim(s.code)) = lower(trim(p))) desc
   limit 1
$$;

create table if not exists public.so_reports(
  id uuid primary key default gen_random_uuid(),
  source_file text,
  file_hash text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
create index if not exists so_reports_hash on public.so_reports(file_hash);
-- What each SO says they sold. These are claims to check, not stock movements.
create table if not exists public.so_report_lines(
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.so_reports(id) on delete cascade,
  so_id uuid not null references public.sales_officers(id),
  report_date date not null,
  distributor_id uuid not null references public.distributors(id),
  retailer_name text,
  product_id uuid not null references public.products(id),
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) default 0,
  created_at timestamptz default now()
);
create index if not exists so_lines_report on public.so_report_lines(report_id);
create index if not exists so_lines_date on public.so_report_lines(report_date);
create index if not exists so_lines_dist on public.so_report_lines(distributor_id, product_id, report_date);
create index if not exists so_lines_so on public.so_report_lines(so_id, report_date);
alter table public.so_reports enable row level security;
alter table public.so_report_lines enable row level security;
drop policy if exists "read so reports" on public.so_reports;
create policy "read so reports" on public.so_reports for select to authenticated using (true);
drop policy if exists "read so report lines" on public.so_report_lines;
create policy "read so report lines" on public.so_report_lines for select to authenticated using (true);

create or replace function public.post_so_report(
  p_rows jsonb, p_source_file text default null, p_file_hash text default null, p_allow_duplicate boolean default false)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r jsonb; rid uuid; sid uuid; did uuid; pid uuid; q numeric; what text; n int := 0; prev timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to post'; end if;
  if p_file_hash is not null and not p_allow_duplicate then
    select created_at into prev from so_reports where file_hash = p_file_hash order by created_at desc limit 1;
    if prev is not null then raise exception 'DUPLICATE_FILE: this file was already posted on %', to_char(prev at time zone 'Asia/Kolkata','DD Mon YYYY HH24:MI'); end if;
  end if;
  insert into so_reports(source_file, file_hash, created_by) values (p_source_file, p_file_hash, auth.uid()) returning id into rid;
  for r in select value from jsonb_array_elements(p_rows) loop
    what := coalesce(nullif(trim(r->>'item_name'), ''), nullif(trim(r->>'sku'), ''), '?');
    sid := find_so(r->>'so');
    if sid is null then raise exception 'Sales officer not found: "%". Add them on the SO checks page first.', coalesce(r->>'so', ''); end if;
    did := find_distributor(r->>'distributor');
    if did is null then raise exception 'Distributor not found: "%"', coalesce(r->>'distributor', ''); end if;
    pid := find_product(r->>'sku', r->>'item_name');
    if pid is null then raise exception 'Product not found: "%". Match it to one of your products.', what; end if;
    q := coalesce(nullif(r->>'quantity', '')::numeric, 0);
    if q <= 0 then raise exception 'Invalid quantity for "%"', what; end if;
    insert into so_report_lines(report_id, so_id, report_date, distributor_id, retailer_name, product_id, quantity, unit_price)
    values (rid, sid, coalesce(nullif(r->>'date', '')::date, current_date), did, nullif(trim(r->>'retailer'), ''), pid, q,
            coalesce(nullif(r->>'unit_price', '')::numeric, 0));
    n := n + 1;
  end loop;
  return jsonb_build_object('report_id', rid, 'posted_rows', n);
end $$;

create or replace function public.delete_so_report(p_report uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can undo SO reports'; end if;
  select count(*) into n from so_report_lines where report_id = p_report;
  delete from so_reports where id = p_report;
  return jsonb_build_object('deleted_rows', n);
end $$;

-- ---------- Views ----------
drop function if exists public.stock_movements(date, date, uuid[]);

drop view if exists public.distributor_stock_summary;
create view public.distributor_stock_summary with (security_invoker=true) as
select d.id distributor_id, d.code distributor_code, d.name distributor_name, p.id product_id, p.sku, p.item_name, p.unit_price,
  sum(case when t.mode = 'INPUT' then t.quantity else 0 end) total_input,
  sum(case when t.mode = 'OUTPUT' then t.quantity else 0 end) total_output,
  sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) current_stock,
  round(sum(case when t.mode = 'INPUT' then t.quantity else -t.quantity end) * p.unit_price, 2) stock_value,
  max(t.transaction_date) last_movement,
  max(t.transaction_date) filter (where t.mode = 'INPUT') last_in,
  max(t.transaction_date) filter (where t.mode = 'OUTPUT') last_out,
  d.kind
from inventory_transactions t
join distributors d on d.id = t.distributor_id
join products p on p.id = t.product_id
group by d.id, d.code, d.name, d.kind, p.id, p.sku, p.item_name, p.unit_price;
grant select on public.distributor_stock_summary to authenticated;

drop view if exists public.inventory_history;
create view public.inventory_history with (security_invoker=true) as
select t.id, t.batch_id, t.transaction_date, t.mode, t.quantity, t.unit_price, t.reference, t.created_at,
       b.mode batch_mode, b.source_file, d.name distributor_name, p.sku, p.item_name, r.name retailer_name,
       t.distributor_id, d.code distributor_code, d.kind distributor_kind, t.product_id, t.source,
       t.counterparty_id, c.name counterparty_name, t.party, t.transfer_id
from inventory_transactions t
join inventory_batches b on b.id = t.batch_id
join distributors d on d.id = t.distributor_id
join products p on p.id = t.product_id
left join retailers r on r.id = t.retailer_id
left join distributors c on c.id = t.counterparty_id;
grant select on public.inventory_history to authenticated;

drop view if exists public.inventory_batch_summary;
create view public.inventory_batch_summary with (security_invoker=true) as
select b.id, b.created_at, b.mode, b.source_file, d.name distributor_name,
       count(t.id) lines,
       coalesce(sum(case when t.mode = 'INPUT' then t.quantity else 0 end), 0) units_in,
       coalesce(sum(case when t.mode = 'OUTPUT' then t.quantity else 0 end), 0) units_out,
       b.as_of,
       count(t.id) filter (where t.source = 'TRANSFER') transfer_lines
from inventory_batches b
left join distributors d on d.id = b.distributor_id
left join inventory_transactions t on t.batch_id = b.id
group by b.id, b.created_at, b.mode, b.source_file, d.name, b.as_of;
grant select on public.inventory_batch_summary to authenticated;

-- When each location last sent its own data (a stock count, or sales to retailers).
drop view if exists public.location_data_status;
create view public.location_data_status with (security_invoker=true) as
select d.id location_id,
  (select max(b.as_of) from inventory_batches b where b.distributor_id = d.id and b.mode = 'COUNT') last_count,
  (select max(t.transaction_date) from inventory_transactions t where t.distributor_id = d.id and t.source = 'SALE') last_sale,
  (select max(t.transaction_date) from inventory_transactions t where t.distributor_id = d.id) last_movement
from distributors d;
grant select on public.location_data_status to authenticated;

drop view if exists public.distributor_comment_counts;
create view public.distributor_comment_counts with (security_invoker=true) as
select distributor_id, count(*) n, max(created_at) last_at from distributor_comments group by distributor_id;
grant select on public.distributor_comment_counts to authenticated;

-- Each SO line with names, and whether its retailer belongs to that distributor.
drop view if exists public.so_line_details;
create view public.so_line_details with (security_invoker=true) as
select l.id, l.report_id, l.report_date, l.so_id, s.name so_name, l.distributor_id, d.name distributor_name, d.code distributor_code,
       l.product_id, p.sku, p.item_name, l.quantity, l.unit_price, l.retailer_name,
       case when nullif(trim(l.retailer_name), '') is null then 'MISSING'
            when exists (select 1 from retailers r where r.distributor_id = l.distributor_id and norm_name(r.name) = norm_name(l.retailer_name)) then 'OK'
            when other.names is not null then 'OTHER_DISTRIBUTOR'
            else 'UNKNOWN' end retailer_status,
       other.names retailer_other_distributor
from so_report_lines l
join sales_officers s on s.id = l.so_id
join distributors d on d.id = l.distributor_id
join products p on p.id = l.product_id
left join lateral (
  select string_agg(distinct d2.name, ', ') names
    from retailers r join distributors d2 on d2.id = r.distributor_id
   where r.distributor_id <> l.distributor_id and norm_name(r.name) = norm_name(l.retailer_name)
     and (d.state is null or d2.state is null or d2.state = d.state)
) other on true;
grant select on public.so_line_details to authenticated;

drop view if exists public.so_report_summary;
create view public.so_report_summary with (security_invoker=true) as
select r.id, r.created_at, r.source_file, count(l.id) lines, coalesce(sum(l.quantity), 0) units,
       min(l.report_date) from_date, max(l.report_date) to_date, string_agg(distinct s.name, ', ') so_names
from so_reports r
left join so_report_lines l on l.report_id = r.id
left join sales_officers s on s.id = l.so_id
group by r.id, r.created_at, r.source_file;
grant select on public.so_report_summary to authenticated;

-- ---------- Stock for a period (downloads, reports) ----------
-- Opening = before p_from; in/out = from p_from to p_to; closing = up to p_to.
-- Null p_from: no opening, everything counts as in/out. Null p_to: up to the latest movement.
create or replace function public.stock_period(p_from date default null, p_to date default null, p_locations uuid[] default null)
returns table(location_id uuid, product_id uuid, opening numeric, qty_in numeric, qty_out numeric, closing numeric,
              in_purchase numeric, in_transfer numeric, in_count numeric, out_sale numeric, out_transfer numeric, out_count numeric,
              last_in date, last_out date)
language sql stable set search_path=public as $$
  with t as (
    select distributor_id, product_id, mode, source, quantity, transaction_date,
           (p_from is null or transaction_date >= p_from) in_period
      from inventory_transactions
     where (p_to is null or transaction_date <= p_to)
       and (p_locations is null or distributor_id = any(p_locations)))
  select distributor_id, product_id,
    coalesce(sum(case when mode = 'INPUT' then quantity else -quantity end) filter (where not in_period), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'INPUT'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'OUTPUT'), 0),
    coalesce(sum(case when mode = 'INPUT' then quantity else -quantity end), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'INPUT' and source = 'PURCHASE'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'INPUT' and source = 'TRANSFER'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'INPUT' and source = 'COUNT'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'OUTPUT' and source = 'SALE'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'OUTPUT' and source = 'TRANSFER'), 0),
    coalesce(sum(quantity) filter (where in_period and mode = 'OUTPUT' and source = 'COUNT'), 0),
    max(transaction_date) filter (where mode = 'INPUT'),
    max(transaction_date) filter (where mode = 'OUTPUT')
  from t group by distributor_id, product_id
$$;

create or replace function public.stock_movements(p_from date default null, p_to date default null, p_locations uuid[] default null)
returns setof public.inventory_history
language sql stable set search_path=public as $$
  select * from inventory_history h
   where (p_from is null or h.transaction_date >= p_from) and (p_to is null or h.transaction_date <= p_to)
     and (p_locations is null or h.distributor_id = any(p_locations))
   order by h.transaction_date, h.distributor_name, h.item_name, h.id
$$;

-- ---------- Checks ----------
-- Stock that has sat unsold. aged_qty = stock older than p_days (first in, first out: the newest
-- receipts are assumed to be what's still on the shelf, so this is the smallest possible amount).
-- oldest_in = date of the oldest receipt still in stock.
create or replace function public.aged_stock(p_days int default 60, p_as_of date default current_date, p_locations uuid[] default null)
returns table(location_id uuid, product_id uuid, stock numeric, aged_qty numeric, oldest_in date, last_in date, last_out date)
language sql stable set search_path=public as $$
  with t as (
    select distributor_id, product_id, mode, quantity, transaction_date from inventory_transactions
     where transaction_date <= p_as_of and (p_locations is null or distributor_id = any(p_locations))),
  s as (
    select distributor_id, product_id,
           sum(case when mode = 'INPUT' then quantity else -quantity end) stock,
           coalesce(sum(quantity) filter (where mode = 'INPUT' and transaction_date > p_as_of - p_days), 0) recent_in,
           max(transaction_date) filter (where mode = 'INPUT') last_in,
           max(transaction_date) filter (where mode = 'OUTPUT') last_out
      from t group by 1, 2),
  rin as (
    select distributor_id, product_id, transaction_date d,
           sum(sum(quantity)) over (partition by distributor_id, product_id order by transaction_date desc) cum
      from t where mode = 'INPUT' group by 1, 2, 3),
  oldest as (
    select distinct on (rin.distributor_id, rin.product_id) rin.distributor_id, rin.product_id, rin.d
      from rin join s on s.distributor_id = rin.distributor_id and s.product_id = rin.product_id
     where rin.cum >= s.stock
     order by rin.distributor_id, rin.product_id, rin.d desc)
  select s.distributor_id, s.product_id, s.stock, greatest(s.stock - s.recent_in, 0), o.d, s.last_in, s.last_out
    from s left join oldest o on o.distributor_id = s.distributor_id and o.product_id = s.product_id
   where s.stock > 0
$$;

-- SOs reporting sales of stock the distributor never had: for each day, everything the SOs
-- reported since p_from is compared with the distributor's stock on p_from plus everything
-- received up to that day.
create or replace function public.so_oversell(p_from date, p_to date, p_locations uuid[] default null)
returns table(distributor_id uuid, product_id uuid, report_date date, so_qty numeric, so_total numeric, available numeric, so_names text, has_stock_data boolean)
language sql stable set search_path=public as $$
  with so as (
    select l.distributor_id, l.product_id, l.report_date, sum(l.quantity) q, string_agg(distinct s.name, ', ') names
      from so_report_lines l join sales_officers s on s.id = l.so_id
     where l.report_date between p_from and p_to and (p_locations is null or l.distributor_id = any(p_locations))
     group by 1, 2, 3),
  c as (
    select so.*, sum(q) over (partition by distributor_id, product_id order by report_date) total from so),
  x as (
    select c.*,
      (select coalesce(sum(case when t.transaction_date < p_from then (case when t.mode = 'INPUT' then t.quantity else -t.quantity end)
                                when t.mode = 'INPUT' then t.quantity else 0 end), 0)
         from inventory_transactions t
        where t.distributor_id = c.distributor_id and t.product_id = c.product_id and t.transaction_date <= c.report_date) avail,
      exists (select 1 from inventory_transactions t2 where t2.distributor_id = c.distributor_id and t2.transaction_date <= p_to) has_data
    from c)
  select distributor_id, product_id, report_date, q, total, avail, names, has_data from x where total > avail
$$;

-- SO-reported sales against what the distributor's own data shows going out. Only the days the
-- distributor's data covers (up to its last stock count or sales file, data_until) can be compared:
-- so_checked and dist_out cover p_from to that date; so_qty is everything the SOs reported.
drop function if exists public.so_vs_distributor(date, date, uuid[]);
create or replace function public.so_vs_distributor(p_from date, p_to date, p_locations uuid[] default null)
returns table(distributor_id uuid, product_id uuid, so_qty numeric, so_checked numeric, dist_out numeric, so_names text, data_until date)
language sql stable set search_path=public as $$
  with ds as (
    select location_id, greatest(last_count, last_sale) d from location_data_status),
  so as (
    select l.distributor_id, l.product_id, sum(l.quantity) q,
           coalesce(sum(l.quantity) filter (where l.report_date <= ds.d), 0) q_checked,
           string_agg(distinct s.name, ', ') names
      from so_report_lines l join sales_officers s on s.id = l.so_id
      left join ds on ds.location_id = l.distributor_id
     where l.report_date between p_from and p_to and (p_locations is null or l.distributor_id = any(p_locations))
     group by 1, 2),
  o as (
    select t.distributor_id, t.product_id, sum(t.quantity) q
      from inventory_transactions t join ds on ds.location_id = t.distributor_id
     where t.mode = 'OUTPUT' and t.transaction_date between p_from and least(p_to, ds.d)
       and (p_locations is null or t.distributor_id = any(p_locations))
     group by 1, 2)
  select so.distributor_id, so.product_id, so.q, so.q_checked, coalesce(o.q, 0), so.names, ds.d
    from so
    left join o on o.distributor_id = so.distributor_id and o.product_id = so.product_id
    left join ds on ds.location_id = so.distributor_id
$$;

-- ---------- Permissions ----------
revoke all on function public.post_movements(text,jsonb,text,text,text,boolean,boolean) from public, anon;
grant execute on function public.post_movements(text,jsonb,text,text,text,boolean,boolean) to authenticated;
revoke all on function public.post_stock_count(text,jsonb,date,text,text,boolean) from public, anon;
grant execute on function public.post_stock_count(text,jsonb,date,text,text,boolean) to authenticated;
revoke all on function public.post_so_report(jsonb,text,text,boolean) from public, anon;
grant execute on function public.post_so_report(jsonb,text,text,boolean) to authenticated;
revoke all on function public.delete_so_report(uuid) from public, anon;
grant execute on function public.delete_so_report(uuid) to authenticated;
revoke all on function public.stock_period(date,date,uuid[]) from public, anon;
grant execute on function public.stock_period(date,date,uuid[]) to authenticated;
revoke all on function public.stock_movements(date,date,uuid[]) from public, anon;
grant execute on function public.stock_movements(date,date,uuid[]) to authenticated;
revoke all on function public.aged_stock(int,date,uuid[]) from public, anon;
grant execute on function public.aged_stock(int,date,uuid[]) to authenticated;
revoke all on function public.so_oversell(date,date,uuid[]) from public, anon;
grant execute on function public.so_oversell(date,date,uuid[]) to authenticated;
revoke all on function public.so_vs_distributor(date,date,uuid[]) from public, anon;
grant execute on function public.so_vs_distributor(date,date,uuid[]) to authenticated;
