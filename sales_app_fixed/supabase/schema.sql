-- HO Inventory + Sales Control System
-- Kolor Activ / Hevlon Cosmetics Pvt. Ltd.

create extension if not exists pgcrypto;

-- ─── Enums ───────────────────────────────────────────────────────────────────
create type public.app_role as enum ('HO_ADMIN','STATE','DISTRIBUTOR','RETAILER','SALESMAN');
create type public.record_status as enum ('REPORTED','MATCHED','VERIFIED','EXCEPTION','APPROVED');

-- ─── Core hierarchy ──────────────────────────────────────────────────────────
create table if not exists public.states (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text unique,
  created_at  timestamptz default now()
);

create table if not exists public.super_distributors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  state_id    uuid references public.states(id),
  created_at  timestamptz default now()
);

create table if not exists public.distributors (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  super_distributor_id uuid references public.super_distributors(id),
  state_id             uuid references public.states(id),
  created_at           timestamptz default now()
);

create table if not exists public.retailers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  distributor_id  uuid references public.distributors(id),
  state_id        uuid references public.states(id),
  territory       text,
  created_at      timestamptz default now()
);

-- ─── User profiles (links Supabase Auth → role + hierarchy node) ─────────────
create table if not exists public.user_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  role            public.app_role not null default 'SALESMAN',
  state_id        uuid references public.states(id),
  distributor_id  uuid references public.distributors(id),
  retailer_id     uuid references public.retailers(id),
  display_name    text,
  created_at      timestamptz default now()
);

-- ─── Salesmen ─────────────────────────────────────────────────────────────────
create table if not exists public.salesmen (
  id              uuid primary key default gen_random_uuid(),
  employee_code   text unique not null,
  name            text not null,
  mobile          text,
  email           text,
  state_id        uuid references public.states(id),
  territory       text,
  distributor_id  uuid references public.distributors(id),
  manager_name    text,
  target_value    numeric(14,2) default 0,
  active          boolean default true,
  created_at      timestamptz default now()
);

-- ─── Products ─────────────────────────────────────────────────────────────────
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  category    text,
  uom         text default 'PCS',
  active      boolean default true,
  created_at  timestamptz default now()
);

create table if not exists public.product_aliases (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references public.products(id) on delete cascade,
  alias       text not null
);

-- ─── Bills ────────────────────────────────────────────────────────────────────
create table if not exists public.bills (
  id                   uuid primary key default gen_random_uuid(),
  bill_no              text not null,
  bill_date            date not null,
  source_type          text not null,
  state_id             uuid references public.states(id),
  super_distributor_id uuid references public.super_distributors(id),
  distributor_id       uuid references public.distributors(id),
  retailer_id          uuid references public.retailers(id),
  salesman_id          uuid references public.salesmen(id),
  source_file_name     text,
  reported_value       numeric(14,2) default 0,
  status               public.record_status default 'REPORTED',
  created_at           timestamptz default now(),
  unique(bill_no, source_type, bill_date, distributor_id)   -- duplicate protection
);

create table if not exists public.bill_items (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid references public.bills(id) on delete cascade,
  product_id  uuid references public.products(id),
  qty         numeric(14,3) default 0,
  rate        numeric(14,2) default 0,
  value       numeric(14,2) default 0
);

-- ─── Inventory ────────────────────────────────────────────────────────────────
create table if not exists public.inventory_transactions (
  id                   uuid primary key default gen_random_uuid(),
  txn_date             date not null,
  layer                text not null,
  state_id             uuid references public.states(id),
  super_distributor_id uuid references public.super_distributors(id),
  distributor_id       uuid references public.distributors(id),
  retailer_id          uuid references public.retailers(id),
  product_id           uuid references public.products(id),
  transaction_type     text not null,
  qty                  numeric(14,3) not null,
  value                numeric(14,2) default 0,
  source_bill_id       uuid references public.bills(id),
  status               public.record_status default 'REPORTED',
  created_at           timestamptz default now()
);

-- ─── Secondary sales ──────────────────────────────────────────────────────────
create table if not exists public.secondary_sales (
  id               uuid primary key default gen_random_uuid(),
  sales_date       date not null,
  distributor_id   uuid references public.distributors(id),
  retailer_id      uuid references public.retailers(id),
  salesman_id      uuid references public.salesmen(id),
  product_id       uuid references public.products(id),
  qty              numeric(14,3) default 0,
  value            numeric(14,2) default 0,
  source_file_name text,
  status           public.record_status default 'REPORTED',
  created_at       timestamptz default now()
);

-- ─── Reconciliation ───────────────────────────────────────────────────────────
create table if not exists public.reconciliation_results (
  id               uuid primary key default gen_random_uuid(),
  run_at           timestamptz default now(),
  distributor_id   uuid references public.distributors(id),
  product_id       uuid references public.products(id),
  expected_stock   numeric(14,3) default 0,
  reported_stock   numeric(14,3) default 0,
  verified_stock   numeric(14,3) default 0,
  reported_sales   numeric(14,2) default 0,
  verified_sales   numeric(14,2) default 0,
  stock_difference numeric(14,3) generated always as (expected_stock - verified_stock) stored,
  sales_difference numeric(14,2) generated always as (reported_sales - verified_sales) stored,
  status           public.record_status default 'EXCEPTION',
  notes            text
);

