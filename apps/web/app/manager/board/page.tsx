import Link from "next/link";
import { RoleShell } from "@/components/role-shell";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getManagerLiveAlerts } from "@applywizz/domain";

/**
 * Manager AM Board - Real-time overview of all Account Managers with scalable metrics
 * Shows: Status, Meetings Today, Calls Today, No-Shows, Lobby Wait Times, Last Activity
 * Plus Alert Inbox on the side
 */
export default async function ManagerBoardPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();
  const isSenior = membership.roleKey === "senior_manager";

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  // Get all AMs reporting to this manager
  const { data: ams, error: amsError } = await supabase
    .from("organization_memberships")
    .select("id, display_name, work_email, status")
    .eq("manager_membership_id", membership.membershipId)
    .order("display_name");

  if (amsError) throw amsError;

  // Get today's meetings for each AM
  const amIds = (ams ?? []).map(am => am.id);
  const { data: todayMeetings } = await supabase
    .from("meetings")
    .select("id, owner_membership_id, scheduled_start, lifecycle_status")
    .in("owner_membership_id", amIds)
    .gte("scheduled_start", todayStart.toISOString())
    .lte("scheduled_start", todayEnd.toISOString());

  // Get bot jobs for lobby metrics
  const meetingIds = (todayMeetings ?? []).map(m => m.id);
  const { data: botJobs } = await supabase
    .from("meeting_bot_jobs")
    .select("id, meeting_id, status, lobby_waiting_since")
    .in("meeting_id", meetingIds);

  // Get no-show data (meetings where customer didn't attend)
  const { data: noShows } = await supabase
    .from("meeting_attendees")
    .select("meeting_id, attended, participant_type")
    .in("meeting_id", meetingIds)
    .eq("attended", false)
    .neq("participant_type", "organizer");

  // Get manager's live alerts
  const liveAlerts = await getManagerLiveAlerts(supabase, membership.membershipId);

  // Aggregate metrics per AM
  const amMetrics = (ams ?? []).map(am => {
    const meetings = (todayMeetings ?? []).filter(m => m.owner_membership_id === am.id);
    const meetingIdsForAm = meetings.map(m => m.id);
    
    const bots = (botJobs ?? []).filter(b => meetingIdsForAm.includes(b.meeting_id));
    const noShowsForAm = (noShows ?? []).filter(ns => meetingIdsForAm.includes(ns.meeting_id));
    
    const lobbyCount = bots.filter(b => b.lobby_waiting_since !== null).length;
    const completedCalls = meetings.filter(m => m.lifecycle_status === "completed").length;
    
    // Determine status (placeholder - would need real presence data)
    const status = bots.some(b => b.status === "joined") ? "On call" : 
                   meetings.length > 0 ? "Online" : "Offline";

    // Get last activity from most recent meeting
    const lastActivity = meetings.length > 0 
      ? Math.max(...meetings.map(m => new Date(m.scheduled_start).getTime()))
      : null;

    const teamName = am.work_email.split('@')[0]?.split('.')[0] || "Team";

    return {
      id: am.id,
      name: am.display_name,
      team: teamName,
      status,
      meetingsToday: meetings.length,
      callsToday: completedCalls,
      noShows: noShowsForAm.length,
      lobbyToday: lobbyCount,
      lastActivity: lastActivity ? new Date(lastActivity) : null,
    };
  });

  return (
    <RoleShell role="manager" userName={membership.displayName} roleLabel={isSenior ? "Senior Manager" : "Manager"}>
      <div className="flex h-screen bg-[#0B1D33]">
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Main Board Content */}
        <main className="flex-1 overflow-auto p-4 sm:p-8">
          <div className="max-w-[1400px] mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">AM Board</h1>
                <p className="text-sm text-[#F5F5F5]/60 mt-1">
                  Real-time overview of Account Managers and today&apos;s activity. Scroll to see all.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex items-center gap-2 bg-[#1E1E1E] rounded-lg px-3 py-1.5 border border-[#29FE29]/30 min-h-[44px]">
                  <div className="h-2 w-2 rounded-full bg-[#29FE29] animate-pulse" />
                  <span className="text-sm font-medium text-white">Auto-refresh: On</span>
                </div>
                <button className="rounded-lg bg-[#1E1E1E] border border-[#F5F5F5]/10 px-4 py-2 text-sm font-medium text-white hover:bg-[#F5F5F5]/5 transition-colors min-h-[44px]">
                  Export Board
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-6">
              <select className="rounded-lg border border-[#F5F5F5]/10 bg-[#1E1E1E] px-4 py-2 text-sm font-medium text-white min-h-[44px]">
                <option>All Teams</option>
                <option>UK Team</option>
                <option>US East Team</option>
                <option>APAC Team</option>
              </select>
              <select className="rounded-lg border border-[#F5F5F5]/10 bg-[#1E1E1E] px-4 py-2 text-sm font-medium text-white min-h-[44px]">
                <option>All Status</option>
                <option>Online</option>
                <option>On call</option>
                <option>Offline</option>
              </select>
              <button className="rounded-lg border border-[#F5F5F5]/10 bg-[#1E1E1E] px-4 py-2 text-sm font-medium text-[#2C76FF] hover:bg-[#F5F5F5]/5 transition-colors min-h-[44px]">
                Clear Filters
              </button>
            </div>

            {/* AM Board Table */}
            <div className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] shadow-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-[#0B1D33] border-b border-[#F5F5F5]/10">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Account Manager
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Status
                      </th>
                      <th className="px-6 py-4 text-center text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Meetings<br/>Today
                      </th>
                      <th className="px-6 py-4 text-center text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Calls<br/>Today
                      </th>
                      <th className="px-6 py-4 text-center text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        No-Shows<br/>Today
                      </th>
                      <th className="px-6 py-4 text-center text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Lobby<br/>Today
                      </th>
                      <th className="px-6 py-4 text-left text-xs font-bold uppercase tracking-wider text-[#F5F5F5]/70">
                        Last Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F5F5F5]/10">
                    {amMetrics.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-12 text-center text-sm text-[#F5F5F5]/60">
                          No Account Managers found in your team
                        </td>
                      </tr>
                    ) : (
                      amMetrics.map((am, idx) => (
                        <tr key={am.id} className="hover:bg-[#F5F5F5]/5 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="h-10 w-10 rounded-full bg-[#2C76FF]/10 flex items-center justify-center">
                                <span className="text-sm font-bold text-[#2C76FF]">
                                  {am.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-white">{am.name}</p>
                                <p className="text-xs text-[#F5F5F5]/60">{am.team} Team</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <StatusBadge tone={
                              am.status === "On call" ? "success" :
                              am.status === "Online" ? "info" : "neutral"
                            }>
                              {am.status}
                            </StatusBadge>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <span className="text-lg font-bold text-white">{am.meetingsToday}</span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <span className="text-lg font-bold text-white">{am.callsToday}</span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <span className={`text-lg font-bold ${am.noShows > 0 ? 'text-[#FF5C5C]' : 'text-white'}`}>
                              {am.noShows}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <span className={`text-lg font-bold ${am.lobbyToday > 0 ? 'text-[#FFDE59]' : 'text-white'}`}>
                              {am.lobbyToday}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-sm text-[#F5F5F5]/70">
                              {am.lastActivity 
                                ? am.lastActivity.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                                : 'No activity'
                              }
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination footer */}
              <div className="border-t border-[#F5F5F5]/10 bg-[#0B1D33] px-6 py-4 flex items-center justify-between">
                <span className="text-sm text-[#F5F5F5]/70">
                  Showing 1-{amMetrics.length} of {amMetrics.length}
                </span>
                <div className="flex items-center gap-2">
                  <button className="rounded-lg border border-[#F5F5F5]/10 bg-[#1E1E1E] px-3 py-2 text-sm font-medium text-white hover:bg-[#F5F5F5]/5 transition-colors disabled:opacity-50" disabled>
                    Previous
                  </button>
                  <button className="rounded-lg bg-[#2C76FF] px-3 py-2 text-sm font-medium text-white">
                    1
                  </button>
                  <button className="rounded-lg border border-[#F5F5F5]/10 bg-[#1E1E1E] px-3 py-2 text-sm font-medium text-white hover:bg-[#F5F5F5]/5 transition-colors disabled:opacity-50" disabled>
                    Next
                  </button>
                </div>
              </div>
            </div>

            {/* System Status */}
            <div className="mt-6 flex items-center justify-between text-xs text-[#F5F5F5]/60">
              <span>All times in UTC+0 • Data refreshes every 30 seconds</span>
              <div className="flex items-center gap-2">
                <span>System Status</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-[#29FE29]" />
                  <span className="text-[#29FE29] font-medium">Operational</span>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Alert Inbox Sidebar */}
      <aside className="w-96 border-l border-[#F5F5F5]/10 bg-[#1E1E1E] flex flex-col overflow-hidden">
        <div className="border-b border-[#F5F5F5]/10 px-6 py-4 bg-[#0B1D33]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5 text-[#FF5C5C]" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <h2 className="text-base font-bold text-white">Alert Inbox</h2>
            </div>
            <span className="rounded-full bg-[#FF5C5C] px-2.5 py-1 text-xs font-bold text-white">
              {liveAlerts.length} Unread
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {liveAlerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
              <div className="h-16 w-16 rounded-full bg-[#29FE29]/10 flex items-center justify-center mb-4">
                <svg className="h-8 w-8 text-[#29FE29]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-white">All clear!</p>
              <p className="text-xs text-[#F5F5F5]/60 mt-1">No active alerts for your team</p>
            </div>
          ) : (
            <ul className="divide-y divide-[#F5F5F5]/10">
              {liveAlerts.map((alert) => (
                <li key={alert.id} className="px-6 py-5 hover:bg-[#F5F5F5]/5 transition-colors">
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                      alert.severity === "critical" ? "bg-[#FF5C5C]/10" : "bg-[#FFDE59]/10"
                    }`}>
                      <span className="text-lg">
                        {alert.severity === "critical" ? "🚨" : "⚠️"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge tone={alert.severity === "critical" ? "critical" : "warning"}>
                          {alert.alertType === "bot_lobby_stuck" 
                            ? "Lobby Wait" 
                            : alert.severity === "critical" 
                              ? "Customer Missing 15min"
                              : "Customer Missing 10min"
                          }
                        </StatusBadge>
                      </div>
                      <p className="text-xs font-medium text-white mb-1">
                        {alert.amName}
                      </p>
                      <p className="text-xs text-[#F5F5F5]/70 mb-2">
                        {alert.message}
                      </p>
                      <p className="text-[10px] text-[#F5F5F5]/50">
                        {new Date(alert.firstSeenAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                  <Link
                    href={`/admin/meetings/${alert.meetingId}`}
                    className="block w-full rounded-lg bg-[#2C76FF] px-4 py-2 text-center text-sm font-semibold text-white hover:bg-[#2C76FF]/90 transition-all min-h-[44px] flex items-center justify-center"
                  >
                    View lobby →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
    </RoleShell>
  );
}
