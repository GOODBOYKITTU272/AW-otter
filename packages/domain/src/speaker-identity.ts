import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

export type SpeakerBusinessRole = "AM" | "CANDIDATE" | "OTHER" | "UNKNOWN";

export interface SpeakerResolutionContext {
  meetingId: string;
  organizationId: string;
  ownerMembershipId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  candidateId?: string | null;
  candidateName?: string | null;
  candidateEmail?: string | null;
  attendees?: Array<{
    displayName?: string | null;
    email?: string | null;
    participantType?: string | null;
  }>;
  segments: Array<{
    speakerLabel: string;
    text: string;
    startMs: number;
    endMs: number;
    sequenceIndex: number;
  }>;
}

export interface ResolvedSpeakerIdentity {
  rawSpeakerTag: string;
  businessRole: SpeakerBusinessRole;
  interpretedName: string | null;
  interpretedEmail: string | null;
  membershipId: string | null;
  customerId: string | null;
  interpretationSource: string;
  interpretationConfidence: number;
  reasoning: string;
}

export interface CorrectSpeakerInterpretationInput {
  interpretationId: string;
  organizationId: string;
  actorMembershipId: string;
  businessRole: SpeakerBusinessRole;
  interpretedName?: string | null;
  interpretedEmail?: string | null;
  membershipId?: string | null;
  customerId?: string | null;
  reason?: string;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/);
  // Strip honorifics like Dr., Mr., Ms.
  const first = parts[0]?.replace(/[^\w]/g, "").toLowerCase();
  if (first && ["dr", "mr", "mrs", "ms"].includes(first)) {
    return parts[1]?.replace(/[^\w]/g, "").toLowerCase() ?? null;
  }
  return first || null;
}

function extractSelfIntroNames(text: string): string[] {
  const names: string[] = [];
  const normalized = normalizeText(text);

  const introRegex = /(?:this is|i am|i m|my name is)\s+([a-z]+)/gi;
  let match;
  while ((match = introRegex.exec(normalized)) !== null) {
    const token = match[1]?.toLowerCase();
    if (token && !["a", "the", "from", "with", "just", "calling"].includes(token)) {
      names.push(token);
    }
  }

  const hereRegex = /\b([a-z]+)\s+here\b/gi;
  while ((match = hereRegex.exec(normalized)) !== null) {
    const token = match[1]?.toLowerCase();
    if (token && !["right", "out", "over", "in", "down", "up", "stay"].includes(token)) {
      names.push(token);
    }
  }

  return names;
}

function extractAddressedNames(text: string): string[] {
  const names: string[] = [];
  const normalized = normalizeText(text);

  const greetRegex = /(?:hi|hello|hey|thanks|thank you)\s+([a-z]+)/gi;
  let match;
  while ((match = greetRegex.exec(normalized)) !== null) {
    const token = match[1]?.toLowerCase();
    if (token && !["everyone", "all", "there", "again", "for", "team", "both", "guys"].includes(token)) {
      names.push(token);
    }
  }

  return names;
}

