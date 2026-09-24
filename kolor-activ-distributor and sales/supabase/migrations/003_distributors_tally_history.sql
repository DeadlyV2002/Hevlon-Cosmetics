-- STEP 3 — run after 002. Safe to run more than once.
-- Adds: distributor management (with alternative names), name-based matching for
-- distributors and products, Tally stock-count posting, duplicate-file protection,
-- posting history and undo.

-- ---------- Columns ----------
alter table public.distributors add column if not exists aliases text[] not null default '{}';
alter table public.distributors add column if not exists phone text;
alter table public.inventory_batches add column if not exists file_hash text;
alter table public.inventory_batches add column if not exists distributor_id uuid references public.distributors(id);
alter table public.inventory_batches drop constraint if exists inventory_batches_mode_check;
alter table public.inventory_batches add constraint inventory_batches_mode_check check (mode in ('INPUT','OUTPUT','COUNT'));
create index if not exists inv_batches_hash on public.inventory_batches(file_hash);
create index if not exists inv_tx_batch on public.inventory_transactions(batch_id);

-- ---------- Helpers ----------
-- "M/S Sharma Traders Pvt. Ltd." and "SHARMA TRADERS" both become "sharma traders".
create or replace function public.norm_name(t text) returns text
language sql immutable set search_path=public as $$
  select trim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]+', ' ', 'g'),
           '\m(m s|ms|pvt|private|ltd|limited|llp|the)\M', ' ', 'g'),
         '\s+', ' ', 'g'))
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from profiles where id = auth.uid() and role in ('HO_ADMIN','STATE_MANAGER'))
$$;

create or replace function public.find_distributor(p text) returns uuid
language sql stable set search_path=public as $$
  select d.id from distributors d
   where nullif(trim(p),'') is not null
     and ( lower(trim(d.code)) = lower(trim(p))
        or norm_name(d.name) = norm_name(p)
        or exists (select 1 from unnest(d.aliases) a where norm_name(a) = norm_name(p)) )
   order by (lower(trim(d.code)) = lower(trim(p))) desc
   limit 1
$$;

create or replace function public.find_product(p_sku text, p_name text) returns uuid
language sql stable set search_path=public as $$
  select id from products
   where (nullif(trim(p_sku),'') is not null and lower(sku) = lower(trim(p_sku)))
      or (nullif(trim(p_name),'') is not null and norm_name(item_name) = norm_name(p_name))
   order by (lower(sku) = lower(trim(coalesce(p_sku,'')))) desc
   limit 1
$$;

-- ---------- Distributor management (managers only) ----------
drop policy if exists "managers insert distributors" on public.distributors;
create policy "managers insert distributors" on public.distributors for insert to authenticated with check (public.is_manager());
drop policy if exists "managers update distributors" on public.distributors;
create policy "managers update distributors" on public.distributors for update to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "managers delete distributors" on public.distributors;
create policy "managers delete distributors" on public.distributors for delete to authenticated using (public.is_manager());

