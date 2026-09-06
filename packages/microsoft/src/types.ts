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
