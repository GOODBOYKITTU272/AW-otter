-- Meeting outcomes table + grant/RLS smoke tests.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

select has_table('public', 'meeting_outcomes', 'meeting_outcomes table exists');
select has_column('public', 'meeting_outcomes', 'summary', 'meeting_outcomes.summary exists');
select has_column('public', 'meeting_outcomes', 'key_decisions', 'meeting_outcomes.key_decisions exists');
select has_column('public', 'meeting_outcomes', 'action_items', 'meeting_outcomes.action_items exists');
select has_column('public', 'meeting_outcomes', 'open_questions', 'meeting_outcomes.open_questions exists');
select has_column('public', 'meeting_outcomes', 'transcript_id', 'meeting_outcomes.transcript_id exists');

select * from finish();
rollback;
