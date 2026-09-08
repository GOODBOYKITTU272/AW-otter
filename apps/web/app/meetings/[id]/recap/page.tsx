import { notFound } from "next/navigation";

import { MeetingRecap } from "@/components/recap/meeting-recap";
import { getMeetingRecapFixture } from "@/fixtures/meeting-intelligence/fixtures";

export default async function MeetingRecapPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const recap = getMeetingRecapFixture(id);
  if (!recap) notFound();

  return <MeetingRecap recap={recap} />;
}
