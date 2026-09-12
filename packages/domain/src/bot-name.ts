/**
 * Generates the bot display name for meetings based on the owner's display name.
 * Format: "AW Echo · {FirstName}" where FirstName is the first token from the
 * meeting owner membership's display_name field.
 * Falls back to "AW Echo" if no display name is available.
 */
export function generateBotDisplayName(ownerDisplayName: string | null | undefined): string {
  const DEFAULT_BOT_NAME = "AW Echo";
  
  if (!ownerDisplayName || ownerDisplayName.trim() === "") {
    return DEFAULT_BOT_NAME;
  }

  const firstName = ownerDisplayName.trim().split(/\s+/)[0];
  
  if (!firstName || firstName === "") {
    return DEFAULT_BOT_NAME;
  }

  return `${DEFAULT_BOT_NAME} · ${firstName}`;
}
