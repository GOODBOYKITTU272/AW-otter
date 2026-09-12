import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@applywizz/auth";
import { CustomerTruthReviewQueue } from "@/components/admin/customer-truth-review-queue";

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function AdminCustomerTruthPage() {
  await requireRole(["admin", "account_manager"]);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);

  const { data: facts, error: factsError } = await supabase
    .from("customer_truth_facts")
    .select("id, customer_id, field_key, value, status, detected_at, evidence_segment_ids")
    .eq("status", "proposed")
    .order("detected_at", { ascending: false });
  if (factsError) throw factsError;

  const customerIds = Array.from(new Set((facts ?? []).map((f) => f.customer_id)));
  const { data: customers, error: customersError } = await supabase
    .from("customers")
    .select("id, name")
    .in("id", customerIds);
  if (customersError) throw customersError;

  const customersById = new Map((customers ?? []).map((c) => [c.id, c]));

  const allEvidenceIds = Array.from(
    new Set((facts ?? []).flatMap((f) => f.evidence_segment_ids ?? [])),
  );
  let segmentsById = new Map<string, { speaker_label: string | null }>();
  if (allEvidenceIds.length > 0) {
    const { data: segments, error: segmentsError } = await supabase
      .from("transcript_segments")
      .select("id, speaker_label")
      .in("id", allEvidenceIds);
    if (segmentsError) throw segmentsError;
    segmentsById = new Map((segments ?? []).map((s) => [s.id, s]));
  }

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E]">Customer Truth Review</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Proposed customer facts detected from meeting intelligence. Review and confirm to update
          customer records.
        </p>
      </div>

      <CustomerTruthReviewQueue
        facts={(facts ?? []).map((f) => ({
          id: f.id,
          customerId: f.customer_id,
          customerName: customersById.get(f.customer_id)?.name ?? "Unknown Customer",
          fieldKey: f.field_key,
          value: f.value,
          detectedAt: f.detected_at,
          evidenceCount: (f.evidence_segment_ids ?? []).length,
          speakers: Array.from(
            new Set(
              (f.evidence_segment_ids ?? [])
                .map((id) => segmentsById.get(id)?.speaker_label)
                .filter((s): s is string => Boolean(s)),
            ),
          ),
        }))}
      />
    </main>
  );
}
