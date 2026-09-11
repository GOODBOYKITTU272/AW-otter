import { describe, it, expect, vi } from "vitest";
import {
  resolveSpeakerIdentities,
  inferAndPersistSpeakerInterpretations,
  correctSpeakerInterpretation,
  type SpeakerResolutionContext,
  type AppSupabaseClient,
} from "./speaker-identity";

describe("Speaker Identity & Business Role Interpretation (P3D)", () => {
  const baseContext: SpeakerResolutionContext = {
    meetingId: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ownerMembershipId: "mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm",
    ownerName: "Rama Chandra",
    ownerEmail: "rama@applywizz.com",
    candidateId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    candidateName: "Kartik Patel",
    candidateEmail: "kartik@example.com",
    attendees: [
      { displayName: "Rama Chandra", email: "rama@applywizz.com", participantType: "organizer" },
      { displayName: "Kartik Patel", email: "kartik@example.com", participantType: "external" },
    ],
    segments: [],
  };

  it("Scenario 1: AM speaks first with explicit self-introduction", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "Hi Kartik, this is Rama from Apply Wizz. Thanks for joining today.",
          startMs: 0,
          endMs: 3500,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Hey Rama, glad to be here.",
          startMs: 3600,
          endMs: 6000,
          sequenceIndex: 1,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    expect(resolved).toHaveLength(2);

    const am = resolved.find((r) => r.rawSpeakerTag === "Speaker 0");
    expect(am?.businessRole).toBe("AM");
    expect(am?.interpretedName).toBe("Rama Chandra");
    expect(am?.membershipId).toBe(context.ownerMembershipId);
    expect(am?.interpretationSource).toBe("self_introduction");
    expect(am?.interpretationConfidence).toBeGreaterThanOrEqual(0.9);

    const candidate = resolved.find((r) => r.rawSpeakerTag === "Speaker 1");
    expect(candidate?.businessRole).toBe("CANDIDATE");
    expect(candidate?.interpretedName).toBe("Kartik Patel");
    expect(candidate?.customerId).toBe(context.candidateId);
    expect(candidate?.interpretationConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it("Scenario 2: Candidate speaks first — PROVES Speaker 0 is NOT automatically AM", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "Hello? Hi Rama, this is Kartik Patel here. Am I audible?",
          startMs: 0,
          endMs: 3500,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Yes Kartik, I can hear you loud and clear. Rama here from Apply Wizz.",
          startMs: 3600,
          endMs: 7000,
          sequenceIndex: 1,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    expect(resolved).toHaveLength(2);

    // Speaker 0 is Candidate, NOT AM!
    const speaker0 = resolved.find((r) => r.rawSpeakerTag === "Speaker 0");
    expect(speaker0?.businessRole).toBe("CANDIDATE");
    expect(speaker0?.interpretedName).toBe("Kartik Patel");
    expect(speaker0?.customerId).toBe(context.candidateId);
    expect(speaker0?.interpretationSource).toBe("self_introduction");

    // Speaker 1 is AM
    const speaker1 = resolved.find((r) => r.rawSpeakerTag === "Speaker 1");
    expect(speaker1?.businessRole).toBe("AM");
    expect(speaker1?.interpretedName).toBe("Rama Chandra");
    expect(speaker1?.membershipId).toBe(context.ownerMembershipId);
  });

  it("Scenario 3: AM speaks second after candidate greets", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "Hey Rama, how are you doing today?",
          startMs: 0,
          endMs: 2500,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Doing great Kartik! This is Rama from Apply Wizz, welcome to our onboarding call.",
          startMs: 2600,
          endMs: 6500,
          sequenceIndex: 1,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    const s0 = resolved.find((r) => r.rawSpeakerTag === "Speaker 0");
    const s1 = resolved.find((r) => r.rawSpeakerTag === "Speaker 1");

    expect(s1?.businessRole).toBe("AM");
    expect(s1?.interpretedName).toBe("Rama Chandra");
    expect(s0?.businessRole).toBe("CANDIDATE");
    expect(s0?.interpretedName).toBe("Kartik Patel");
  });

  it("Scenario 4: 3+ speakers with external attendee assigned to OTHER", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      attendees: [
        { displayName: "Rama Chandra", email: "rama@applywizz.com", participantType: "organizer" },
        { displayName: "Kartik Patel", email: "kartik@example.com", participantType: "external" },
        { displayName: "Dr. Evelyn Vance", email: "evelyn@consulting.test", participantType: "external" },
      ],
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "Welcome everyone, this is Rama from Apply Wizz.",
          startMs: 0,
          endMs: 3000,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Hi Rama, Kartik here.",
          startMs: 3100,
          endMs: 5000,
          sequenceIndex: 1,
        },
        {
          speakerLabel: "Speaker 2",
          text: "Hello Rama and Kartik, this is Evelyn joining to observe.",
          startMs: 5100,
          endMs: 8000,
          sequenceIndex: 2,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    expect(resolved).toHaveLength(3);

    const s0 = resolved.find((r) => r.rawSpeakerTag === "Speaker 0");
    expect(s0?.businessRole).toBe("AM");

    const s1 = resolved.find((r) => r.rawSpeakerTag === "Speaker 1");
    expect(s1?.businessRole).toBe("CANDIDATE");

    const s2 = resolved.find((r) => r.rawSpeakerTag === "Speaker 2");
    expect(s2?.businessRole).toBe("OTHER");
    expect(s2?.interpretedName).toBe("Dr. Evelyn Vance");
    expect(s2?.interpretedEmail).toBe("evelyn@consulting.test");
  });

  it("Scenario 5: 3+ speakers with one unidentified speaker defaulting to UNKNOWN", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "This is Rama from Apply Wizz, welcoming Kartik Patel.",
          startMs: 0,
          endMs: 3000,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Thank you Rama, happy to meet.",
          startMs: 3100,
          endMs: 5000,
          sequenceIndex: 1,
        },
        {
          speakerLabel: "Speaker 2",
          text: "Mmhmm. Okay.",
          startMs: 5100,
          endMs: 6000,
          sequenceIndex: 2,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    const s2 = resolved.find((r) => r.rawSpeakerTag === "Speaker 2");
    expect(s2?.businessRole).toBe("UNKNOWN");
    expect(s2?.interpretationConfidence).toBeLessThan(0.5);
    expect(s2?.interpretedName).toBeNull();
  });

  it("Scenario 6: Completely ambiguous dialogue defaults ALL speakers to UNKNOWN", () => {
    const context: SpeakerResolutionContext = {
      ...baseContext,
      segments: [
        {
          speakerLabel: "Speaker 0",
          text: "Can everyone see the slides?",
          startMs: 0,
          endMs: 2000,
          sequenceIndex: 0,
        },
        {
          speakerLabel: "Speaker 1",
          text: "Yes, looks good.",
          startMs: 2100,
          endMs: 3500,
          sequenceIndex: 1,
        },
      ],
    };

    const resolved = resolveSpeakerIdentities(context);
    expect(resolved).toHaveLength(2);

    for (const r of resolved) {
      expect(r.businessRole).toBe("UNKNOWN");
      expect(r.interpretedName).toBeNull();
      expect(r.interpretationConfidence).toBeLessThan(0.5);
    }
  });

  it("Scenario 7: inferAndPersistSpeakerInterpretations does NOT overwrite human confirmed interpretations", async () => {
    const meetingId = "m1111111-1111-1111-1111-111111111111";
    const orgId = "o1111111-1111-1111-1111-111111111111";

    const mockMeeting = {
      id: meetingId,
      organization_id: orgId,
      owner_membership_id: "owner-123",
      customer_id: "cust-456",
      organizer_email: "rama@applywizz.com",
    };

    const mockOwner = {
      display_name: "Rama Chandra",
      work_email: "rama@applywizz.com",
    };

    const mockCustomer = {
      name: "Kartik Patel",
      email: "kartik@example.com",
    };

    const mockTranscript = {
      id: "t1111111-1111-1111-1111-111111111111",
    };

    const mockSegments = [
      {
        speaker_label: "Speaker 0",
        original_text: "Hi Kartik, this is Rama from Apply Wizz.",
        canonical_english_text: null,
        start_ms: 0,
        end_ms: 3000,
        sequence_index: 0,
      },
      {
        speaker_label: "Speaker 1",
        original_text: "Hey Rama, Kartik here.",
        canonical_english_text: null,
        start_ms: 3100,
        end_ms: 5000,
        sequence_index: 1,
      },
    ];

    // Existing rows: Speaker 1 was previously confirmed by human as OTHER
    const mockExisting = [
      {
        id: "interp-1",
        raw_speaker_tag: "Speaker 1",
        confirmed_by_human: true,
        business_role: "OTHER",
        interpreted_name: "Special Advisor",
      },
    ];

    const updatedRows: Record<string, unknown>[] = [];
    const insertedRows: Record<string, unknown>[] = [];

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "meetings") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: mockMeeting, error: null }),
          };
        }
        if (table === "organization_memberships") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockOwner, error: null }),
          };
        }
        if (table === "customers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockCustomer, error: null }),
          };
        }
        if (table === "meeting_attendees") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === "meeting_transcripts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockTranscript, error: null }),
          };
        }
        if (table === "transcript_segments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: mockSegments, error: null }),
          };
        }
        if (table === "meeting_speaker_interpretations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: mockExisting, error: null }),
              }),
            }),
            update: vi.fn((payload: Record<string, unknown>) => {
              updatedRows.push(payload);
              return { eq: vi.fn().mockResolvedValue({ error: null }) };
            }),
            insert: vi.fn((payload: Record<string, unknown>) => {
              insertedRows.push(payload);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    } as unknown as AppSupabaseClient;

    await inferAndPersistSpeakerInterpretations(mockClient, meetingId, orgId);

    // Speaker 0 (unconfirmed) was inserted
    expect(insertedRows.some((r) => r["raw_speaker_tag"] === "Speaker 0")).toBe(true);

    // Speaker 1 (confirmed_by_human = true) was NOT overwritten in update or insert!
    expect(updatedRows.some((r) => r["raw_speaker_tag"] === "Speaker 1")).toBe(false);
    expect(insertedRows.some((r) => r["raw_speaker_tag"] === "Speaker 1")).toBe(false);
  });

  it("Scenario 8: correctSpeakerInterpretation updates interpretation additively and emits audit event", async () => {
    const interpretationId = "interp-999";
    const orgId = "org-999";
    const actorId = "membership-am-1";

    const mockExisting = {
      id: interpretationId,
      meeting_id: "m-999",
      raw_speaker_tag: "Speaker 1",
      business_role: "UNKNOWN",
      interpreted_name: null,
      confirmed_by_human: false,
    };

    let updatedPayload: Record<string, unknown> | null = null;
    let auditPayload: Record<string, unknown> | null = null;

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "meeting_speaker_interpretations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: mockExisting, error: null }),
            update: vi.fn((payload: Record<string, unknown>) => {
              updatedPayload = payload;
              return {
                eq: vi.fn().mockReturnThis(),
                then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
              };
            }),
          };
        }
        if (table === "audit_events") {
          return {
            insert: vi.fn((payload: Record<string, unknown>) => {
              auditPayload = payload;
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    } as unknown as AppSupabaseClient;

    await correctSpeakerInterpretation(mockClient, {
      interpretationId,
      organizationId: orgId,
      actorMembershipId: actorId,
      businessRole: "CANDIDATE",
      interpretedName: "Kartik Patel (Verified)",
      reason: "Direct confirmation by AM",
    });

    expect(updatedPayload?.["business_role"]).toBe("CANDIDATE");
    expect(updatedPayload?.["interpreted_name"]).toBe("Kartik Patel (Verified)");
    expect(updatedPayload?.["confirmed_by_human"]).toBe(true);
    expect(updatedPayload?.["confirmed_by_membership_id"]).toBe(actorId);
    expect(updatedPayload?.["interpretation_source"]).toBe("human_correction");
    expect(updatedPayload?.["interpretation_confidence"]).toBe(1.0);

    expect(auditPayload?.["action"]).toBe("speaker_interpretation.corrected");
    expect(auditPayload?.["entity_type"]).toBe("meeting_speaker_interpretation");
    expect(auditPayload?.["actor_id"]).toBe(actorId);
    const meta = auditPayload?.["metadata"] as Record<string, unknown>;
    expect(meta?.previousRole).toBe("UNKNOWN");
    expect(meta?.newRole).toBe("CANDIDATE");
    expect(meta?.newName).toBe("Kartik Patel (Verified)");
  });
});
