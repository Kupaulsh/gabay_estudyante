-- ============================================================
-- Gabay Estudyante — migration: custom calendar / activity types
-- Run this ONCE in Supabase → SQL Editor if you already ran schema.sql earlier.
-- Safe to run more than once.
-- ============================================================

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

drop policy if exists "public read item_types" on item_types;
create policy "public read item_types" on item_types for select using (true);

drop policy if exists "admin write item_types" on item_types;
create policy "admin write item_types" on item_types for all using (is_admin()) with check (is_admin());