-- ─── Collections ──────────────────────────────────────────────────────────────
create table if not exists public.collections (
  id               uuid primary key default gen_random_uuid(),
  invoice_bill_id  uuid references public.bills(id),
  collection_date  date not null,
  customer_name    text,
  salesman_id      uuid references public.salesmen(id),
  amount           numeric(14,2) not null,
  payment_mode     text,
  reference_no     text,
  status           public.record_status default 'REPORTED',
  created_at       timestamptz default now()
);

-- ─── Salesman activities ──────────────────────────────────────────────────────
create table if not exists public.salesman_activities (
  id               uuid primary key default gen_random_uuid(),
  activity_date    date not null,
  salesman_id      uuid references public.salesmen(id),
  retailer_id      uuid references public.retailers(id),
  activity_type    text not null,
  productive       boolean default false,
  order_value      numeric(14,2) default 0,
  collection_value numeric(14,2) default 0,
  notes            text,
  created_at       timestamptz default now()
);

-- ─── Exceptions ───────────────────────────────────────────────────────────────
create table if not exists public.exceptions (
  id              uuid primary key default gen_random_uuid(),
  exception_code  text unique not null,
  layer           text,
  distributor_id  uuid references public.distributors(id),
  product_id      uuid references public.products(id),
  issue_type      text not null,
  description     text not null,
  variance_qty    numeric(14,3) default 0,
  variance_value  numeric(14,2) default 0,
  status          text default 'OPEN',
  assigned_to     text,
  resolution      text,
  created_at      timestamptz default now(),
  resolved_at     timestamptz
);

-- ─── Audit log (auto-populated via trigger) ───────────────────────────────────
create table if not exists public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id),   -- FK to real auth users
  action       text not null,
  table_name   text,
  record_id    uuid,
  old_data     jsonb,
  new_data     jsonb,
  created_at   timestamptz default now()
);

-- ─── Performance indexes ──────────────────────────────────────────────────────
create index if not exists idx_bills_distributor_date      on public.bills(distributor_id, bill_date);
create index if not exists idx_bills_status                on public.bills(status);
create index if not exists idx_secondary_sales_date_dist   on public.secondary_sales(sales_date, distributor_id);
create index if not exists idx_secondary_sales_salesman    on public.secondary_sales(salesman_id);
create index if not exists idx_inventory_date_dist         on public.inventory_transactions(txn_date, distributor_id);
create index if not exists idx_inventory_product           on public.inventory_transactions(product_id);
create index if not exists idx_salesman_activities_date    on public.salesman_activities(activity_date, salesman_id);
create index if not exists idx_collections_salesman        on public.collections(salesman_id, collection_date);
create index if not exists idx_exceptions_status           on public.exceptions(status);
create index if not exists idx_recon_distributor_product   on public.reconciliation_results(distributor_id, product_id);

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table public.states                  enable row level security;
alter table public.super_distributors      enable row level security;
alter table public.distributors            enable row level security;
alter table public.retailers               enable row level security;
alter table public.user_profiles           enable row level security;
alter table public.salesmen                enable row level security;
alter table public.products                enable row level security;
alter table public.product_aliases         enable row level security;
alter table public.bills                   enable row level security;
alter table public.bill_items              enable row level security;
alter table public.inventory_transactions  enable row level security;
alter table public.secondary_sales         enable row level security;
alter table public.reconciliation_results  enable row level security;
alter table public.collections             enable row level security;
alter table public.salesman_activities     enable row level security;
alter table public.exceptions              enable row level security;
alter table public.audit_logs              enable row level security;

-- Helper: get current user's role from user_profiles
create or replace function public.current_user_role()
returns public.app_role language sql stable security definer as $$
  select role from public.user_profiles where id = auth.uid()
$$;

-- Helper: get current user's distributor_id
create or replace function public.current_user_distributor()
returns uuid language sql stable security definer as $$
  select distributor_id from public.user_profiles where id = auth.uid()
$$;

-- Helper: get current user's state_id
create or replace function public.current_user_state()
returns uuid language sql stable security definer as $$
  select state_id from public.user_profiles where id = auth.uid()
$$;

-- ── Reference tables: all authenticated users can read ────────────────────────
create policy "read states"    on public.states    for select to authenticated using (true);
create policy "read products"  on public.products  for select to authenticated using (true);
create policy "read aliases"   on public.product_aliases for select to authenticated using (true);

-- ── User profiles: each user sees only their own row ─────────────────────────
create policy "own profile"    on public.user_profiles for select to authenticated using (auth.uid() = id);
create policy "insert profile" on public.user_profiles for insert to authenticated with check (auth.uid() = id);
create policy "update profile" on public.user_profiles for update to authenticated using (auth.uid() = id);

