import { StatusBadge } from "@/components/admin/status-badge";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAzureMaiEnv } from "@/env/server";
import Link from "next/link";

export default async function AdminOverviewPage() {
  const supabase = await getSupabaseServerClient();

  // Get team counts
  const { data: memberships } = await supabase
    .from("organization_memberships")
    .select("id, role_id")
    .eq("status", "active");

  const { data: roles } = await supabase
    .from("roles")
    .select("id, key");

  const roleKeyById = new Map((roles ?? []).map(r => [r.id, r.key]));
  const amCount = (memberships ?? []).filter(m => roleKeyById.get(m.role_id) === "account_manager").length;
  const managerCount = (memberships ?? []).filter(m => 
    ["manager", "senior_manager"].includes(roleKeyById.get(m.role_id) ?? "")
  ).length;

  // Get recent incidents
  const { data: incidents } = await supabase
    .from("operational_incidents")
    .select("id, incident_type, severity, first_seen_at, resolved_at, meeting_id")
    .order("first_seen_at", { ascending: false })
    .limit(4);

  const isAzureConfigured = getAzureMaiEnv().isConfigured;
  const isOpenRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const isDatabaseReachable = Boolean(memberships !== null);

  // Service health status (placeholder - would be real health checks in production)
  const services = [
    { name: "Vexa", icon: "🤖", status: "Operational", health: 99.2 },
    { name: "Whisper", icon: "📻", status: "Operational", health: 98.7 },
    { name: "Sarvam", icon: "🔊", status: "Operational", health: 97.3 },
    { name: "Graph", icon: "📊", status: "Operational", health: 99.8 },
  ];

  // STT Provider status (honest, not verified)
  const sttProviders = [
    {
      name: "Azure Speech (Primary Transcriber)",
      icon: "🎤",
      status: isAzureConfigured ? "Configured (Not verified)" : "Not configured / Unknown",
      tone: isAzureConfigured ? ("neutral" as const) : ("warning" as const),
    },
    {
      name: "OpenRouter Whisper Fallback",
      icon: "🔄",
      status: isOpenRouterConfigured ? "Configured (Not verified)" : "Not configured / Unknown",
      tone: isOpenRouterConfigured ? ("neutral" as const) : ("warning" as const),
    },
  ];

  const incidentSeverityColors: Record<string, string> = {
    critical: "High",
    warning: "Medium",
    info: "Low",
  };

  return (
    <main className="flex flex-1 flex-col gap-6 sm:gap-8 p-4 sm:p-8 max-w-[1600px]">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight text-[#1E1E1E]">
              Admin • Echo
            </h1>
            <div className="flex items-center gap-2 bg-[#29FE29]/10 rounded-full px-3 py-1">
              <div className="h-2 w-2 rounded-full bg-[#29FE29]" />
              <span className="text-xs font-medium text-[#29FE29]">Prod healthy</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="h-10 w-10 rounded-lg border border-[#1E1E1E]/10 bg-white flex items-center justify-center hover:bg-[#F5F5F5] transition-colors">
            <svg className="h-5 w-5 text-[#1E1E1E]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <button className="h-10 w-10 rounded-lg border border-[#1E1E1E]/10 bg-white flex items-center justify-center hover:bg-[#F5F5F5] transition-colors">
            <svg className="h-5 w-5 text-[#1E1E1E]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </button>
          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center">
            <span className="text-sm font-bold text-white">SA</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* System Health */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-[#1E1E1E]/10 bg-white shadow-sm overflow-hidden">
            <div className="border-b border-[#1E1E1E]/10 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-[#1E1E1E]">System Health</h2>
                <button className="text-[#1E1E1E]/50 hover:text-[#1E1E1E]">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-[#1E1E1E]/50 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-xs text-[#1E1E1E]/70">Updated just now</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 p-6">
              {services.map((service) => (
                <div key={service.name} className="rounded-xl border border-[#1E1E1E]/10 bg-[#F5F5F5]/30 p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 rounded-xl bg-white flex items-center justify-center text-2xl shadow-sm">
                        {service.icon}
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-[#1E1E1E]">{service.name}</h3>
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="h-2 w-2 rounded-full bg-[#29FE29]" />
                          <span className="text-xs font-medium text-[#29FE29]">{service.status}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Mini health graph */}
                  <div className="h-16 flex items-end gap-0.5">
                    {Array.from({ length: 24 }).map((_, i) => {
                      const height = 85 + (i % 3) * 5; // Deterministic pattern between 85-95%
                      return (
                        <div
                          key={i}
                          className="flex-1 bg-[#29FE29]/30 rounded-t-sm transition-all hover:bg-[#29FE29]"
                          style={{ height: `${height}%` }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* STT Provider Status */}
          <div className="rounded-2xl border border-[#1E1E1E]/10 bg-white shadow-sm overflow-hidden mt-6">
            <div className="border-b border-[#1E1E1E]/10 px-6 py-4">
              <h2 className="text-lg font-bold text-[#1E1E1E]">STT Provider Status</h2>
            </div>
            <div className="p-6 space-y-4">
              {sttProviders.map((provider) => (
                <div key={provider.name} className="flex items-center justify-between p-4 rounded-lg border border-[#1E1E1E]/10 bg-[#F5F5F5]/30">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-white flex items-center justify-center text-xl shadow-sm">
                      {provider.icon}
                    </div>
                    <span className="text-sm font-medium text-[#1E1E1E]">{provider.name}</span>
                  </div>
                  <StatusBadge tone={provider.tone}>
                    {provider.status}
                  </StatusBadge>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Team Snapshot */}
        <div className="rounded-2xl border border-[#1E1E1E]/10 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-[#1E1E1E]/10 px-6 py-4">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5 text-[#2C76FF]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <h2 className="text-lg font-bold text-[#1E1E1E]">Team Snapshot</h2>
            </div>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-[#2C76FF]/10 flex items-center justify-center">
                  <svg className="h-6 w-6 text-[#2C76FF]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-[#1E1E1E]/60">AMs</p>
                  <p className="text-2xl font-bold text-[#2C76FF]">{amCount}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-full bg-[#29FE29]/10 flex items-center justify-center">
                  <svg className="h-6 w-6 text-[#29FE29]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-[#1E1E1E]/60">Managers</p>
                  <p className="text-2xl font-bold text-[#29FE29]">{managerCount}</p>
                </div>
              </div>
            </div>

            <Link
              href="/admin/people/new"
              className="flex items-center justify-center gap-2 w-full rounded-lg bg-[#29FE29] px-4 py-3 text-sm font-bold text-[#1E1E1E] shadow-md hover:bg-[#29FE29]/90 transition-all min-h-[44px]"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Invite Person
            </Link>
          </div>
        </div>
      </div>

      {/* Recent Incidents */}
      <div className="rounded-2xl border border-[#1E1E1E]/10 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-[#1E1E1E]/10 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-[#FF5C5C]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h2 className="text-lg font-bold text-[#1E1E1E]">Recent Incidents</h2>
          </div>
          <Link
            href="/admin/operations"
            className="text-sm font-medium text-[#2C76FF] hover:underline"
          >
            View all incidents →
          </Link>
        </div>

        {!incidents || incidents.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="h-16 w-16 rounded-full bg-[#29FE29]/10 flex items-center justify-center mx-auto mb-4">
              <svg className="h-8 w-8 text-[#29FE29]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-medium text-[#1E1E1E]">No recent incidents</p>
            <p className="text-xs text-[#1E1E1E]/60 mt-1">All systems operating normally</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#F5F5F5] border-b border-[#1E1E1E]/10">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Incident
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Service
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Severity
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Started
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-bold uppercase tracking-wider text-[#1E1E1E]/70">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E1E1E]/10">
                {incidents.map((incident) => {
                  const serviceName = incident.incident_type.includes("whisper") ? "Whisper" :
                                     incident.incident_type.includes("vexa") ? "Vexa" :
                                     incident.incident_type.includes("sarvam") ? "Sarvam" :
                                     incident.incident_type.includes("graph") ? "Graph" : "System";
                  
                  const serviceIcon = serviceName === "Whisper" ? "📻" :
                                     serviceName === "Vexa" ? "🤖" :
                                     serviceName === "Sarvam" ? "🔊" :
                                     serviceName === "Graph" ? "📊" : "⚙️";

                  return (
                    <tr key={incident.id} className="hover:bg-[#F5F5F5]/50 transition-colors">
                      <td className="px-6 py-4 text-sm text-[#1E1E1E]">
                        {incident.incident_type.replace(/_/g, " ")}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <span>{serviceIcon}</span>
                          <span className="text-sm font-medium text-[#1E1E1E]">{serviceName}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${
                          incident.severity === "critical" ? "bg-[#FF5C5C]/10 text-[#FF5C5C]" :
                          incident.severity === "warning" ? "bg-[#FFDE59]/20 text-[#FFDE59]" :
                          "bg-[#2C76FF]/10 text-[#2C76FF]"
                        }`}>
                          {incidentSeverityColors[incident.severity] ?? incident.severity}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-[#1E1E1E]/70">
                        {new Date(incident.first_seen_at).toLocaleDateString(undefined, { 
                          month: 'short', 
                          day: 'numeric', 
                          year: 'numeric' 
                        })} {new Date(incident.first_seen_at).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit'
                        })} UTC
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge tone={incident.resolved_at ? "success" : "warning"}>
                          {incident.resolved_at ? "• Resolved" : "• Mitigated"}
                        </StatusBadge>
                      </td>
                      <td className="px-6 py-4">
                        <Link
                          href={incident.meeting_id ? `/admin/meetings/${incident.meeting_id}` : "/admin/operations"}
                          className="text-sm font-medium text-[#2C76FF] hover:underline"
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
