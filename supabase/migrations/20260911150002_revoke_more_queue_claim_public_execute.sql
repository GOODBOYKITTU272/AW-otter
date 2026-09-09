-- Security hardening (M15 audit, P0, independently verified before
-- fixing): a systematic sweep of every SECURITY DEFINER function in
-- public (the PostgREST-exposed schema) found two more instances of the
-- same "grant to service_role but never revoke the default PUBLIC
-- EXECUTE grant" bug already fixed once for
-- claim_next_calendar_event_job (20260911150001).
--
-- 1. public.claim_next_transcription_job() (M8, 20260908060001_
--    transcription_tables.sql) returns a real row type (public.
--    meeting_transcripts), not `trigger` — directly callable via
--    PostgREST. Confirmed exploitable against the real local database
--    before this fix: `set role authenticated; select * from
--    public.claim_next_transcription_job();` (and the same as `anon`)
--    both succeeded — either role could dequeue/claim the oldest pending
--    transcription job ACROSS EVERY ORGANIZATION.
--
-- 2. public.claim_scheduler_call_meeting(uuid,uuid,uuid,uuid,call_type)
--    (M8, 20260908050003_scheduler_call_meeting_claim_function.sql) is
--    worse in kind, not just severity: it takes the scheduler_call id,
--    organization id, meeting id, customer id, and call type as
--    caller-supplied arguments with NO internal authorization check of
--    its own (no private.current_organization_id() comparison, nothing)
--    — its only security boundary was ever meant to be the GRANT.
--    Confirmed exploitable: `has_function_privilege('authenticated',
--    'public.claim_scheduler_call_meeting(uuid,uuid,uuid,uuid,
--    public.call_type)', 'execute')` (and the same for `anon`) both
--    returned true. Any authenticated (or anon) caller could have linked
--    an ARBITRARY scheduler_calls row to an ARBITRARY meeting in ANY
--    organization of their choosing, bypassing the RLS that otherwise
--    protects both tables entirely.
--
-- Same fix pattern as 20260911150001 and the "M9 CI grant lesson":
-- explicit named-role revokes, not just a bare grant.
revoke execute on function public.claim_next_transcription_job() from public, anon, authenticated, service_role;
grant execute on function public.claim_next_transcription_job() to service_role;

revoke execute on function public.claim_scheduler_call_meeting(uuid, uuid, uuid, uuid, public.call_type) from public, anon, authenticated, service_role;
grant execute on function public.claim_scheduler_call_meeting(uuid, uuid, uuid, uuid, public.call_type) to service_role;
