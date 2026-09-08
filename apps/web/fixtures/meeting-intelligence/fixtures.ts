// M11: the recap contract now lives in @applywizz/domain (the real
// getMeetingRecapData returns this same shape) — imported here under its
// original fixture names so this module's own literal fixture array and
// any existing imports of it keep working unchanged. See
// packages/domain/src/meeting-recap.ts for the real, backend-wired
// version; this file stays fixture-only (no DB calls), useful for visual
// regression / component tests of MeetingRecap in isolation.
import type {
  MeetingRecapData as MeetingRecapFixture,
  TranscriptSegmentData as TranscriptSegmentFixture,
} from "@applywizz/domain/meeting-recap";
export type { MeetingRecapFixture, TranscriptSegmentFixture };

export const meetingRecapFixtures = [
  {
    id: "discovery",
    customer: {
      name: "Anika Rao",
      lifecycleStage: "Discovery",
      ownerName: "Maya Patel",
    },
    meetingDate: "2026-09-03T15:30:00.000Z",
    nextJourneyStep:
      "Confirm missing compensation and work authorization details before resume intake.",
    transcriptSegments: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        startMs: 28000,
        endMs: 42000,
        speakerLabel: "Customer",
        originalText:
          "I want backend platform roles, ideally Go or Java, and I am open to fintech if the team is not too large.",
        canonicalEnglishText:
          "I want backend platform roles, ideally Go or Java, and I am open to fintech if the team is not too large.",
      },
      {
        id: "11111111-1111-4111-8111-111111111112",
        startMs: 56000,
        endMs: 69000,
        speakerLabel: "Customer",
        originalText:
          "The onboarding form says remote only, but I can do hybrid in New York twice a week.",
        canonicalEnglishText:
          "The onboarding form says remote only, but I can do hybrid in New York twice a week.",
      },
      {
        id: "11111111-1111-4111-8111-111111111113",
        startMs: 91000,
        endMs: 106000,
        speakerLabel: "AM",
        originalText:
          "I still need your compensation range and visa status before the resume team starts positioning.",
        canonicalEnglishText:
          "I still need your compensation range and visa status before the resume team starts positioning.",
      },
      {
        id: "11111111-1111-4111-8111-111111111114",
        startMs: 122000,
        endMs: 138000,
        speakerLabel: "Customer",
        originalText:
          "I can send those by Friday, and please avoid early-stage startups for now.",
        canonicalEnglishText:
          "I can send those by Friday, and please avoid early-stage startups for now.",
      },
    ],
    result: {
      summary:
        "Anika is targeting backend platform roles with a preference for Go or Java. She corrected her location preference to allow hybrid New York roles and still needs to provide compensation and work authorization details before resume positioning starts.",
      callRecords: [
        {
          recordType: "action_item",
          description:
            "Collect compensation range and work authorization status.",
          ownerType: "am",
          ownerRef: "Maya Patel",
          dueAt: "2026-09-04T17:00:00.000Z",
          evidenceSegmentIds: ["11111111-1111-4111-8111-111111111113"],
        },
        {
          recordType: "commitment",
          description: "Customer will send missing intake details by Friday.",
          ownerType: "customer",
          ownerRef: "Anika Rao",
          dueAt: "2026-09-04T23:59:00.000Z",
          evidenceSegmentIds: ["11111111-1111-4111-8111-111111111114"],
        },
        {
          recordType: "blocker",
          description:
            "Resume positioning cannot start until compensation and work authorization are known.",
          ownerType: "customer",
          ownerRef: "Anika Rao",
          dueAt: null,
          evidenceSegmentIds: ["11111111-1111-4111-8111-111111111113"],
        },
      ],
      customerTruthDeltas: [
        {
          fieldKey: "target_roles",
          previousValue: null,
          proposedValue: ["Backend platform engineer", "Go backend engineer"],
          confidence: 0.92,
          evidenceSegmentIds: ["11111111-1111-4111-8111-111111111111"],
        },
        {
          fieldKey: "work_mode",
          previousValue: "remote only",
          proposedValue: "hybrid in New York up to twice weekly",
          confidence: 0.95,
          evidenceSegmentIds: ["11111111-1111-4111-8111-111111111112"],
        },
        {
          fieldKey: "company_preferences",
          previousValue: null,
          proposedValue: {
            avoid: ["early-stage startups"],
            openTo: ["fintech"],
          },
          confidence: 0.86,
          evidenceSegmentIds: [
            "11111111-1111-4111-8111-111111111111",
            "11111111-1111-4111-8111-111111111114",
          ],
        },
      ],
      callTypeSpecific: {
        callType: "discovery",
        onboardingCompleteness: {
          complete: false,
          missingFields: ["compensation", "work_authorization"],
        },
        goals: [
          {
            text: "Find backend platform roles using Go or Java.",
            evidenceSegmentIds: ["11111111-1111-4111-8111-111111111111"],
          },
        ],
        constraints: [
          {
            text: "Avoid early-stage startups for now.",
            evidenceSegmentIds: ["11111111-1111-4111-8111-111111111114"],
          },
        ],
        contradictionsWithOnboarding: [
          {
            fieldKey: "work_mode",
            onboardingValue: "remote only",
            statedValue: "hybrid in New York twice a week",
            evidenceSegmentIds: ["11111111-1111-4111-8111-111111111112"],
          },
        ],
        newInformation: [
          {
            text: "Customer is open to fintech roles if the team is not too large.",
            evidenceSegmentIds: ["11111111-1111-4111-8111-111111111111"],
          },
        ],
        resumeTeamNeeds: [
          {
            text: "Resume team needs compensation range and visa status before positioning.",
            evidenceSegmentIds: ["11111111-1111-4111-8111-111111111113"],
          },
        ],
      },
    },
  },
  {
    id: "resume-review",
    customer: {
      name: "Marcus Chen",
      lifecycleStage: "Resume Review",
      ownerName: "Elena Park",
    },
    meetingDate: "2026-09-04T18:00:00.000Z",
    nextJourneyStep:
      "Resume team to update leadership bullets and return a revised draft for approval.",
    transcriptSegments: [
      {
        id: "22222222-2222-4222-8222-222222222221",
        startMs: 18000,
        endMs: 34000,
        speakerLabel: "Customer",
        originalText:
          "The architecture section is good, but the resume makes it sound like I managed five people, and I only mentored them.",
        canonicalEnglishText:
          "The architecture section is good, but the resume makes it sound like I managed five people, and I only mentored them.",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        startMs: 47000,
        endMs: 63000,
        speakerLabel: "Customer",
        originalText:
          "Please keep the distributed systems project and remove the React dashboard from the top summary.",
        canonicalEnglishText:
          "Please keep the distributed systems project and remove the React dashboard from the top summary.",
      },
      {
        id: "22222222-2222-4222-8222-222222222223",
        startMs: 76000,
        endMs: 94000,
        speakerLabel: "AM",
        originalText:
          "I will ask the resume team to soften the management language today and send you a revised draft tomorrow.",
        canonicalEnglishText:
          "I will ask the resume team to soften the management language today and send you a revised draft tomorrow.",
      },
      {
        id: "22222222-2222-4222-8222-222222222224",
        startMs: 112000,
        endMs: 126000,
        speakerLabel: "Customer",
        originalText:
          "After that change I can approve it. I do not want frontend-heavy roles.",
        canonicalEnglishText:
          "After that change I can approve it. I do not want frontend-heavy roles.",
      },
    ],
    result: {
      summary:
        "Marcus accepted the architecture framing but requested resume edits that remove overstated people-management language and de-emphasize frontend work. Approval is pending one revised draft from the resume team.",
      callRecords: [
        {
          recordType: "action_item",
          description:
            "Revise resume to clarify mentorship instead of people management.",
          ownerType: "resume_team",
          ownerRef: "Resume Team",
          dueAt: "2026-09-05T17:00:00.000Z",
          evidenceSegmentIds: [
            "22222222-2222-4222-8222-222222222221",
            "22222222-2222-4222-8222-222222222223",
          ],
        },
        {
          recordType: "commitment",
          description: "AM will send Marcus the revised draft tomorrow.",
          ownerType: "am",
          ownerRef: "Elena Park",
          dueAt: "2026-09-05T17:00:00.000Z",
          evidenceSegmentIds: ["22222222-2222-4222-8222-222222222223"],
        },
        {
          recordType: "question",
          description:
            "Confirm approval once the revised management-language edit is complete.",
          ownerType: "customer",
          ownerRef: "Marcus Chen",
          dueAt: null,
          evidenceSegmentIds: ["22222222-2222-4222-8222-222222222224"],
        },
      ],
      customerTruthDeltas: [
        {
          fieldKey: "resume_positioning",
          previousValue: "Engineering manager / technical lead",
          proposedValue: "Senior backend engineer with mentorship experience",
          confidence: 0.93,
          evidenceSegmentIds: ["22222222-2222-4222-8222-222222222221"],
        },
        {
          fieldKey: "roles_to_avoid",
          previousValue: null,
          proposedValue: ["frontend-heavy roles"],
          confidence: 0.91,
          evidenceSegmentIds: ["22222222-2222-4222-8222-222222222224"],
        },
      ],
      callTypeSpecific: {
        callType: "resume_review",
        resumeChangesRequested: [
          {
            text: "Soften people-management wording to reflect mentorship.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222221"],
          },
          {
            text: "Remove the React dashboard from the top summary.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222222"],
          },
        ],
        resumeChangesAccepted: [
          {
            text: "Keep the architecture and distributed systems positioning.",
            evidenceSegmentIds: [
              "22222222-2222-4222-8222-222222222221",
              "22222222-2222-4222-8222-222222222222",
            ],
          },
        ],
        resumeChangesRejected: [
          {
            text: "Customer rejected frontend-heavy positioning.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222224"],
          },
        ],
        positioningChanges: [
          {
            text: "Position as senior backend engineer rather than manager.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222221"],
          },
        ],
        skillCorrections: [
          {
            text: "Frontend dashboard work should not lead the skills summary.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222222"],
          },
        ],
        roleTargetingChanges: [
          {
            text: "Avoid frontend-heavy roles.",
            evidenceSegmentIds: ["22222222-2222-4222-8222-222222222224"],
          },
        ],
        approvalState: "changes_requested",
      },
    },
  },
  {
    id: "renewal",
    customer: {
      name: "Priya Nair",
      lifecycleStage: "Renewal",
      ownerName: "Jordan Lee",
    },
    meetingDate: "2026-09-05T20:00:00.000Z",
    nextJourneyStep:
      "Send a revised month-two strategy focused on healthcare PM roles and response quality.",
    transcriptSegments: [
      {
        id: "33333333-3333-4333-8333-333333333331",
        startMs: 24000,
        endMs: 39000,
        speakerLabel: "Customer",
        originalText:
          "The first month got me two recruiter screens, which is more than I had before ApplyWizz.",
        canonicalEnglishText:
          "The first month got me two recruiter screens, which is more than I had before ApplyWizz.",
      },
      {
        id: "33333333-3333-4333-8333-333333333332",
        startMs: 51000,
        endMs: 68000,
        speakerLabel: "Customer",
        originalText:
          "I am worried the applications are too broad. I only want healthcare product roles now.",
        canonicalEnglishText:
          "I am worried the applications are too broad. I only want healthcare product roles now.",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        startMs: 82000,
        endMs: 99000,
        speakerLabel: "AM",
        originalText:
          "We can narrow the strategy and send you a revised target list by Monday.",
        canonicalEnglishText:
          "We can narrow the strategy and send you a revised target list by Monday.",
      },
      {
        id: "33333333-3333-4333-8333-333333333334",
        startMs: 113000,
        endMs: 132000,
        speakerLabel: "Customer",
        originalText:
          "I am not ready to renew today, but if the next list is sharper I will decide next week.",
        canonicalEnglishText:
          "I am not ready to renew today, but if the next list is sharper I will decide next week.",
      },
    ],
    result: {
      summary:
        "Priya saw value from two recruiter screens but is undecided on renewal because application targeting feels too broad. The next step is a sharper healthcare product strategy and target list before her decision next week.",
      callRecords: [
        {
          recordType: "action_item",
          description:
            "Prepare a revised target list focused on healthcare product roles.",
          ownerType: "am",
          ownerRef: "Jordan Lee",
          dueAt: "2026-09-07T17:00:00.000Z",
          evidenceSegmentIds: [
            "33333333-3333-4333-8333-333333333332",
            "33333333-3333-4333-8333-333333333333",
          ],
        },
        {
          recordType: "commitment",
          description: "ApplyWizz will send a revised target list by Monday.",
          ownerType: "applywizz",
          ownerRef: "Jordan Lee",
          dueAt: "2026-09-07T17:00:00.000Z",
          evidenceSegmentIds: ["33333333-3333-4333-8333-333333333333"],
        },
        {
          recordType: "blocker",
          description:
            "Renewal decision is blocked until customer reviews sharper targeting.",
          ownerType: "customer",
          ownerRef: "Priya Nair",
          dueAt: "2026-09-11T17:00:00.000Z",
          evidenceSegmentIds: ["33333333-3333-4333-8333-333333333334"],
        },
      ],
      customerTruthDeltas: [
        {
          fieldKey: "target_roles",
          previousValue: ["Product manager", "Growth PM"],
          proposedValue: ["Healthcare product manager"],
          confidence: 0.96,
          evidenceSegmentIds: ["33333333-3333-4333-8333-333333333332"],
        },
        {
          fieldKey: "current_concerns",
          previousValue: null,
          proposedValue: ["Applications feel too broad"],
          confidence: 0.9,
          evidenceSegmentIds: ["33333333-3333-4333-8333-333333333332"],
        },
      ],
      callTypeSpecific: {
        callType: "renewal",
        valueDelivered: [
          {
            text: "First month produced two recruiter screens.",
            evidenceSegmentIds: ["33333333-3333-4333-8333-333333333331"],
          },
        ],
        unresolvedProblems: [
          {
            text: "Customer believes applications are too broad.",
            evidenceSegmentIds: ["33333333-3333-4333-8333-333333333332"],
          },
        ],
        objections: [
          {
            text: "Customer is not ready to renew during this meeting.",
            evidenceSegmentIds: ["33333333-3333-4333-8333-333333333334"],
          },
        ],
        churnRiskEvidence: [
          {
            text: "Renewal depends on whether the next target list is sharper.",
            evidenceSegmentIds: ["33333333-3333-4333-8333-333333333334"],
          },
        ],
        renewalDecision: "undecided",
        nextMonthStrategy: [
          {
            text: "Narrow applications to healthcare product roles.",
            evidenceSegmentIds: [
              "33333333-3333-4333-8333-333333333332",
              "33333333-3333-4333-8333-333333333333",
            ],
          },
        ],
      },
    },
  },
] satisfies MeetingRecapFixture[];

export function getMeetingRecapFixture(id: string) {
  return meetingRecapFixtures.find((fixture) => fixture.id === id) ?? null;
}
