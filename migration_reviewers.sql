-- ============================================================
-- Gabay Estudyante — migration: flashcards by semester + lesson, and quiz groups
-- Run this ONCE in Supabase → SQL Editor. Safe to run more than once.
-- ============================================================
alter table flashcards add column if not exists semester_id uuid references semesters(id) on delete set null;
alter table flashcards add column if not exists lesson integer not null default 1;
alter table flashcards add column if not exists quiz_group integer not null default 0;  -- 0 = no group

-- Existing flashcards go to the semester of their subject
update flashcards f set semester_id = s.semester_id
from subjects s where s.id = f.subject_id and f.semester_id is null;
