-- ============================================================
-- Gabay Estudyante — migration: semesters + adding schools from the app
-- Run this ONCE in Supabase → SQL Editor if you already ran schema.sql earlier.
-- Safe to run more than once.
-- ============================================================

-- Semesters (each school can have several; subjects, events and activities belong to one)
create table if not exists semesters (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);
alter table semesters enable row level security;
drop policy if exists "public read semesters" on semesters;
drop policy if exists "admin write semesters" on semesters;
create policy "public read semesters" on semesters for select using (true);
create policy "admin write semesters" on semesters for all using (is_admin()) with check (is_admin());

alter table subjects   add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table events     add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table activities add column if not exists semester_id uuid references semesters(id) on delete set null;

-- Every school gets a "Semester 1", and all existing data is labelled Semester 1
insert into semesters (school_id, name)
select s.id, 'Semester 1' from schools s
where not exists (select 1 from semesters m where m.school_id = s.id);

update subjects x set semester_id = (
  select m.id from semesters m where m.school_id = x.school_id order by m.created_at, m.id limit 1
) where x.semester_id is null;
update events x set semester_id = (
  select m.id from semesters m where m.school_id = x.school_id order by m.created_at, m.id limit 1
) where x.semester_id is null;
update activities x set semester_id = (
  select m.id from semesters m where m.school_id = x.school_id order by m.created_at, m.id limit 1
) where x.semester_id is null;

-- Let admins add new schools from the app (Account → Add school)
drop policy if exists "admin insert schools" on schools;
create policy "admin insert schools" on schools for insert with check (is_admin());
