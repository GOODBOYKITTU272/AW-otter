/**
 * Meeting Detail tab visibility. Account Managers see Overview + media +
 * Insights, but never the raw Transcript tab. Managers and admins see all.
 */
export function canViewRawTranscript(roleKey: string): boolean {
  return roleKey !== "account_manager";
}

export function meetingDetailTabKeys(roleKey: string): string[] {
  const tabs = ["overview", "audio", "video"];
  if (canViewRawTranscript(roleKey)) {
    tabs.push("transcript");
  }
  tabs.push("insights");
  return tabs;
}
