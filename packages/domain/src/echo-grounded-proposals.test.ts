import { describe, it, expect } from "vitest";
import {
  extractGroundedFactProposalsFromEvidence,
} from "./echo-trust";
import { answerCustomerQuestion } from "./ask-signal";
import { fakeLiveSupabase } from "./echo-test-helpers";
import type { AskSignalProvider } from "@applywizz/ai";

describe("Echo Grounded Proposal Regression Tests", () => {
  it("extracts arbitrary location 'Boston' without Boston hardcoded anywhere", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-boston",
        meetingId: "meet-1",
        text: "I can relocate to Boston.",
        speakerRole: "CANDIDATE",
        speakerName: "David Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Willing to relocate to Boston");
    expect(proposals[0]?.isTentative).toBe(false);
    expect(proposals[0]?.groundingStatus).toBe("supported");
  });

  it("extracts arbitrary location 'Hyderabad' without Hyderabad hardcoded anywhere and preserves tentative uncertainty", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-hyderabad",
        meetingId: "meet-1",
        text: "I might relocate to Hyderabad.",
        speakerRole: "CANDIDATE",
        speakerName: "Sunil Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Open to Hyderabad (Conditional)");
    expect(proposals[0]?.isTentative).toBe(true);
    expect(proposals[0]?.groundingStatus).toBe("partially_supported");
  });

  it("preserves both alternatives for 'Dallas or Houston' rather than picking one", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-dallas-houston",
        meetingId: "meet-1",
        text: "I’m open to Dallas or Houston.",
        speakerRole: "CANDIDATE",
        speakerName: "Maria Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Open to Dallas or Houston");
    expect(proposals[0]?.proposedValue).toContain("Dallas");
    expect(proposals[0]?.proposedValue).toContain("Houston");
  });

  it("'Bay Area only' constraint is preserved", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-bay-area",
        meetingId: "meet-1",
        text: "Bay Area only.",
        speakerRole: "CANDIDATE",
        speakerName: "Ken Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Open to Bay Area only");
  });

  it("'Anywhere in the Northeast' regional preference is extracted", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-northeast",
        meetingId: "meet-1",
        text: "I can move to Anywhere in the Northeast.",
        speakerRole: "CANDIDATE",
        speakerName: "Sarah Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Willing to relocate: Anywhere in the Northeast");
  });

  it("'Anywhere except California' NEVER creates affirmative California proposal", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-except-ca",
        meetingId: "meet-1",
        text: "Anywhere except California.",
        speakerRole: "CANDIDATE",
        speakerName: "Alex Candidate",
      },
    ]);

    // Negative exclusion: must not create an unsafe affirmative proposal
    expect(proposals).toHaveLength(0);
  });

  it("'cannot relocate' produces NO affirmative relocation proposal", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-refusal",
        meetingId: "meet-1",
        text: "I cannot relocate due to family obligations. I can only work locally or remote.",
        speakerRole: "CANDIDATE",
        speakerName: "Bob Candidate",
      },
    ]);

    expect(proposals).toHaveLength(0);
  });

  it("unrelated text with no relocation evidence produces NO proposal", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-intro",
        meetingId: "meet-1",
        text: "Hello, thank you for setting up this call. Here is my resume background.",
        speakerRole: "CANDIDATE",
        speakerName: "Charlie Candidate",
      },
    ]);

    expect(proposals).toHaveLength(0);
  });

  it("UNKNOWN speaker evidence must not become a candidate fact", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-unknown",
        meetingId: "meet-1",
        text: "The candidate can relocate to Boston.",
        speakerRole: "UNKNOWN",
        speakerName: null,
      },
    ]);

    expect(proposals).toHaveLength(0);
  });

  it("failed/ambiguous extraction produces NO unsafe proposal (safety over coverage)", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-ambiguous",
        meetingId: "meet-1",
        text: "We talked about moving the meeting to 3pm tomorrow.",
        speakerRole: "CANDIDATE",
        speakerName: "Lisa Candidate",
      },
    ]);

    expect(proposals).toHaveLength(0);
  });

  it("same fact + same value repeated does not create duplicate proposal (idempotency)", async () => {
    const tables = {
      customers: [
        { id: "cust-1", name: "Jordan Lee", organization_id: "org-1" },
      ],
      meetings: [
        {
          id: "meet-1",
          customer_id: "cust-1",
          title: "Discovery Call",
          scheduled_start: "2026-09-10T14:00:00.000Z",
        },
      ],
      meeting_transcripts: [{ id: "tr-1", meeting_id: "meet-1" }],
      meeting_speaker_interpretations: [
        {
          meeting_id: "meet-1",
          raw_speaker_tag: "Speaker 1",
          business_role: "CANDIDATE",
          interpreted_name: "Jordan Lee",
        },
      ],
      transcript_segments: [
        {
          id: "seg-reloc-1",
          transcript_id: "tr-1",
          start_ms: 15000,
          end_ms: 20000,
          original_text: "I can relocate to Boston.",
          speaker_label: "Speaker 1",
          needs_review: false,
          provider_segment_metadata: {},
        },
      ],
      customer_truth_facts: [],
      call_records: [
        {
          id: "call-rec-1",
          customer_id: "cust-1",
          meeting_id: "meet-1",
          record_type: "action_item",
          description: "Review relocation preferences",
          status: "detected",
          evidence_segment_ids: ["seg-reloc-1"],
        },
      ],
      audit_events: [],
    };

    const { client } = fakeLiveSupabase(tables);

    const provider: AskSignalProvider = {
      name: "test-provider",
      respond: async () => ({
        result: {
          answerability: "answered",
          answer: "The candidate stated they can relocate to Boston.",
          citedEvidence: [{ type: "transcript_segment", id: "seg-reloc-1" }],
          unresolvedAmbiguity: null,
          followUpSuggestions: [],
        },
        model: "mock-model",
        usage: { promptTokens: 10, completionTokens: 10, cost: 0.001 },
      }),
    };

    // First query: creates exactly 1 proposal
    const res1 = await answerCustomerQuestion(
      client,
      provider,
      "cust-1",
      "What did the candidate say about relocation?",
      "user-1",
    );
    expect(res1.proposedFacts).toHaveLength(1);
    const initialFactId = res1.proposedFacts?.[0]?.id;
    expect(initialFactId).toBeDefined();
    expect(tables.customer_truth_facts).toHaveLength(1);

    // Repeated query: reuses the existing proposed fact, does NOT insert duplicate
    const res2 = await answerCustomerQuestion(
      client,
      provider,
      "cust-1",
      "What did the candidate say about relocation?",
      "user-1",
    );
    expect(res2.proposedFacts).toHaveLength(1);
    expect(res2.proposedFacts?.[0]?.id).toBe(initialFactId);
    expect(tables.customer_truth_facts).toHaveLength(1); // Still exactly 1 row!
  });

  it("same field + different value must NOT incorrectly reuse old proposal ID", async () => {
    // Database already has an existing proposal for Boston
    const tables = {
      customers: [
        { id: "cust-1", name: "Jordan Lee", organization_id: "org-1" },
      ],
      meetings: [
        {
          id: "meet-2",
          customer_id: "cust-1",
          title: "Follow-up Call",
          scheduled_start: "2026-09-11T14:00:00.000Z",
        },
      ],
      meeting_transcripts: [{ id: "tr-2", meeting_id: "meet-2" }],
      meeting_speaker_interpretations: [
        {
          meeting_id: "meet-2",
          raw_speaker_tag: "Speaker 1",
          business_role: "CANDIDATE",
          interpreted_name: "Jordan Lee",
        },
      ],
      transcript_segments: [
        {
          id: "seg-reloc-2",
          transcript_id: "tr-2",
          start_ms: 10000,
          end_ms: 15000,
          original_text: "I might relocate to Hyderabad.",
          speaker_label: "Speaker 1",
          needs_review: false,
          provider_segment_metadata: {},
        },
      ],
      customer_truth_facts: [
        {
          id: "fact-existing-boston",
          organization_id: "org-1",
          customer_id: "cust-1",
          field_key: "relocation_pref",
          value: "Willing to relocate to Boston",
          status: "proposed",
          source_type: "meeting",
          source_meeting_id: "meet-1",
          evidence_segment_ids: ["seg-boston-old"],
          source_speaker: "Jordan Lee",
          detected_at: "2026-09-10T15:00:00.000Z",
        },
      ],
      call_records: [
        {
          id: "call-rec-2",
          customer_id: "cust-1",
          meeting_id: "meet-2",
          record_type: "action_item",
          description: "Follow-up relocation discussion",
          status: "detected",
          evidence_segment_ids: ["seg-reloc-2"],
        },
      ],
      audit_events: [],
    };

    const { client } = fakeLiveSupabase(tables);

    const provider: AskSignalProvider = {
      name: "test-provider",
      respond: async () => ({
        result: {
          answerability: "answered",
          answer: "The candidate mentioned they might relocate to Hyderabad.",
          citedEvidence: [{ type: "transcript_segment", id: "seg-reloc-2" }],
          unresolvedAmbiguity: null,
          followUpSuggestions: [],
        },
        model: "mock-model",
        usage: { promptTokens: 10, completionTokens: 10, cost: 0.001 },
      }),
    };

    const res = await answerCustomerQuestion(
      client,
      provider,
      "cust-1",
      "Can the candidate relocate to Hyderabad?",
      "user-1",
    );

    expect(res.proposedFacts).toHaveLength(1);
    const hyderabadProposal = res.proposedFacts?.[0];
    expect(hyderabadProposal?.proposedValue).toBe("Open to Hyderabad (Conditional)");

    // Crucial requirement: Must NOT reuse the Boston proposal ID
    expect(hyderabadProposal?.id).not.toBe("fact-existing-boston");
    expect(tables.customer_truth_facts).toHaveLength(2); // Boston + Hyderabad
  });
});
