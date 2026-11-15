-- ============================================================================
--  Light Bearers Child Care Centre — Supabase schema
--  ---------------------------------------------------------------------------
--  HOW TO RUN
--    1. Create a project at https://supabase.com (free tier is fine).
--    2. Open  SQL Editor -> New query , paste this whole file, press Run.
--    3. Project Settings -> API , copy the "Project URL" and "anon public" key
--       into  config.js  (see the repo README).
--    4. Sign in to admin.html once with Google or email, then make yourself
--       staff by running the one-liner at the bottom of this file.
--
--  This file is safe to run more than once.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
--  PROFILES  — one row per signed-in user; role decides who is staff
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text unique not null,
  name       text,
  picture    text,
  role       text not null default 'parent',   -- 'parent' | 'admin'
  created_at timestamptz not null default now()
);

-- Auto-create a profile whenever somebody signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, picture)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
--  APPLICATIONS
-- ---------------------------------------------------------------------------
create table if not exists public.applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  email         text not null,
  parent_name   text, phone text, alt_phone text, relation text,
  address       jsonb not null default '{}'::jsonb,
  emergency     jsonb not null default '{}'::jsonb,
  status        text not null default 'pending',   -- pending | approved | rejected
  submitted_at  timestamptz not null default now(),
  reviewed_at   timestamptz,
  review_note   text default '',
  appeal        jsonb,                             -- { text, at }
  appeal_status text default 'none'                -- none | pending | accepted | declined
);
create index if not exists applications_user_idx   on public.applications(user_id);
create index if not exists applications_status_idx on public.applications(status);

-- ---------------------------------------------------------------------------
--  CHILDREN
-- ---------------------------------------------------------------------------
create table if not exists public.children (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references public.applications(id) on delete cascade,
  name           text not null,
  dob            date,
  gender         text,
  program        text,
  medical        text,
  student_no     text unique
);
create index if not exists children_app_idx on public.children(application_id);

-- ---------------------------------------------------------------------------
--  DOCUMENTS  (metadata only — the files live in the private storage bucket)
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references public.applications(id) on delete cascade,
  kind           text,          -- 'id' | 'address'
  file_path      text,
  file_name      text,
  mime           text,
  uploaded_at    timestamptz not null default now()
);
create index if not exists documents_app_idx on public.documents(application_id);

-- ---------------------------------------------------------------------------
--  INVOICES + PAYMENTS
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id         uuid primary key default gen_random_uuid(),
  child_id   uuid references public.children(id) on delete cascade,
  child_name text,
  program    text,
  period     text,                                   -- '2026-11'
  amount     numeric not null default 0,
  paid       numeric not null default 0,
  status     text not null default 'unpaid',         -- unpaid | partial | paid
  plan       boolean not null default false,
  due_date   timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invoices_child_idx  on public.invoices(child_id);
create index if not exists invoices_period_idx on public.invoices(period);

create table if not exists public.payments (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices(id) on delete cascade,
  amount     numeric not null,
  method     text,
  ref        text,
  at         timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments(invoice_id);

-- ---------------------------------------------------------------------------
--  MESSAGES (announcements) + read receipts
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  body      text,
  category  text default 'general',   -- general | trip | food | party | farewell | payment
  audience  text default 'all',       -- all | programme | student
  target    text,
  important boolean default false,
  author    text default 'Front office',
  at        timestamptz not null default now()
);

