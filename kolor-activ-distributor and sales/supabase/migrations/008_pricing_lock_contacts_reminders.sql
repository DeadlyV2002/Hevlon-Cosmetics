-- STEP 8 — run after 007. Safe to run more than once.
-- Locks the Pricing page to named logins, adds email and sales officer to distributors (for the
-- DB List sheet), and sets up the monthly stock-update reminders sent by email and WhatsApp.

-- ---------- Pricing lock ----------
create table if not exists public.pricing_access(
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.pricing_access enable row level security;
drop policy if exists "see own pricing access" on public.pricing_access;
create policy "see own pricing access" on public.pricing_access for select to authenticated using (user_id = auth.uid());
grant select on public.pricing_access to authenticated;
-- The owner's login. To let someone else in later, run:
--   insert into pricing_access(user_id) select id from auth.users where email = 'their@email';
insert into public.pricing_access(user_id) select id from auth.users where lower(email) = 'vedantdaga2002@gmail.com' on conflict do nothing;

create or replace function public.can_price() returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from pricing_access where user_id = auth.uid())
$$;
revoke all on function public.can_price() from public, anon;
grant execute on function public.can_price() to authenticated;

drop policy if exists "managers update products" on public.products;
drop policy if exists "pricing updates products" on public.products;
create policy "pricing updates products" on public.products for update to authenticated using (public.can_price()) with check (public.can_price());

-- Settings: margins only by pricing logins, reminders by managers, the rest by HO admins.
drop policy if exists "admins change settings" on public.app_settings;
create policy "admins change settings" on public.app_settings for all to authenticated
  using (key not in ('margins', 'reminders') and public.is_admin()) with check (key not in ('margins', 'reminders') and public.is_admin());
drop policy if exists "managers change margins" on public.app_settings;
drop policy if exists "pricing changes margins" on public.app_settings;
create policy "pricing changes margins" on public.app_settings for all to authenticated
  using (key = 'margins' and public.can_price()) with check (key = 'margins' and public.can_price());
drop policy if exists "managers change reminders" on public.app_settings;
create policy "managers change reminders" on public.app_settings for all to authenticated
  using (key = 'reminders' and public.is_manager()) with check (key = 'reminders' and public.is_manager());

drop policy if exists "read schemes" on public.schemes;
create policy "read schemes" on public.schemes for select to authenticated using (public.can_price());
drop policy if exists "managers change schemes" on public.schemes;
drop policy if exists "pricing changes schemes" on public.schemes;
create policy "pricing changes schemes" on public.schemes for all to authenticated using (public.can_price()) with check (public.can_price());
-- Charts value dispatches with scheme discounts for everyone, so this reads schemes as the owner.
create or replace function public.ss_discount_on(p_ss uuid, p_on date) returns numeric
language sql stable security definer set search_path=public as $$
  select coalesce(max(ss_discount), 0) from schemes
   where p_on between starts_on and ends_on and (applies_to is null or p_ss = any(applies_to))
$$;

-- ---------- Distributor contacts ----------
alter table public.distributors add column if not exists email text;
alter table public.distributors add column if not exists so_id uuid references public.sales_officers(id) on delete set null;

-- ---------- Monthly stock reminders ----------
insert into public.app_settings(key, value) values ('reminders',
  '{"enabled": false, "send_day": 1, "due_day": 7, "every": 3, "max_follow_ups": 3, "email": true, "whatsapp": true, "super_stockists": true, "wa_template": "stock_update_reminder", "wa_language": "en"}'::jsonb)
  on conflict (key) do nothing;

create table if not exists public.reminder_log(
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.distributors(id) on delete cascade,
  period date not null,                 -- first day of the month the stock update is for
  kind text not null check (kind in ('FIRST', 'FOLLOW_UP')),
  channel text not null check (channel in ('EMAIL', 'WHATSAPP')),
  sent_to text,
  ok boolean not null,
  error text,
  sent_at timestamptz not null default now()
);
create index if not exists reminder_log_loc on public.reminder_log(location_id, period);
alter table public.reminder_log enable row level security;
drop policy if exists "read reminder log" on public.reminder_log;
create policy "read reminder log" on public.reminder_log for select to authenticated using (true);
grant select on public.reminder_log to authenticated;

-- Where each distributor stands for a month's stock update: whether any file has been posted for
-- it since that month ended, and the reminders already sent.
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
  where d.kind = 'DISTRIBUTOR' or (d.kind = 'SUPER_STOCKIST' and coalesce((select ss from s), true))
$$;
revoke all on function public.reminder_status(date) from public, anon;
grant execute on function public.reminder_status(date) to authenticated, service_role;

-- Who gets a reminder today, and which kind. The first goes out on the send day; follow-ups start
-- the day after the due day and repeat every few days until the file arrives or the limit is hit.
create or replace function public.reminders_due(p_today date default current_date)
returns table(location_id uuid, name text, email text, phone text, period date, kind text)
language sql stable security definer set search_path=public as $$
  with cfg as (select value v from app_settings where key = 'reminders'),
  p as (select (date_trunc('month', p_today) - interval '1 month')::date period),
  st as (select r.* from reminder_status((select period from p)) r)
  select st.location_id, st.name, st.email, st.phone, (select period from p),
         case when st.first_sent is null then 'FIRST' else 'FOLLOW_UP' end
  from st, cfg
  where coalesce((cfg.v->>'enabled')::boolean, false)
    and st.received_on is null
    and (coalesce(st.email, '') <> '' or coalesce(st.phone, '') <> '')
    and extract(day from p_today) >= coalesce((cfg.v->>'send_day')::int, 1)
    and (st.first_sent is null
         or (extract(day from p_today) > coalesce((cfg.v->>'due_day')::int, 7)
             and st.follow_ups < coalesce((cfg.v->>'max_follow_ups')::int, 3)
             and st.last_sent::date <= p_today - coalesce((cfg.v->>'every')::int, 3)))
$$;
revoke all on function public.reminders_due(date) from public, anon, authenticated;
grant execute on function public.reminders_due(date) to service_role;
grant insert on public.reminder_log to service_role;
