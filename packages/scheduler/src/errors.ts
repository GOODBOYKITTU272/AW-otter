/** The caller asked for something the provider refuses to send upstream (see client.ts's listCalls guards). Never reaches the network. */
export class SchedulerProviderMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerProviderMisuseError";
  }
}

/** Non-2xx HTTP response from the scheduler API. */
export class SchedulerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SchedulerApiError";
    this.status = status;
  }
}

/** 2xx response whose body doesn't match the documented `{success, calls[]}` envelope. */
export class SchedulerMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerMalformedResponseError";
  }
}

export class SchedulerTimeoutError extends Error {
  constructor() {
    super("Scheduler API request timed out.");
    this.name = "SchedulerTimeoutError";
  }
}
