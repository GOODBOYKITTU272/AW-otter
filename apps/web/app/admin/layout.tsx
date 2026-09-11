import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const membership = await requireRole(["admin"]);

  return (
    <div className="flex flex-1 bg-[#0B1D33]">
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b border-[#F5F5F5]/10 bg-[#1E1E1E] px-8 py-3">
          <span className="text-sm text-[#F5F5F5]/90">
            {membership.displayName} <span className="text-[#F5F5F5]/50">· Admin</span>
          </span>
          <SignOutButton />
        </header>
        {children}
      </div>
    </div>
  );
}