export function resolveSpeakerIdentities(
  context: SpeakerResolutionContext,
): ResolvedSpeakerIdentity[] {
  const uniqueTags: string[] = [];
  for (const seg of context.segments) {
    const tag = seg.speakerLabel?.trim();
    if (tag && !uniqueTags.includes(tag)) {
      uniqueTags.push(tag);
    }
  }

  if (uniqueTags.length === 0) {
    return [];
  }

  const tagTextMap = new Map<string, string[]>();
  for (const tag of uniqueTags) {
    tagTextMap.set(tag, []);
  }
  for (const seg of context.segments) {
    const tag = seg.speakerLabel?.trim();
    if (tag && tagTextMap.has(tag)) {
      tagTextMap.get(tag)!.push(seg.text);
    }
  }

  const results: ResolvedSpeakerIdentity[] = [];
  const assignedRoles = new Map<string, SpeakerBusinessRole>();

  const amFirstName = extractFirstName(context.ownerName);
  const candFirstName = extractFirstName(context.candidateName);

  // 1. Pass 1: Explicit Self-Identification
  for (const tag of uniqueTags) {
    const texts = tagTextMap.get(tag) ?? [];
    const introWindow = texts.slice(0, 10).join(" ");
    const normalized = normalizeText(introWindow);

    const selfNames = extractSelfIntroNames(introWindow);
    const mentionsApplyWizz =
      normalized.includes("apply wizz") ||
      normalized.includes("applywizz") ||
      normalized.includes("from apply");

    let isAm = false;
    let isCandidate = false;
    let isOther = false;
    let matchedAttendeeName: string | null = null;
    let matchedAttendeeEmail: string | null = null;

    if (amFirstName && selfNames.includes(amFirstName)) {
      isAm = true;
    }
    if (candFirstName && selfNames.includes(candFirstName)) {
      isCandidate = true;
    }

    if (mentionsApplyWizz && !isCandidate) {
      isAm = true;
    }

    // Check third-party / external attendees
    if (!isAm && !isCandidate && context.attendees) {
      for (const attendee of context.attendees) {
        const attFirstName = extractFirstName(attendee.displayName);
        if (attFirstName && selfNames.includes(attFirstName)) {
          if (attFirstName !== amFirstName && attFirstName !== candFirstName) {
            isOther = true;
            matchedAttendeeName = attendee.displayName ?? null;
            matchedAttendeeEmail = attendee.email ?? null;
            break;
          }
        }
      }
    }

    if (isAm && !isCandidate) {
      assignedRoles.set(tag, "AM");
      results.push({
        rawSpeakerTag: tag,
        businessRole: "AM",
        interpretedName: context.ownerName ?? null,
        interpretedEmail: context.ownerEmail ?? null,
        membershipId: context.ownerMembershipId ?? null,
        customerId: null,
        interpretationSource: "self_introduction",
        interpretationConfidence: 0.95,
        reasoning: `Self-identified as AM host (${context.ownerName})`,
      });
    } else if (isCandidate && !isAm) {
      assignedRoles.set(tag, "CANDIDATE");
      results.push({
        rawSpeakerTag: tag,
        businessRole: "CANDIDATE",
        interpretedName: context.candidateName ?? null,
        interpretedEmail: context.candidateEmail ?? null,
        membershipId: null,
        customerId: context.candidateId ?? null,
        interpretationSource: "self_introduction",
        interpretationConfidence: 0.95,
        reasoning: `Self-identified as candidate (${context.candidateName})`,
      });
    } else if (isOther) {
      assignedRoles.set(tag, "OTHER");
      results.push({
        rawSpeakerTag: tag,
        businessRole: "OTHER",
        interpretedName: matchedAttendeeName,
        interpretedEmail: matchedAttendeeEmail,
        membershipId: null,
        customerId: null,
        interpretationSource: "self_introduction",
        interpretationConfidence: 0.92,
        reasoning: `Self-identified as external attendee (${matchedAttendeeName})`,
      });
    }
  }

  // 2. Pass 2: Counterparty Addressing
  for (const tag of uniqueTags) {
    if (assignedRoles.has(tag)) continue;

    for (const [otherTag, otherTexts] of tagTextMap.entries()) {
      if (otherTag === tag) continue;
      const combined = otherTexts.slice(0, 10).join(" ");
      const addressedNames = extractAddressedNames(combined);

      // If other speaker greeted candidate
      if (candFirstName && addressedNames.includes(candFirstName)) {
        if (assignedRoles.get(otherTag) === "AM" || uniqueTags.length === 2) {
          assignedRoles.set(tag, "CANDIDATE");
          results.push({
            rawSpeakerTag: tag,
            businessRole: "CANDIDATE",
            interpretedName: context.candidateName ?? null,
            interpretedEmail: context.candidateEmail ?? null,
            membershipId: null,
            customerId: context.candidateId ?? null,
            interpretationSource: "counterparty_addressing",
            interpretationConfidence: 0.88,
            reasoning: `Addressed as candidate "${context.candidateName}" by ${otherTag}`,
          });
          break;
        }
      }

      // If other speaker greeted AM
      if (amFirstName && addressedNames.includes(amFirstName)) {
        if (assignedRoles.get(otherTag) === "CANDIDATE" || uniqueTags.length === 2) {
          assignedRoles.set(tag, "AM");
          results.push({
            rawSpeakerTag: tag,
            businessRole: "AM",
            interpretedName: context.ownerName ?? null,
            interpretedEmail: context.ownerEmail ?? null,
            membershipId: context.ownerMembershipId ?? null,
            customerId: null,
            interpretationSource: "counterparty_addressing",
            interpretationConfidence: 0.88,
            reasoning: `Addressed as AM "${context.ownerName}" by ${otherTag}`,
          });
          break;
        }
      }
    }
  }

  // 3. Pass 3: Two-Party Elimination
  if (uniqueTags.length === 2) {
    const knownTags = Array.from(assignedRoles.keys());
    if (knownTags.length === 1 && knownTags[0]) {
      const knownTag = knownTags[0];
      const knownRole = assignedRoles.get(knownTag);
      const unknownTag = uniqueTags.find((t) => t !== knownTag);

      if (knownRole && unknownTag) {
        if (knownRole === "AM" && context.candidateName) {
          assignedRoles.set(unknownTag, "CANDIDATE");
          results.push({
            rawSpeakerTag: unknownTag,
            businessRole: "CANDIDATE",
            interpretedName: context.candidateName ?? null,
            interpretedEmail: context.candidateEmail ?? null,
            membershipId: null,
            customerId: context.candidateId ?? null,
            interpretationSource: "two_party_elimination",
            interpretationConfidence: 0.82,
            reasoning: `Inferred as candidate in two-party call with confirmed AM (${knownTag})`,
          });
        } else if (knownRole === "CANDIDATE" && context.ownerName) {
          assignedRoles.set(unknownTag, "AM");
          results.push({
            rawSpeakerTag: unknownTag,
            businessRole: "AM",
            interpretedName: context.ownerName ?? null,
            interpretedEmail: context.ownerEmail ?? null,
            membershipId: context.ownerMembershipId ?? null,
            customerId: null,
            interpretationSource: "two_party_elimination",
            interpretationConfidence: 0.82,
            reasoning: `Inferred as AM in two-party call with confirmed candidate (${knownTag})`,
          });
        }
      }
    }
  }

  // 4. Pass 4: Fallback to UNKNOWN (low confidence)
  // Never guess or force Speaker 0 to AM!
  for (const tag of uniqueTags) {
    if (assignedRoles.has(tag)) continue;

    assignedRoles.set(tag, "UNKNOWN");
    results.push({
      rawSpeakerTag: tag,
      businessRole: "UNKNOWN",
      interpretedName: null,
      interpretedEmail: null,
      membershipId: null,
      customerId: null,
      interpretationSource: "unidentified_default",
      interpretationConfidence: 0.1,
      reasoning: "No deterministic self-introduction, counterparty greeting, or roster match found.",
    });
  }

  return uniqueTags.map((tag) => results.find((r) => r.rawSpeakerTag === tag)!);
}

