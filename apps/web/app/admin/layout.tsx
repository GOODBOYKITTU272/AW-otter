import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const membership = await requireRole(["admin"]);

  return (
    <div className="flex flex-1 bg-[#0B1D33]">
      <AdminSidebar />
      <div className="flex flex-1 flex-col bg-[#F5F5F5] min-h-screen">
        <header className="flex items-center justify-end gap-4 border-b border-zinc-200 bg-white px-8 py-3">
          <span className="text-sm text-zinc-700">
            {membership.displayName} <span className="text-zinc-500">· Admin</span>
          </span>
          <SignOutButton />
        </header>
        {children}
      </div>
    </div>
  );
}
