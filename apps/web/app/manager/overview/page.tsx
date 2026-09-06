import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

export default async function ManagerOverviewPage() {
  const membership = await requireRole(["manager", "senior_manager"]);

  return (
    <main className="flex flex-1 flex-col gap-2 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          Manager overview
        </h1>
        <SignOutButton />
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Signed in as {membership.displayName}.
      </p>
      <Link href="/integrations" className="w-fit text-sm underline">
        Integrations
      </Link>
    </main>
  );
}