export async function inferAndPersistSpeakerInterpretations(
  client: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
): Promise<ResolvedSpeakerIdentity[]> {
  const { data: meeting, error: meetingError } = await client
    .from("meetings")
    .select("id, organization_id, owner_membership_id, customer_id, organizer_email")
    .eq("id", meetingId)
    .eq("organization_id", organizationId)
    .single();
  if (meetingError) throw meetingError;

  let ownerName: string | null = null;
  let ownerEmail: string | null = null;
  if (meeting.owner_membership_id) {
    const { data: owner } = await client
      .from("organization_memberships")
      .select("display_name, work_email")
      .eq("id", meeting.owner_membership_id)
      .maybeSingle();
    if (owner) {
      ownerName = owner.display_name;
      ownerEmail = owner.work_email;
    }
  }

  let candidateName: string | null = null;
  let candidateEmail: string | null = null;
  if (meeting.customer_id) {
    const { data: customer } = await client
      .from("customers")
      .select("name")
      .eq("id", meeting.customer_id)
      .maybeSingle();
    if (customer) {
      candidateName = customer.name;
    }
  }

  const { data: attendees } = await client
    .from("meeting_attendees")
    .select("display_name, email, participant_type")
    .eq("meeting_id", meetingId);

  if (attendees) {
    for (const a of attendees) {
      if (candidateName && a.display_name && a.display_name.toLowerCase().includes(candidateName.toLowerCase())) {
        candidateEmail = a.email;
        break;
      } else if (!candidateEmail && a.participant_type === "external" && a.email) {
        candidateEmail = a.email;
      }
    }
  }

  const { data: transcript } = await client
    .from("meeting_transcripts")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!transcript) {
    return [];
  }

  const { data: segments, error: segError } = await client
    .from("transcript_segments")
    .select("speaker_label, original_text, canonical_english_text, start_ms, end_ms, sequence_index")
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });
  if (segError) throw segError;

  const { data: existingInterpretations, error: existError } = await client
    .from("meeting_speaker_interpretations")
    .select("id, raw_speaker_tag, confirmed_by_human, business_role, interpreted_name")
    .eq("meeting_id", meetingId)
    .eq("organization_id", organizationId);
  if (existError) throw existError;

  const existingMap = new Map(
    (existingInterpretations ?? []).map((row) => [row.raw_speaker_tag, row]),
  );

  const resolved = resolveSpeakerIdentities({
    meetingId,
    organizationId,
    ownerMembershipId: meeting.owner_membership_id,
    ownerName,
    ownerEmail: ownerEmail ?? meeting.organizer_email,
    candidateId: meeting.customer_id,
    candidateName,
    candidateEmail,
    attendees: (attendees ?? []).map((a) => ({
      displayName: a.display_name,
      email: a.email,
      participantType: a.participant_type,
    })),
    segments: (segments ?? []).map((s) => ({
      speakerLabel: s.speaker_label ?? "UNKNOWN",
      text: s.canonical_english_text ?? s.original_text,
      startMs: s.start_ms,
      endMs: s.end_ms,
      sequenceIndex: s.sequence_index,
    })),
  });

  for (const item of resolved) {
    const existing = existingMap.get(item.rawSpeakerTag);

    if (existing?.confirmed_by_human) {
      continue;
    }

    if (existing) {
      const { error: updateError } = await client
        .from("meeting_speaker_interpretations")
        .update({
          business_role: item.businessRole,
          interpreted_name: item.interpretedName,
          interpreted_email: item.interpretedEmail,
          membership_id: item.membershipId,
          customer_id: item.customerId,
          interpretation_source: item.interpretationSource,
          interpretation_confidence: item.interpretationConfidence,
          reasoning: item.reasoning,
        })
        .eq("id", existing.id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await client
        .from("meeting_speaker_interpretations")
        .insert({
          organization_id: organizationId,
          meeting_id: meetingId,
          transcript_id: transcript.id,
          raw_speaker_tag: item.rawSpeakerTag,
          business_role: item.businessRole,
          interpreted_name: item.interpretedName,
          interpreted_email: item.interpretedEmail,
          membership_id: item.membershipId,
          customer_id: item.customerId,
          interpretation_source: item.interpretationSource,
          interpretation_confidence: item.interpretationConfidence,
          reasoning: item.reasoning,
        });
      if (insertError) throw insertError;
    }
  }

  return resolved;
}