create table if not exists public.message_reads (
  message_id uuid references public.messages(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  primary key (message_id, user_id)
);

-- ---------------------------------------------------------------------------
--  OUTBOX  (every automated email is logged here)
-- ---------------------------------------------------------------------------
create table if not exists public.outbox (
  id       uuid primary key default gen_random_uuid(),
  to_email text, subject text, body text,
  status   text default 'demo',       -- demo | sent | failed
  provider text default 'demo',
  at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  SETTINGS  (key / jsonb value)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key   text primary key,
  value jsonb
);
insert into public.settings(key, value) values
  ('centre',          '"Light Bearers Child Care Centre"'::jsonb),
  ('planDays',        '60'::jsonb),
  ('registrationFee', '350'::jsonb),
  ('yocoPublicKey',   '""'::jsonb),
  ('emailjsService',  '""'::jsonb),
  ('emailjsTemplate', '""'::jsonb),
  ('emailjsPublicKey','""'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
--  HELPERS
--  Defined after the tables because Postgres validates SQL function bodies at
--  creation time. SECURITY DEFINER so policies can't recurse into themselves.
-- ===========================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.my_child_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.children c
  join public.applications a on a.id = c.application_id
  where a.user_id = auth.uid();
$$;

create or replace function public.my_programs()
returns setof text language sql stable security definer set search_path = public as $$
  select distinct c.program from public.children c
  join public.applications a on a.id = c.application_id
  where a.user_id = auth.uid();
$$;

create or replace function public.owns_application(p_app uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.applications a where a.id = p_app and a.user_id = auth.uid());
$$;

-- ===========================================================================
--  ROW LEVEL SECURITY
-- ===========================================================================
alter table public.profiles      enable row level security;
alter table public.applications  enable row level security;
alter table public.children      enable row level security;
alter table public.documents     enable row level security;
alter table public.invoices      enable row level security;
alter table public.payments      enable row level security;
alter table public.messages      enable row level security;
alter table public.message_reads enable row level security;
alter table public.outbox        enable row level security;
alter table public.settings      enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- applications --------------------------------------------------------------
drop policy if exists apps_select on public.applications;
create policy apps_select on public.applications for select
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists apps_insert on public.applications;
create policy apps_insert on public.applications for insert
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists apps_update on public.applications;
create policy apps_update on public.applications for update
  using (public.is_admin());

drop policy if exists apps_delete on public.applications;
create policy apps_delete on public.applications for delete
  using (public.is_admin());

-- children ------------------------------------------------------------------
drop policy if exists children_select on public.children;
create policy children_select on public.children for select
  using (public.owns_application(application_id) or public.is_admin());

drop policy if exists children_insert on public.children;
create policy children_insert on public.children for insert
  with check (public.owns_application(application_id) or public.is_admin());

drop policy if exists children_update on public.children;
create policy children_update on public.children for update
  using (public.is_admin());

drop policy if exists children_delete on public.children;
create policy children_delete on public.children for delete
  using (public.is_admin());

-- documents -----------------------------------------------------------------
drop policy if exists docs_select on public.documents;
create policy docs_select on public.documents for select
  using (public.owns_application(application_id) or public.is_admin());

drop policy if exists docs_insert on public.documents;
create policy docs_insert on public.documents for insert
  with check (public.owns_application(application_id) or public.is_admin());

drop policy if exists docs_delete on public.documents;
create policy docs_delete on public.documents for delete
  using (public.is_admin() or public.owns_application(application_id));

-- invoices ------------------------------------------------------------------
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select
  using (child_id in (select public.my_child_ids()) or public.is_admin());

drop policy if exists invoices_admin on public.invoices;
create policy invoices_admin on public.invoices for all
  using (public.is_admin()) with check (public.is_admin());

-- payments ------------------------------------------------------------------
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select
  using (public.is_admin() or invoice_id in (
    select i.id from public.invoices i where i.child_id in (select public.my_child_ids())
  ));

drop policy if exists payments_admin on public.payments;
create policy payments_admin on public.payments for all
  using (public.is_admin()) with check (public.is_admin());

-- messages ------------------------------------------------------------------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select
  using (
    public.is_admin()
    or audience = 'all'
    or (audience = 'programme' and target in (select public.my_programs()))
    or (audience = 'student'   and target in (select c.id::text from public.children c where c.id in (select public.my_child_ids())))
  );

drop policy if exists messages_admin on public.messages;
create policy messages_admin on public.messages for all
  using (public.is_admin()) with check (public.is_admin());

-- message reads -------------------------------------------------------------
drop policy if exists reads_own on public.message_reads;
create policy reads_own on public.message_reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- outbox (staff only) -------------------------------------------------------
drop policy if exists outbox_admin on public.outbox;
create policy outbox_admin on public.outbox for all
  using (public.is_admin()) with check (public.is_admin());

-- settings (everyone may read; staff may write) -----------------------------
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (true);

drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  STORAGE  (private bucket for ID / proof of address)
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists doc_files_insert on storage.objects;
create policy doc_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists doc_files_read on storage.objects;
create policy doc_files_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

drop policy if exists doc_files_delete on storage.objects;
create policy doc_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ===========================================================================
--  APP FUNCTIONS
-- ===========================================================================

-- Unique student numbers: LB26-1001, LB26-1002, …
create sequence if not exists public.student_no_seq start with 1001;

create or replace function public.next_student_no()
returns text language plpgsql security definer set search_path = public as $$
declare n bigint; y text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  n := nextval('public.student_no_seq');
  y := to_char(now(), 'YY');
  return 'LB' || y || '-' || lpad(n::text, 4, '0');
end $$;

-- Which email owns this student number? (used by "sign in with student number")
create or replace function public.email_for_student_no(p_no text)
returns text language sql stable security definer set search_path = public as $$
  select a.email
  from public.applications a
  join public.children c on c.application_id = a.id
  where upper(c.student_no) = upper(trim(p_no)) and a.status = 'approved'
  limit 1;
$$;

-- Create this month's invoices for the caller's approved children
create or replace function public.ensure_my_invoices(p_fees jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  period text := to_char(now(), 'YYYY-MM');
  fee numeric;
  n int := 0;
begin
  for r in
    select c.id, c.name, c.program
    from public.children c
    join public.applications a on a.id = c.application_id
    where a.user_id = auth.uid() and a.status = 'approved'
  loop
    if not exists (select 1 from public.invoices i where i.child_id = r.id and i.period = period) then
      fee := coalesce((p_fees->>r.program)::numeric, 1500);
      insert into public.invoices(child_id, child_name, program, period, amount, paid, status)
      values (r.id, r.name, r.program, period, fee, 0, 'unpaid');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Admin: create this month's invoices for one application
create or replace function public.ensure_invoices_for(p_app uuid, p_fees jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  period text := to_char(now(), 'YYYY-MM');
  fee numeric;
  n int := 0;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  for r in
    select c.id, c.name, c.program
    from public.children c
    join public.applications a on a.id = c.application_id
    where a.id = p_app and a.status = 'approved'
  loop
    if not exists (select 1 from public.invoices i where i.child_id = r.id and i.period = period) then
      fee := coalesce((p_fees->>r.program)::numeric, 1500);
      insert into public.invoices(child_id, child_name, program, period, amount, paid, status)
      values (r.id, r.name, r.program, period, fee, 0, 'unpaid');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Admin: approve an application. Issues missing student numbers, creates this
-- month's invoices, and returns the numbers that were issued.
create or replace function public.approve_application(
  p_app uuid, p_fees jsonb default '{}'::jsonb, p_status text default 'approved'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  no text;
  period text := to_char(now(), 'YYYY-MM');
  fee numeric;
  issued jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_status not in ('approved','pending') then raise exception 'bad status'; end if;

  update public.applications
     set status = p_status,
         reviewed_at = now(),
         review_note = '',
         appeal_status = case when p_status = 'approved' then 'accepted' else appeal_status end
   where id = p_app;

  for r in
    select c.id, c.name, c.program, c.student_no
    from public.children c
    where c.application_id = p_app
  loop
    if r.student_no is null then
      no := public.next_student_no();
      update public.children set student_no = no where id = r.id;
      issued := issued || to_jsonb(no);
    end if;

    if not exists (select 1 from public.invoices i where i.child_id = r.id and i.period = period) then
      fee := coalesce((p_fees->>r.program)::numeric, 1500);
      insert into public.invoices(child_id, child_name, program, period, amount, paid, status)
      values (r.id, r.name, r.program, period, fee, 0, 'unpaid');
    end if;
  end loop;

  return jsonb_build_object('issued', issued);
end $$;

-- Admin: dismiss / reject an application (resets the one allowed appeal)
create or replace function public.dismiss_application(p_app uuid, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.applications
     set status = 'rejected', reviewed_at = now(), review_note = coalesce(p_note,''),
         appeal = null, appeal_status = 'none'
   where id = p_app;
end $$;

-- Parent: submit the one and only appeal on a dismissed application
create or replace function public.submit_appeal(p_app uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.applications;
begin
  select * into a from public.applications where id = p_app;
  if a is null then raise exception 'application not found'; end if;
  if a.user_id is distinct from auth.uid() then raise exception 'not allowed'; end if;
  if a.status <> 'rejected' then raise exception 'there is nothing to appeal'; end if;
  if a.appeal is not null then raise exception 'you have already used your one appeal'; end if;
  if coalesce(trim(p_text),'') = '' then raise exception 'please explain your appeal'; end if;

  update public.applications
     set appeal = jsonb_build_object('text', trim(p_text), 'at', now()),
         appeal_status = 'pending'
   where id = p_app;
end $$;

-- Admin: final decision on an appeal
create or replace function public.decide_appeal(p_app uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.applications
     set appeal_status = case when p_accept then 'accepted' else 'declined' end
   where id = p_app;
end $$;

-- Record a fee payment and update the invoice atomically.
-- Callable by the owning parent or by staff.
create or replace function public.record_payment(
  p_invoice uuid, p_amount numeric, p_method text, p_plan boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  inv public.invoices;
  ref text;
  plan_days int;
  new_paid numeric;
begin
  select * into inv from public.invoices where id = p_invoice;
  if inv is null then raise exception 'invoice not found'; end if;
  if not (public.is_admin() or inv.child_id in (select public.my_child_ids())) then
    raise exception 'not allowed';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'bad amount'; end if;

  select coalesce((value)::text::int, 60) into plan_days from public.settings where key = 'planDays';
  plan_days := coalesce(plan_days, 60);

  ref := 'LB' || lpad((floor(random() * 10000000))::bigint::text, 7, '0');

  insert into public.payments(invoice_id, amount, method, ref)
  values (p_invoice, p_amount, p_method, ref);

  new_paid := inv.paid + p_amount;

  update public.invoices set
    paid     = new_paid,
    status   = case when new_paid >= amount then 'paid' else 'partial' end,
    plan     = case when new_paid >= amount then false else (plan or p_plan) end,
    due_date = case when new_paid < amount and p_plan
                    then now() + (plan_days || ' days')::interval
                    else due_date end
  where id = p_invoice;

  return jsonb_build_object('ref', ref, 'paid', new_paid, 'balance', inv.amount - new_paid);
end $$;

-- ===========================================================================
--  REALTIME  (so a phone and a PC update each other without a refresh)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['profiles','applications','children','documents','invoices',
                           'payments','messages','message_reads','outbox','settings']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- already published
      when undefined_object then null;   -- publication missing (very old project)
    end;
  end loop;
end $$;

-- ===========================================================================
--  MAKE YOURSELF STAFF
--  Sign in to admin.html once (so your profile row exists), then run:
--
--     update public.profiles set role = 'admin'
--      where email = 'YOUR-EMAIL@example.com';
--
--  (Or, once you are staff, use admin.html -> Settings -> Staff access.)
-- ============================================================================
