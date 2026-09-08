-- Codex post-implementation review (SHOULD-FIX): the original
-- domain-layer implementation of claimMeetingForSchedulerCall did the
-- scheduler_calls.meeting_id CAS-write and the meetings CAS-write as two
-- separate network round-trips. A process death between them left
-- scheduler_calls.meeting_id set (terminal — never re-evaluated) while the
-- target meeting stayed unlinked, an orphaned half-claim with no
-- self-healing path. This makes both writes one real Postgres transaction:
-- either both succeed, or the scheduler_calls side is explicitly released
-- back to null so a later sync pass can retry cleanly — the function
-- itself is the atomicity boundary, same reasoning as
-- claim_next_calendar_event_job (M4) using FOR UPDATE SKIP LOCKED inside
-- one function rather than composing separate PostgREST calls.
create or replace function public.claim_scheduler_call_meeting(
  p_scheduler_call_id uuid,
  p_organization_id uuid,
  p_meeting_id uuid,
  p_customer_id uuid,
  p_call_type public.call_type
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_call_id uuid;
  v_claimed_meeting_id uuid;
begin
  update public.scheduler_calls
  set meeting_id = p_meeting_id
  where id = p_scheduler_call_id
    and organization_id = p_organization_id
    and meeting_id is null
  returning id into v_claimed_call_id;

  -- Another concurrent run already claimed this scheduler_calls row —
  -- nothing to release, nothing was written.
  if v_claimed_call_id is null then
    return false;
  end if;

  update public.meetings
  set customer_id = p_customer_id,
      customer_link_status = 'linked_auto',
      needs_link_reason = null,
      linked_at = now(),
      linked_by_membership_id = null,
      call_type = p_call_type,
      call_type_source = 'external_scheduler'
  where id = p_meeting_id
    and organization_id = p_organization_id
    and (customer_link_status is null or customer_link_status = 'needs_link')
  returning id into v_claimed_meeting_id;

  if v_claimed_meeting_id is null then
    -- The meeting became resolved (by any tier, any caller) between our
    -- Tier read and this write — release the scheduler-side claim in the
    -- SAME transaction, so nothing is left half-committed regardless of
    -- what happens after this function returns.
    update public.scheduler_calls
    set meeting_id = null
    where id = p_scheduler_call_id
      and organization_id = p_organization_id;
    return false;
  end if;

  return true;
end;
$$;

grant execute on function public.claim_scheduler_call_meeting(uuid, uuid, uuid, uuid, public.call_type) to service_role;
