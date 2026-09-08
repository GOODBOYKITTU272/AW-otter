/** Non-2xx HTTP response from the CRM customer-details API. */
export class CrmApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CrmApiError";
    this.status = status;
  }
}

/**
 * 2xx response whose body fails schema validation, or is missing the
 * required identity field (applywizz_id). Never carries the raw upstream
 * body in its message — the body may contain PII.
 */
export class CrmMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmMalformedResponseError";
  }
}

export class CrmTimeoutError extends Error {
  constructor() {
    super("CRM customer-details API request timed out.");
    this.name = "CrmTimeoutError";
  }
}

/** The caller asked for a customer with no external_applywizz_id — never sent upstream (nothing to look up). */
export class CrmProviderMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmProviderMisuseError";
  }
}
