-- ============================================================
-- Gabay Estudyante — Supabase schema
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste all of this → Run)
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- SCHOOLS (just PCCM and TUP)
-- ------------------------------------------------------------
create table if not exists schools (
  id text primary key,              -- 'pccm' or 'tup'
  full_name text not null,
  accent_color text not null default '#2F6F5E',
  bg_color text not null default '#F6F5F0'
);

insert into schools (id, full_name) values
  ('pccm', 'PCCM · BSOA – BS in Office Administration'),
  ('tup', 'TUP-Manila · BET – Electronics Technology')
on conflict (id) do update set full_name = excluded.full_name;

-- ------------------------------------------------------------
-- SUBJECTS
-- ------------------------------------------------------------
create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  code text not null default '',
  name text not null default 'New Subject',
  color text default '#2F6F5E',
  created_at timestamptz default now()
);

-- A subject can meet more than once a week (e.g. lecture Mon + lab Wed),
-- so each meeting time is its own row here rather than columns on subjects.
create table if not exists schedule_slots (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  day text default 'Mon',
  time text default '',
  room text default '',
  professor text default ''
);

create table if not exists syllabus_files (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  label text not null,
  type text default '',
  url text not null
);

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  label text not null,
  type text default '',
  url text not null
);

create table if not exists flashcards (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  question text not null,
  answer text not null,
  image_url text default ''
);

create table if not exists quiz_questions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  question text not null,
  choices text[] not null,
  correct_index int not null,
  difficulty text default 'Easy',
  image_url text default ''
);

-- PDF Books: distinct from "Materials" — for book-length references per subject
create table if not exists pdf_books (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  label text not null,
  author text default '',
  url text not null
);

-- ------------------------------------------------------------
-- CALENDAR EVENTS
-- ------------------------------------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  subject_id uuid references subjects(id) on delete set null,
  date date not null,
  title text not null,
  type text not null default 'event',   -- 'event' | 'due' | 'project'
  description text default ''
);

-- ------------------------------------------------------------
-- ACTIVITIES (assignments/activities/projects)
-- ------------------------------------------------------------
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  subject_id uuid references subjects(id) on delete set null,
  title text not null,
  type text not null default 'Assignment',
  start_date date,
  due_date date,
  instructions text default '',
  tags text[] default '{}',
  image_url text default ''
);

-- Links an auto-generated calendar event back to the activity that created it,
-- so editing/deleting an activity keeps its calendar entries in sync.
alter table events add column if not exists source_activity_id uuid references activities(id) on delete cascade;

-- ------------------------------------------------------------
-- FAQs (How-To page)
-- ------------------------------------------------------------
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  question text not null,
  answer text not null
);

-- ------------------------------------------------------------
-- RULES AND OTHERS
-- ------------------------------------------------------------
create table if not exists rules (
  school_id text primary key references schools(id) on delete cascade,
  vision text default '',
  mission text default '',
  preamble text default '',
  core_values text[] default '{}'
);

insert into rules (school_id) values ('pccm'), ('tup')
on conflict (school_id) do nothing;

create table if not exists guidelines (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  title text not null,
  body text not null
);

-- ------------------------------------------------------------
-- ADMIN ALLOWLIST
-- Only emails listed here (after signing in with Google) can write data.
-- ------------------------------------------------------------
create table if not exists admins (
  email text primary key,
  added_at timestamptz default now()
);

-- 👉 IMPORTANT: put YOUR Google account email here so you can log into Admin.
-- Edit this line before running, or run it separately afterward.
insert into admins (email) values ('YOUR_EMAIL@gmail.com')
on conflict (email) do nothing;

-- ------------------------------------------------------------
-- is_admin() helper — checks the signed-in user's email against
-- the admins table, bypassing RLS on that table (security definer).
-- ------------------------------------------------------------
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admins where email = auth.jwt() ->> 'email'
  );
$$;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Everyone (including anonymous visitors) can READ.
-- Only signed-in users whose email is in `admins` can WRITE.
-- ------------------------------------------------------------
alter table schools enable row level security;
alter table subjects enable row level security;
alter table syllabus_files enable row level security;
alter table pdf_books enable row level security;
alter table schedule_slots enable row level security;
alter table materials enable row level security;
alter table flashcards enable row level security;
alter table quiz_questions enable row level security;
alter table events enable row level security;
alter table activities enable row level security;
alter table faqs enable row level security;
alter table rules enable row level security;
alter table guidelines enable row level security;
alter table admins enable row level security;

