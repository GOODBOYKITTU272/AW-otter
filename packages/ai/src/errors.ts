/** Non-2xx HTTP response from the intelligence provider. Message is always generic — never includes the raw response body (may contain transcript content). */
export class IntelligenceApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "IntelligenceApiError";
    this.status = status;
  }
}

/** 2xx response whose body isn't valid JSON, or fails meetingIntelligenceResultSchema validation. Carries the Zod issue summary, never the raw model output (may embed transcript content beyond what's safe to log). */
export class IntelligenceMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelligenceMalformedResponseError";
  }
}

export class IntelligenceTimeoutError extends Error {
  constructor() {
    super("Meeting intelligence provider request timed out.");
    this.name = "IntelligenceTimeoutError";
  }
}
