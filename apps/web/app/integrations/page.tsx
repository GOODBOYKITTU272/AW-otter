import { redirect } from "next/navigation";
import { requireRole } from "@/lib/require-role";

export default async function IntegrationsRedirectPage() {
  await requireRole(["admin"]);
  redirect("/admin/integrations");
}