export async function correctSpeakerInterpretation(
  client: AppSupabaseClient,
  input: CorrectSpeakerInterpretationInput,
): Promise<void> {
  const { data: existing, error: readError } = await client
    .from("meeting_speaker_interpretations")
    .select("id, meeting_id, raw_speaker_tag, business_role, interpreted_name, confirmed_by_human")
    .eq("id", input.interpretationId)
    .eq("organization_id", input.organizationId)
    .single();
  if (readError) throw readError;

  const now = new Date().toISOString();
  const { error: updateError } = await client
    .from("meeting_speaker_interpretations")
    .update({
      business_role: input.businessRole,
      interpreted_name: input.interpretedName ?? null,
      interpreted_email: input.interpretedEmail ?? null,
      membership_id: input.membershipId ?? null,
      customer_id: input.customerId ?? null,
      confirmed_by_human: true,
      confirmed_by_membership_id: input.actorMembershipId,
      confirmed_at: now,
      interpretation_source: "human_correction",
      interpretation_confidence: 1.0,
      reasoning: input.reason ?? "Corrected by human reviewer",
    })
    .eq("id", input.interpretationId)
    .eq("organization_id", input.organizationId);
  if (updateError) throw updateError;

  await logAuditEvent(client, {
    organizationId: input.organizationId,
    actorId: input.actorMembershipId,
    action: "speaker_interpretation.corrected",
    entityType: "meeting_speaker_interpretation",
    entityId: input.interpretationId,
    metadata: {
      meetingId: existing.meeting_id,
      rawSpeakerTag: existing.raw_speaker_tag,
      previousRole: existing.business_role,
      newRole: input.businessRole,
      previousName: existing.interpreted_name,
      newName: input.interpretedName ?? null,
      reason: input.reason ?? null,
    },
  });
}
