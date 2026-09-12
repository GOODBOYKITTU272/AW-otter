/** Provider DTO — not the canonical ApplyWizz Meeting domain model (that's M4). */
export interface MicrosoftCalendarEvent {
  externalEventId: string;
  subject: string;
  start: string;
  end: string;
  organizer: { name: string | null; email: string | null };
  attendees: { name: string | null; email: string | null }[];
  isOnlineMeeting: boolean;
  onlineMeetingProvider: string | null;
  joinUrl: string | null;
  lastModified: string;
  /**
   * Stable across every mailbox's copy of the same meeting AND unique
   * per-occurrence within a recurring series (verified against Graph docs —
   * not the RFC 5545 "shared UID, distinguished by RECURRENCE-ID" model).
   * This is canonical meeting identity; externalEventId is mailbox-sync
   * identity only.
   */
  icalUId: string;
  /** singleInstance | occurrence | exception | seriesMaster — metadata only, not part of identity. */
  graphEventType: string | null;
  seriesMasterId: string | null;
  originalStart: string | null;
  /** Whose mailbox this copy belongs to, per Graph's own field — more reliable than comparing email strings. */
  isOrganizer: boolean;
  /** Graph online meeting ID for cloud recording lookup (from onlineMeeting.id) */
  onlineMeetingId: string | null;
}

export interface MicrosoftIdentity {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
}

export interface GraphTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  idToken: string | null;
}

export interface GraphSubscriptionDto {
  externalSubscriptionId: string;
  resource: string;
  expiresAt: string;
}