-- ---------- Stock IN / OUT ----------
drop function if exists public.post_inventory_batch(text, jsonb);
create or replace function public.post_inventory_batch(
  p_mode text, p_rows jsonb, p_source_file text default null, p_file_hash text default null, p_allow_duplicate boolean default false)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r jsonb; bid uuid; did uuid; first_did uuid; pid uuid; rid uuid; n int := 0; available numeric; q numeric; prev timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_mode not in ('INPUT','OUTPUT') then raise exception 'Invalid mode'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to post'; end if;
  if p_file_hash is not null and not p_allow_duplicate then
    select created_at into prev from inventory_batches where file_hash = p_file_hash order by created_at desc limit 1;
    if prev is not null then raise exception 'DUPLICATE_FILE: this file was already posted on %', to_char(prev at time zone 'Asia/Kolkata','DD Mon YYYY HH24:MI'); end if;
  end if;

  insert into inventory_batches(mode, created_by, source_file, file_hash) values (p_mode, auth.uid(), p_source_file, p_file_hash) returning id into bid;

  for r in select value from jsonb_array_elements(p_rows) loop
    did := find_distributor(r->>'distributor');
    if did is null then raise exception 'Distributor not found: "%". Add it (or add this spelling as an alternative name) on the Distributors page.', r->>'distributor'; end if;
    first_did := coalesce(first_did, did);
    q := coalesce(nullif(r->>'quantity','')::numeric, 0);
    if q <= 0 then raise exception 'Invalid quantity for "%"', coalesce(nullif(r->>'item_name',''), r->>'sku'); end if;
    if nullif(trim(r->>'sku'),'') is null and nullif(trim(r->>'item_name'),'') is null then raise exception 'Row without product name or SKU'; end if;

    pid := find_product(r->>'sku', r->>'item_name');
    rid := null;
    if p_mode = 'INPUT' then
      if pid is null then
        insert into products(sku, item_name, unit_price)
        values (coalesce(nullif(trim(r->>'sku'),''), trim(r->>'item_name')),
                coalesce(nullif(trim(r->>'item_name'),''), trim(r->>'sku')),
                coalesce(nullif(r->>'unit_price','')::numeric, 0))
        returning id into pid;
      elsif coalesce(nullif(r->>'unit_price','')::numeric, 0) > 0 then
        update products set unit_price = (r->>'unit_price')::numeric where id = pid;
      end if;
    else
      if pid is null then raise exception 'Product "%" has never been stocked in', coalesce(nullif(r->>'item_name',''), r->>'sku'); end if;
      perform pg_advisory_xact_lock(hashtext(did::text || pid::text));
      select coalesce(sum(case when t.mode='INPUT' then t.quantity else -t.quantity end), 0) into available
        from inventory_transactions t where t.distributor_id = did and t.product_id = pid;
      if available < q then
        raise exception 'Insufficient stock for % / %. Available %, requested %',
          r->>'distributor', coalesce(nullif(r->>'item_name',''), r->>'sku'), available, q;
      end if;
      if nullif(trim(r->>'retailer'),'') is not null then
        select id into rid from retailers where distributor_id = did and norm_name(name) = norm_name(r->>'retailer') limit 1;
        if rid is null then insert into retailers(distributor_id, name) values (did, trim(r->>'retailer')) returning id into rid; end if;
      end if;
    end if;

    insert into inventory_transactions(batch_id, distributor_id, retailer_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by)
    values (bid, did, rid, pid, p_mode, coalesce(nullif(r->>'date','')::date, current_date), nullif(r->>'reference',''),
            q, coalesce(nullif(r->>'unit_price','')::numeric, 0), auth.uid());
    if did <> first_did then first_did := null; end if;
    n := n + 1;
  end loop;

  update inventory_batches set distributor_id = first_did where id = bid;
  return jsonb_build_object('batch_id', bid, 'posted_rows', n);
end $$;

-- ---------- Stock count (e.g. Tally closing stock) ----------
-- Sets each listed product's stock at one distributor to the counted quantity by
-- posting the difference as IN or OUT. Products not in the file are left unchanged.
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
  if did is null then raise exception 'Distributor not found: "%"', p_distributor; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No rows to post'; end if;
  if p_file_hash is not null and not p_allow_duplicate then
    select created_at into prev from inventory_batches where file_hash = p_file_hash order by created_at desc limit 1;
    if prev is not null then raise exception 'DUPLICATE_FILE: this file was already posted on %', to_char(prev at time zone 'Asia/Kolkata','DD Mon YYYY HH24:MI'); end if;
  end if;

  insert into inventory_batches(mode, created_by, source_file, file_hash, distributor_id)
  values ('COUNT', auth.uid(), p_source_file, p_file_hash, did) returning id into bid;

  -- Resolve products and add up duplicates in the file.
  for r in select value from jsonb_array_elements(p_rows) loop
    q := coalesce(nullif(r->>'quantity','')::numeric, 0);
    if q < 0 then raise exception 'Negative stock for "%" — fix it in Tally or remove the row', r->>'item_name'; end if;
    pid := find_product(r->>'sku', r->>'item_name');
    if pid is null then
      insert into products(sku, item_name, unit_price)
      values (coalesce(nullif(trim(r->>'sku'),''), trim(r->>'item_name')),
              coalesce(nullif(trim(r->>'item_name'),''), trim(r->>'sku')),
              coalesce(nullif(r->>'unit_price','')::numeric, 0))
      returning id into pid;
    end if;
    totals := jsonb_set(totals, array[pid::text], to_jsonb(coalesce((totals->>pid::text)::numeric, 0) + q));
    rates := jsonb_set(rates, array[pid::text], to_jsonb(coalesce(nullif(r->>'unit_price','')::numeric, 0)));
  end loop;

  for k, v in select * from jsonb_each(totals) loop
    pid := k::uuid;
    perform pg_advisory_xact_lock(hashtext(did::text || pid::text));
    select coalesce(sum(case when t.mode='INPUT' then t.quantity else -t.quantity end), 0) into cur
      from inventory_transactions t where t.distributor_id = did and t.product_id = pid;
    diff := (v #>> '{}')::numeric - cur;
    if diff > 0 then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by)
      values (bid, did, pid, 'INPUT', coalesce(p_date, current_date), 'Stock count', diff, (rates->>k)::numeric, auth.uid());
      n_in := n_in + 1;
    elsif diff < 0 then
      insert into inventory_transactions(batch_id, distributor_id, product_id, mode, transaction_date, reference, quantity, unit_price, created_by)
      values (bid, did, pid, 'OUTPUT', coalesce(p_date, current_date), 'Stock count', -diff, (rates->>k)::numeric, auth.uid());
      n_out := n_out + 1;
    else
      n_same := n_same + 1;
    end if;
  end loop;

  return jsonb_build_object('batch_id', bid, 'increased', n_in, 'decreased', n_out, 'unchanged', n_same);
