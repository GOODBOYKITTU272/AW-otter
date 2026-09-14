import { redirect } from "next/navigation";

/**
 * Legacy admin Meeting Detail (pre-Fathom tabs) permanently redirects to the
 * shared tabbed Meeting Detail at /meetings/[id]. Admin list/overview links
 * historically pointed here; keep the route so bookmarks and old emails work.
 */
export default async function AdminMeetingDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/meetings/${id}`);
}
