-- STEP 4 — run after 003. Safe to run more than once.
-- Adds: owner name, company name and super stockist on distributors;
-- remembered column layouts for uploaded files; alternative product names.

-- ---------- Distributor details ----------
alter table public.distributors add column if not exists owner_name text;
alter table public.distributors add column if not exists company_name text;
alter table public.distributors add column if not exists super_stockist text;
create index if not exists distributors_super on public.distributors(super_stockist);

-- Match on code, name, company name or any alternative name.
create or replace function public.find_distributor(p text) returns uuid
language sql stable set search_path=public as $$
  select d.id from distributors d
   where nullif(trim(p),'') is not null
     and ( lower(trim(d.code)) = lower(trim(p))
        or norm_name(d.name) = norm_name(p)
        or (nullif(trim(d.company_name),'') is not null and norm_name(d.company_name) = norm_name(p))
        or exists (select 1 from unnest(d.aliases) a where norm_name(a) = norm_name(p)) )
   order by (lower(trim(d.code)) = lower(trim(p))) desc
   limit 1
$$;

-- ---------- Alternative product names ----------
-- "KA LS RED-01" in one distributor's Tally = "KA Lipstick Red 01" in yours.
create table if not exists public.product_aliases(
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  alias text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
create unique index if not exists product_aliases_norm on public.product_aliases(public.norm_name(alias));
alter table public.product_aliases enable row level security;
drop policy if exists "read product aliases" on public.product_aliases;
create policy "read product aliases" on public.product_aliases for select to authenticated using (true);
drop policy if exists "add product aliases" on public.product_aliases;
create policy "add product aliases" on public.product_aliases for insert to authenticated with check (true);
drop policy if exists "managers delete product aliases" on public.product_aliases;
create policy "managers delete product aliases" on public.product_aliases for delete to authenticated using (public.is_manager());

create or replace function public.find_product(p_sku text, p_name text) returns uuid
language sql stable set search_path=public as $$
  select id from (
    select id, 1 pri from products where nullif(trim(p_sku),'') is not null and lower(sku) = lower(trim(p_sku))
    union all
    select id, 2 from products where nullif(trim(p_name),'') is not null and norm_name(item_name) = norm_name(p_name)
    union all
    select product_id, 3 from product_aliases where nullif(trim(p_name),'') is not null and norm_name(alias) = norm_name(p_name)
    union all
    select product_id, 4 from product_aliases where nullif(trim(p_sku),'') is not null and norm_name(alias) = norm_name(p_sku)
  ) x order by pri limit 1
$$;

-- ---------- Remembered file layouts ----------
-- Keyed by the file's column headings, so the next file in the same format is read the same way.
create table if not exists public.import_formats(
  signature text primary key,
  mapping jsonb not null,
  labels jsonb,
  used_count int not null default 1,
  updated_by uuid default auth.uid(),
  updated_at timestamptz default now()
);
alter table public.import_formats enable row level security;
drop policy if exists "read formats" on public.import_formats;
create policy "read formats" on public.import_formats for select to authenticated using (true);
drop policy if exists "add formats" on public.import_formats;
create policy "add formats" on public.import_formats for insert to authenticated with check (true);
drop policy if exists "update formats" on public.import_formats;
create policy "update formats" on public.import_formats for update to authenticated using (true) with check (true);