-- ── Distributors / super distributors: scoped by state or role ───────────────
create policy "read distributors" on public.distributors for select to authenticated using (
  public.current_user_role() = 'HO_ADMIN'
  or state_id = public.current_user_state()
  or id = public.current_user_distributor()
);
create policy "read super_distributors" on public.super_distributors for select to authenticated using (
  public.current_user_role() = 'HO_ADMIN'
  or state_id = public.current_user_state()
);

-- ── Retailers ─────────────────────────────────────────────────────────────────
create policy "read retailers" on public.retailers for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);

-- ── Salesmen ─────────────────────────────────────────────────────────────────
create policy "read salesmen" on public.salesmen for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);
create policy "ho write salesmen" on public.salesmen for insert to authenticated
  with check (public.current_user_role() = 'HO_ADMIN');

-- ── Bills ─────────────────────────────────────────────────────────────────────
create policy "read bills" on public.bills for select to authenticated using (
  public.current_user_role() = 'HO_ADMIN'
  or distributor_id = public.current_user_distributor()
  or state_id = public.current_user_state()
);
create policy "write bills" on public.bills for insert to authenticated
  with check (
    public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR')
    and (public.current_user_role() = 'HO_ADMIN' or distributor_id = public.current_user_distributor())
  );

create policy "read bill_items"  on public.bill_items for select to authenticated using (true);
create policy "write bill_items" on public.bill_items for insert to authenticated
  with check (public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR'));

-- ── Inventory ─────────────────────────────────────────────────────────────────
create policy "read inventory" on public.inventory_transactions for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);
create policy "write inventory" on public.inventory_transactions for insert to authenticated
  with check (public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR'));

-- ── Secondary sales ───────────────────────────────────────────────────────────
create policy "read secondary"  on public.secondary_sales for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);
create policy "write secondary" on public.secondary_sales for insert to authenticated
  with check (public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR','SALESMAN'));

-- ── Reconciliation ────────────────────────────────────────────────────────────
create policy "read recon"  on public.reconciliation_results for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);
create policy "write recon" on public.reconciliation_results for insert to authenticated
  with check (public.current_user_role() = 'HO_ADMIN');

-- ── Collections ───────────────────────────────────────────────────────────────
create policy "read collections"  on public.collections for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or salesman_id in (select id from public.salesmen where distributor_id = public.current_user_distributor())
);
create policy "write collections" on public.collections for insert to authenticated
  with check (public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR','SALESMAN'));

-- ── Salesman activities ───────────────────────────────────────────────────────
create policy "read activities"  on public.salesman_activities for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or salesman_id in (select id from public.salesmen where distributor_id = public.current_user_distributor())
);
create policy "write activities" on public.salesman_activities for insert to authenticated
  with check (public.current_user_role() in ('HO_ADMIN','DISTRIBUTOR','SALESMAN'));

-- ── Exceptions ────────────────────────────────────────────────────────────────
create policy "read exceptions"  on public.exceptions for select to authenticated using (
  public.current_user_role() in ('HO_ADMIN','STATE')
  or distributor_id = public.current_user_distributor()
);
create policy "write exceptions" on public.exceptions for insert to authenticated
  with check (public.current_user_role() = 'HO_ADMIN');
create policy "update exceptions" on public.exceptions for update to authenticated
  using (public.current_user_role() = 'HO_ADMIN');

-- ── Audit log ─────────────────────────────────────────────────────────────────
create policy "ho read audit"   on public.audit_logs for select to authenticated
  using (public.current_user_role() = 'HO_ADMIN');
create policy "system write audit" on public.audit_logs for insert to authenticated with check (true);

-- ─── Audit trigger function ───────────────────────────────────────────────────
create or replace function public.fn_audit_log()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_logs(actor_user_id, action, table_name, record_id, old_data, new_data)
  values (
    auth.uid(),
    tg_op,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'DELETE' then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

-- Attach audit trigger to key tables
create trigger audit_bills
  after insert or update or delete on public.bills
  for each row execute function public.fn_audit_log();

create trigger audit_inventory
  after insert or update or delete on public.inventory_transactions
  for each row execute function public.fn_audit_log();

create trigger audit_reconciliation
  after insert or update or delete on public.reconciliation_results
  for each row execute function public.fn_audit_log();

create trigger audit_collections
  after insert or update or delete on public.collections
  for each row execute function public.fn_audit_log();

create trigger audit_exceptions
  after insert or update or delete on public.exceptions
  for each row execute function public.fn_audit_log();

-- ─── Seed data ────────────────────────────────────────────────────────────────
insert into public.states(name, code) values
  ('Odisha','OD'),('Haryana','HR'),('Delhi','DL'),
  ('Rajasthan','RJ'),('Gujarat','GJ'),('Telangana','TS'),('Kerala','KL')
on conflict (code) do nothing;

insert into public.products(code, name, category, uom) values
  ('KA-001','Nail Paint Passion 5ml','Nail Paint','PCS'),
  ('KA-002','Liquid Lip Color','Lip Color','PCS'),
  ('KA-003','Foundation Natural','Foundation','PCS'),
  ('KA-004','Foundation Skin','Foundation','PCS'),
  ('KA-005','Mascara Black','Eye','PCS')
on conflict (code) do nothing;