end $$;

-- ---------- Undo a posting (managers only) ----------
create or replace function public.delete_inventory_batch(p_batch uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare n int; bad record;
begin
  if not is_manager() then raise exception 'Only HO admins and state managers can undo postings'; end if;
  create temp table _affected on commit drop as
    select distinct distributor_id, product_id from inventory_transactions where batch_id = p_batch;
  delete from inventory_transactions where batch_id = p_batch;
  get diagnostics n = row_count;
  select d.name dname, p.item_name pname, s.stock into bad
    from (select t.distributor_id, t.product_id, sum(case when t.mode='INPUT' then t.quantity else -t.quantity end) stock
            from inventory_transactions t join _affected a using (distributor_id, product_id)
           group by 1,2) s
    join distributors d on d.id = s.distributor_id join products p on p.id = s.product_id
   where s.stock < 0 limit 1;
  if found then
    raise exception 'Cannot undo: % / % would go to % because stock was already sold from it. Undo the later stock-out first.', bad.dname, bad.pname, bad.stock;
  end if;
  delete from inventory_batches where id = p_batch;
  return jsonb_build_object('deleted_rows', n);
end $$;

revoke all on function public.post_inventory_batch(text,jsonb,text,text,boolean) from public, anon;
grant execute on function public.post_inventory_batch(text,jsonb,text,text,boolean) to authenticated;
revoke all on function public.post_stock_count(text,jsonb,date,text,text,boolean) from public, anon;
grant execute on function public.post_stock_count(text,jsonb,date,text,text,boolean) to authenticated;
revoke all on function public.delete_inventory_batch(uuid) from public, anon;
grant execute on function public.delete_inventory_batch(uuid) to authenticated;

-- ---------- Views ----------
drop view if exists public.distributor_stock_summary;
create view public.distributor_stock_summary with (security_invoker=true) as
select d.id distributor_id, d.code distributor_code, d.name distributor_name, p.id product_id, p.sku, p.item_name, p.unit_price,
  sum(case when t.mode='INPUT' then t.quantity else 0 end) total_input,
  sum(case when t.mode='OUTPUT' then t.quantity else 0 end) total_output,
  sum(case when t.mode='INPUT' then t.quantity else -t.quantity end) current_stock,
  round(sum(case when t.mode='INPUT' then t.quantity else -t.quantity end) * p.unit_price, 2) stock_value,
  max(t.transaction_date) last_movement
from inventory_transactions t
join distributors d on d.id = t.distributor_id
join products p on p.id = t.product_id
group by d.id, d.code, d.name, p.id, p.sku, p.item_name, p.unit_price;
grant select on public.distributor_stock_summary to authenticated;

drop view if exists public.inventory_history;
create view public.inventory_history with (security_invoker=true) as
select t.id, t.batch_id, t.transaction_date, t.mode, t.quantity, t.unit_price, t.reference, t.created_at,
       b.mode batch_mode, b.source_file, d.name distributor_name, p.sku, p.item_name, r.name retailer_name
from inventory_transactions t
join inventory_batches b on b.id = t.batch_id
join distributors d on d.id = t.distributor_id
join products p on p.id = t.product_id
left join retailers r on r.id = t.retailer_id;
grant select on public.inventory_history to authenticated;

drop view if exists public.inventory_batch_summary;
create view public.inventory_batch_summary with (security_invoker=true) as
select b.id, b.created_at, b.mode, b.source_file, d.name distributor_name,
       count(t.id) lines,
       coalesce(sum(case when t.mode='INPUT' then t.quantity else 0 end),0) units_in,
       coalesce(sum(case when t.mode='OUTPUT' then t.quantity else 0 end),0) units_out
from inventory_batches b
left join distributors d on d.id = b.distributor_id
left join inventory_transactions t on t.batch_id = b.id
group by b.id, b.created_at, b.mode, b.source_file, d.name;
grant select on public.inventory_batch_summary to authenticated;
