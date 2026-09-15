-- Add is_test flag to meetings table for soft-hiding test/E2E data
--
-- Real production meetings (e.g., "Rama krishna and Rudra Gautam") remain visible;
-- this flag only marks synthetic test data that clutters production admin views.

alter table public.meetings
  add column if not exists is_test boolean not null default false;

comment on column public.meetings.is_test is
  'True for synthetic test/E2E meetings that should be hidden from production admin views. Real meetings remain false.';

-- Simple index for common admin filter pattern: show only real meetings
create index if not exists meetings_is_test_idx on public.meetings (is_test)
  where is_test = false;
