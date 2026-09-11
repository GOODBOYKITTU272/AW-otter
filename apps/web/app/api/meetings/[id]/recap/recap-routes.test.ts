import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("@applywizz/auth", () => ({
  getCurrentMembership: vi.fn(),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));

vi.mock("@applywizz/domain/meeting-recap", () => ({
  saveMeetingRecapDraft: vi.fn(),
  approveMeetingRecap: vi.fn(),
}));

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@applywizz/auth";
import { saveMeetingRecapDraft, approveMeetingRecap } from "@applywizz/domain/meeting-recap";
import { POST as handleDraft } from "./draft/route";
import { POST as handleApprove } from "./approve/route";

describe("Recap API Routes Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const meetingId = "meeting-123";
  const ownerMembershipId = "am-owner-1";
  const managerMembershipId = "manager-1";

  function createMockSupabase(meetingData: { id: string; owner_membership_id: string } | null) {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: meetingData,
              error: meetingData ? null : new Error("Not found"),
            }),
          }),
        }),
      }),
    };
  }

  describe("POST /api/meetings/[id]/recap/draft", () => {
    it("allows the responsible Account Manager to save draft", async () => {
      const mockSupabase = createMockSupabase({
        id: meetingId,
        owner_membership_id: ownerMembershipId,
      });
      vi.mocked(getSupabaseServerClient).mockResolvedValue(
        mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
      );
      vi.mocked(getCurrentMembership).mockResolvedValue({
        membershipId: ownerMembershipId,
        roleKey: "account_manager",
        userId: "user-1",
        organizationId: "org-1",
        roleId: "role-1",
        displayName: "AM Owner",
      });
      vi.mocked(saveMeetingRecapDraft).mockResolvedValue({
        recapId: "recap-1",
        status: "draft",
        revisionNumber: 1,
        greeting: "Hello",
        whatWeAgreed: ["agree"],
        applyWizzWillDo: ["will do"],
        candidateShouldDo: ["should do"],
        nextStep: "step",
      });

      const request = new Request(`http://localhost/api/meetings/${meetingId}/recap/draft`, {
        method: "POST",
        body: JSON.stringify({
          greeting: "Hello",
          whatWeAgreed: ["agree"],
          applyWizzWillDo: ["will do"],
          candidateShouldDo: ["should do"],
          nextStep: "step",
        }),
      });

      const response = await handleDraft(request, { params: Promise.resolve({ id: meetingId }) });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.recap.status).toBe("draft");
      expect(saveMeetingRecapDraft).toHaveBeenCalledWith(
        mockSupabase,
        expect.objectContaining({
          meetingId,
          actorMembershipId: ownerMembershipId,
          whatWeAgreed: ["agree"],
          applyWizzWillDo: ["will do"],
          candidateShouldDo: ["should do"],
        })
      );
    });

    it("rejects Manager with 403 Forbidden even if manager has org/hierarchy visibility", async () => {
      const mockSupabase = createMockSupabase({
        id: meetingId,
        owner_membership_id: ownerMembershipId,
      });
      vi.mocked(getSupabaseServerClient).mockResolvedValue(
        mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
      );
      vi.mocked(getCurrentMembership).mockResolvedValue({
        membershipId: managerMembershipId,
        roleKey: "manager",
        userId: "user-mgr",
        organizationId: "org-1",
        roleId: "role-2",
        displayName: "Reporting Manager",
      });

      const request = new Request(`http://localhost/api/meetings/${meetingId}/recap/draft`, {
        method: "POST",
        body: JSON.stringify({ greeting: "Manager hijack" }),
      });

      const response = await handleDraft(request, { params: Promise.resolve({ id: meetingId }) });
      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error).toContain("responsible Account Manager");
      expect(saveMeetingRecapDraft).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/meetings/[id]/recap/approve", () => {
    it("allows the responsible Account Manager to approve recap", async () => {
      const mockSupabase = createMockSupabase({
        id: meetingId,
        owner_membership_id: ownerMembershipId,
      });
      vi.mocked(getSupabaseServerClient).mockResolvedValue(
        mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
      );
      vi.mocked(getCurrentMembership).mockResolvedValue({
        membershipId: ownerMembershipId,
        roleKey: "account_manager",
        userId: "user-1",
        organizationId: "org-1",
        roleId: "role-1",
        displayName: "AM Owner",
      });
      vi.mocked(approveMeetingRecap).mockResolvedValue({
        recapId: "recap-1",
        status: "approved",
        approvedAt: "2026-09-10T12:00:00Z",
        approvedByMembershipId: ownerMembershipId,
        revisionNumber: 2,
        greeting: "Hello",
        whatWeAgreed: ["agree"],
        applyWizzWillDo: ["will do"],
        candidateShouldDo: ["should do"],
        nextStep: "step",
      });

      const request = new Request(`http://localhost/api/meetings/${meetingId}/recap/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      const response = await handleApprove(request, { params: Promise.resolve({ id: meetingId }) });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.recap.status).toBe("approved");
      expect(approveMeetingRecap).toHaveBeenCalledWith(
        mockSupabase,
        expect.objectContaining({
          meetingId,
          actorMembershipId: ownerMembershipId,
        })
      );
    });

    it("rejects Manager with 403 Forbidden on approve", async () => {
      const mockSupabase = createMockSupabase({
        id: meetingId,
        owner_membership_id: ownerMembershipId,
      });
      vi.mocked(getSupabaseServerClient).mockResolvedValue(
        mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
      );
      vi.mocked(getCurrentMembership).mockResolvedValue({
        membershipId: managerMembershipId,
        roleKey: "manager",
        userId: "user-mgr",
        organizationId: "org-1",
        roleId: "role-2",
        displayName: "Reporting Manager",
      });

      const request = new Request(`http://localhost/api/meetings/${meetingId}/recap/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      const response = await handleApprove(request, { params: Promise.resolve({ id: meetingId }) });
      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error).toContain("responsible Account Manager");
      expect(approveMeetingRecap).not.toHaveBeenCalled();
    });

    it("returns 404 when meeting is not found or not accessible", async () => {
      const mockSupabase = createMockSupabase(null);
      vi.mocked(getSupabaseServerClient).mockResolvedValue(
        mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
      );
      vi.mocked(getCurrentMembership).mockResolvedValue({
        membershipId: ownerMembershipId,
        roleKey: "account_manager",
        userId: "user-1",
        organizationId: "org-1",
        roleId: "role-1",
        displayName: "AM",
      });

      const request = new Request(`http://localhost/api/meetings/${meetingId}/recap/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      const response = await handleApprove(request, { params: Promise.resolve({ id: meetingId }) });
      expect(response.status).toBe(404);
    });
  });
});
