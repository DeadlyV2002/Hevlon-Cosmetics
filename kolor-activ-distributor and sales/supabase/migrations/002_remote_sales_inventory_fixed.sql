create extension if not exists pgcrypto;

create table if not exists public.profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text default '',
 role text not null default 'SALESMAN' check(role in('HO_ADMIN','STATE_MANAGER','DISTRIBUTOR_MANAGER','SALESMAN')),
 territory text,
 created_at timestamptz default now()
);
create table if not exists public.distributors(
 id uuid primary key default gen_random_uuid(), code text unique not null, name text not null,
 territory text, assigned_user uuid references public.profiles(id), created_at timestamptz default now()
);
create table if not exists public.retailers(
 id uuid primary key default gen_random_uuid(), distributor_id uuid references public.distributors(id) on delete cascade,
 code text, name text not null, territory text, created_at timestamptz default now()
);
create table if not exists public.products(
 id uuid primary key default gen_random_uuid(), sku text unique not null, item_name text not null,
 uom text default 'PCS', unit_price numeric(14,2) default 0, active boolean default true
);
create table if not exists public.inventory_batches(
 id uuid primary key default gen_random_uuid(), mode text not null check(mode in('INPUT','OUTPUT')),
 source_file text, created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists public.inventory_transactions(
 id uuid primary key default gen_random_uuid(), batch_id uuid references public.inventory_batches(id) on delete cascade,
 distributor_id uuid not null references public.distributors(id), retailer_id uuid references public.retailers(id),
 product_id uuid not null references public.products(id), mode text not null check(mode in('INPUT','OUTPUT')),
 transaction_date date not null default current_date, reference text,
 quantity numeric(14,3) not null check(quantity>0), unit_price numeric(14,2) default 0,
 created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists public.sales_invoices(
 id uuid primary key default gen_random_uuid(), distributor_id uuid references public.distributors(id),
 retailer_id uuid references public.retailers(id), invoice_no text, invoice_date date default current_date,
 total numeric(14,2) default 0, created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists public.collections(
 id uuid primary key default gen_random_uuid(), distributor_id uuid references public.distributors(id),
 retailer_id uuid references public.retailers(id), amount numeric(14,2) not null check(amount>0),
 payment_date date default current_date, reference text, created_by uuid references auth.users(id), created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.distributors enable row level security;
alter table public.retailers enable row level security;
alter table public.products enable row level security;
alter table public.inventory_batches enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.sales_invoices enable row level security;
alter table public.collections enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated using(id = auth.uid());

drop policy if exists "read distributors" on public.distributors;
create policy "read distributors" on public.distributors for select to authenticated using(true);
drop policy if exists "read retailers" on public.retailers;
create policy "read retailers" on public.retailers for select to authenticated using(true);
drop policy if exists "read products" on public.products;
create policy "read products" on public.products for select to authenticated using(true);
drop policy if exists "read batches" on public.inventory_batches;
create policy "read batches" on public.inventory_batches for select to authenticated using(true);
drop policy if exists "read transactions" on public.inventory_transactions;
create policy "read transactions" on public.inventory_transactions for select to authenticated using(true);
drop policy if exists "read invoices" on public.sales_invoices;
create policy "read invoices" on public.sales_invoices for select to authenticated using(true);
drop policy if exists "read collections" on public.collections;
create policy "read collections" on public.collections for select to authenticated using(true);

create or replace function public.post_inventory_batch(p_mode text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r jsonb; bid uuid; did uuid; pid uuid; rid uuid; n int:=0; available numeric;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_mode not in('INPUT','OUTPUT') then raise exception 'Invalid mode'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then raise exception 'No rows to post'; end if;
 insert into inventory_batches(mode,created_by) values(p_mode,auth.uid()) returning id into bid;
 for r in select value from jsonb_array_elements(p_rows) loop
   did := null; pid := null; rid := null;
   select id into did from distributors
    where lower(trim(code))=lower(trim(r->>'distributor')) or lower(trim(name))=lower(trim(r->>'distributor')) limit 1;
   if did is null then raise exception 'Distributor not found: %. Add it in the distributors table first.',r->>'distributor'; end if;
   if nullif(trim(r->>'sku'),'') is null then raise exception 'SKU missing'; end if;
   if coalesce((r->>'quantity')::numeric,0)<=0 then raise exception 'Invalid quantity for SKU %',r->>'sku'; end if;

   if p_mode='INPUT' then
     -- New SKUs are created on stock-in. Blank names/prices never overwrite existing ones.
     insert into products(sku,item_name,unit_price)
     values(trim(r->>'sku'),coalesce(nullif(trim(r->>'item_name'),''),trim(r->>'sku')),coalesce(nullif(r->>'unit_price','')::numeric,0))
     on conflict(sku) do update set
       item_name=case when excluded.item_name=excluded.sku then products.item_name else excluded.item_name end,
       unit_price=case when excluded.unit_price>0 then excluded.unit_price else products.unit_price end
     returning id into pid;
   else
     -- Stock-out must use a SKU that was stocked in; it never edits the product master.
     select id into pid from products where lower(sku)=lower(trim(r->>'sku'));
     if pid is null then raise exception 'SKU % has never been stocked in',r->>'sku'; end if;
     -- Serialise stock-outs per distributor+SKU so two users cannot oversell at the same time.
     perform pg_advisory_xact_lock(hashtext(did::text||pid::text));
     select coalesce(sum(case when t.mode='INPUT' then t.quantity else -t.quantity end),0)
       into available from inventory_transactions t
      where t.distributor_id=did and t.product_id=pid;
     if available < (r->>'quantity')::numeric then
       raise exception 'Insufficient stock for distributor % SKU %. Available %, requested %',
         r->>'distributor',r->>'sku',available,(r->>'quantity')::numeric;
     end if;
     if nullif(trim(r->>'retailer'),'') is not null then
       select id into rid from retailers where distributor_id=did and lower(trim(name))=lower(trim(r->>'retailer')) limit 1;
       if rid is null then insert into retailers(distributor_id,name) values(did,trim(r->>'retailer')) returning id into rid; end if;
     end if;
   end if;
   insert into inventory_transactions(batch_id,distributor_id,retailer_id,product_id,mode,transaction_date,reference,quantity,unit_price,created_by)
   values(bid,did,rid,pid,p_mode,coalesce(nullif(r->>'date','')::date,current_date),nullif(r->>'reference',''),
          (r->>'quantity')::numeric,coalesce(nullif(r->>'unit_price','')::numeric,0),auth.uid());
   n:=n+1;
 end loop;
 return jsonb_build_object('batch_id',bid,'posted_rows',n);
end $$;
revoke all on function public.post_inventory_batch(text,jsonb) from public;
revoke all on function public.post_inventory_batch(text,jsonb) from anon;
grant execute on function public.post_inventory_batch(text,jsonb) to authenticated;

drop view if exists public.distributor_stock_summary;
create view public.distributor_stock_summary with (security_invoker=true) as
select d.id distributor_id,d.name distributor_name,p.sku,p.item_name,
 sum(case when t.mode='INPUT' then t.quantity else 0 end) total_input,
 sum(case when t.mode='OUTPUT' then t.quantity else 0 end) total_output,
 sum(case when t.mode='INPUT' then t.quantity else -t.quantity end) current_stock
from inventory_transactions t
join distributors d on d.id=t.distributor_id
join products p on p.id=t.product_id
group by d.id,d.name,p.sku,p.item_name;
grant select on public.distributor_stock_summary to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
 insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','')) on conflict(id) do nothing;
 return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

-- Give every existing login account a profile row.
insert into public.profiles(id) select id from auth.users on conflict(id) do nothing;

create index if not exists inv_tx_dist_prod on public.inventory_transactions(distributor_id,product_id);
