import Link from "next/link";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

/**
 * Shared Meeting Detail lives at /meetings/[id] (outside /admin) so AM/Manager
 * can open it too. For Admin, wrap with the ops-dark sidebar + light #F5F5F5
 * content shell so Overview matches Apply Wizz brand (same as /admin/*).
 */
export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const membership = await requireRole([
    "account_manager",
    "manager",
    "senior_manager",
    "admin",
  ]);

  if (membership.roleKey === "admin") {
    return (
      <div className="flex flex-1 bg-[#0B1D33]">
        <AdminSidebar />
        <div className="flex flex-1 flex-col bg-[#F5F5F5] min-h-screen min-w-0 w-full overflow-x-hidden">
          <header className="sticky top-0 z-30 flex items-center justify-between lg:justify-end gap-2 sm:gap-4 border-b border-zinc-200 bg-white px-4 pl-16 lg:pl-8 sm:px-8 py-3.5 shadow-sm min-w-0">
            <span className="text-xs sm:text-sm text-zinc-700 truncate">
              {membership.displayName}{" "}
              <span className="text-zinc-500">· Admin</span>
            </span>
            <SignOutButton />
          </header>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-[#F5F5F5] min-h-screen min-w-0 w-full overflow-x-hidden">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 sm:gap-4 border-b border-zinc-200 bg-white px-4 sm:px-8 py-3.5 shadow-sm min-w-0">
        <Link
          href="/meetings"
          className="text-xs sm:text-sm font-medium text-[#2C76FF] hover:underline flex items-center gap-1.5"
        >
          &larr; Back to meetings
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs sm:text-sm text-zinc-700 truncate">
            {membership.displayName}
          </span>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