-- Public read policies
create policy "public read schools" on schools for select using (true);
create policy "admin write schools" on schools for update using (is_admin()) with check (is_admin());
create policy "public read subjects" on subjects for select using (true);
create policy "public read syllabus_files" on syllabus_files for select using (true);
create policy "public read pdf_books" on pdf_books for select using (true);
create policy "public read schedule_slots" on schedule_slots for select using (true);
create policy "public read materials" on materials for select using (true);
create policy "public read flashcards" on flashcards for select using (true);
create policy "public read quiz_questions" on quiz_questions for select using (true);
create policy "public read events" on events for select using (true);
create policy "public read activities" on activities for select using (true);
create policy "public read faqs" on faqs for select using (true);
create policy "public read rules" on rules for select using (true);
create policy "public read guidelines" on guidelines for select using (true);

-- Admin-only write policies (insert/update/delete)
create policy "admin write subjects" on subjects for all using (is_admin()) with check (is_admin());
create policy "admin write syllabus_files" on syllabus_files for all using (is_admin()) with check (is_admin());
create policy "admin write pdf_books" on pdf_books for all using (is_admin()) with check (is_admin());
create policy "admin write schedule_slots" on schedule_slots for all using (is_admin()) with check (is_admin());
create policy "admin write materials" on materials for all using (is_admin()) with check (is_admin());
create policy "admin write flashcards" on flashcards for all using (is_admin()) with check (is_admin());
create policy "admin write quiz_questions" on quiz_questions for all using (is_admin()) with check (is_admin());
create policy "admin write events" on events for all using (is_admin()) with check (is_admin());
create policy "admin write activities" on activities for all using (is_admin()) with check (is_admin());
create policy "admin write faqs" on faqs for all using (is_admin()) with check (is_admin());
create policy "admin write rules" on rules for all using (is_admin()) with check (is_admin());
create policy "admin write guidelines" on guidelines for all using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------
-- CUSTOM TYPES (extra calendar types and activity types, with colors)
-- Built-in types (Event/Due/Project, Assignment/Activity/Project) live in the app code.
-- ------------------------------------------------------------
create table if not exists item_types (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  kind text not null check (kind in ('event','activity')),
  type_key text not null,
  label text not null,
  color text not null default '#7C5CBF',
  created_at timestamptz default now(),
  unique (school_id, kind, type_key)
);
alter table item_types enable row level security;
create policy "public read item_types" on item_types for select using (true);
create policy "admin write item_types" on item_types for all using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------
-- SEMESTERS (subjects, events and activities belong to one semester)
-- ------------------------------------------------------------
create table if not exists semesters (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references schools(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);
alter table semesters enable row level security;
create policy "public read semesters" on semesters for select using (true);
create policy "admin write semesters" on semesters for all using (is_admin()) with check (is_admin());

alter table subjects   add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table events     add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table activities add column if not exists semester_id uuid references semesters(id) on delete set null;

insert into semesters (school_id, name)
select s.id, 'Semester 1' from schools s
where not exists (select 1 from semesters m where m.school_id = s.id);

-- Admins can add new schools from the app (Account -> Add school)
create policy "admin insert schools" on schools for insert with check (is_admin());

-- Nobody can read the admins table directly from the client (is_admin() reads it internally instead).
-- No select policy is created for `admins`, so it stays locked down.

-- ============================================================
-- Done. Next steps:
-- 1. Enable the Google provider: Authentication → Providers → Google (see README.md)
-- 2. Copy your Project URL + anon public key: Settings → API
-- 3. Paste them into supabase-client.js
-- 4. Make sure your real Google email is in the `admins` table above
-- ============================================================

-- Flashcards by semester + lesson, and quiz groups (see migration_reviewers.sql)
alter table flashcards add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table flashcards add column if not exists lesson integer not null default 1;
alter table flashcards add column if not exists quiz_group integer not null default 0;
update flashcards f set semester_id = s.semester_id
from subjects s where s.id = f.subject_id and f.semester_id is null;
