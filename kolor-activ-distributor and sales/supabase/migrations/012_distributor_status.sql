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
