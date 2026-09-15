/**
 * Generates the bot display name for meetings based on the owner's display name.
 * Format: "AI Note Maker · {FirstName}" where FirstName is the first token from the
 * meeting owner membership's display_name field.
 * Falls back to "AI Note Maker" if no display name is available.
 */
export function generateBotDisplayName(ownerDisplayName: string | null | undefined): string {
  const DEFAULT_BOT_NAME = "AI Note Maker";
  
  if (!ownerDisplayName || ownerDisplayName.trim() === "") {
    return DEFAULT_BOT_NAME;
  }

  const firstName = ownerDisplayName.trim().split(/\s+/)[0];
  
  if (!firstName || firstName === "") {
    return DEFAULT_BOT_NAME;
  }

  return `${DEFAULT_BOT_NAME} · ${firstName}`;
}
