import { describe, it, expect } from "vitest";
import {
  extractGroundedFactProposalsFromEvidence,
} from "./echo-trust";
import { answerCustomerQuestion } from "./ask-signal";
import { fakeLiveSupabase } from "./echo-live-request.test";
import type { AskSignalProvider } from "@applywizz/ai";

describe("Echo Grounded Proposal Regression Tests", () => {
  it("Texas evidence produces Texas only (never California or hardcoded default)", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-tx",
        meetingId: "meet-1",
        text: "I might relocate to Texas depending on the compensation package.",
        speakerRole: "CANDIDATE",
        speakerName: "Jane Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Open to Texas (Conditional)");
    expect(proposals[0]?.proposedValue).not.toContain("California");
  });

  it("California evidence produces California only (never Texas)", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-ca",
        meetingId: "meet-1",
        text: "I am open to relocate to California for the right opportunity.",
        speakerRole: "CANDIDATE",
        speakerName: "John Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.fieldKey).toBe("relocation_pref");
    expect(proposals[0]?.proposedValue).toBe("Willing to relocate to California");
    expect(proposals[0]?.proposedValue).not.toContain("Texas");
  });

  it("'might relocate' preserves uncertainty and produces tentative (Conditional) proposal, never confirmed/willing", () => {
    const proposals = extractGroundedFactProposalsFromEvidence([
      {
        id: "seg-tentative",
        meetingId: "meet-1",
        text: "I might relocate to Seattle if there is hybrid flexibility.",
        speakerRole: "CANDIDATE",
        speakerName: "Alice Candidate",
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.isTentative).toBe(true);
    expect(proposals[0]?.groundingStatus).toBe("partially_supported");
    expect(proposals[0]?.proposedValue).toBe("Open to Seattle (Conditional)");
    expect(proposals[0]?.proposedValue).not.toContain("Willing to relocate");
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

  it("unrelated question with no relocation evidence produces NO proposal", () => {
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
        text: "The candidate might relocate to Texas.",
        speakerRole: "UNKNOWN",
        speakerName: null,
      },
    ]);

    expect(proposals).toHaveLength(0);
  });

  it("repeated Ask Echo query does not create duplicate proposals (idempotency)", async () => {
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
          original_text: "I might relocate to Texas depending on the compensation package.",
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
          answer: "The candidate mentioned they might relocate to Texas.",
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
});
