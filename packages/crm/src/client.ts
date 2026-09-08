import { DEFAULT_TIMEOUT_MS } from "./config";
import {
  CrmApiError,
  CrmMalformedResponseError,
  CrmProviderMisuseError,
  CrmTimeoutError,
} from "./errors";
import { normalizeCrmResponse } from "./normalize";
import { rawCrmResponseSchema, type NormalizedCrmBaseline } from "./types";

export interface GetCustomerDetailsResult {
  normalized: NormalizedCrmBaseline;
  /** The upstream `client.update_at` / additional_information.updated_at, if present — used as source_updated_at, never fabricated. */
  sourceUpdatedAt: string | null;
}

async function fetchOnce(
  url: string,
  apiKey: string | null,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CrmTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/get-client-details behind Signal's own provider abstraction —
 * the only place in the codebase that fetches from this endpoint (same
 * discipline as packages/scheduler/src/client.ts). `applywizzId` must
 * already be a real, authorized-visible customer's stored
 * external_applywizz_id — this function has no knowledge of Signal's own
 * authorization model and trusts its caller (packages/domain's
 * hydration function) to have already proven that. Never logs or throws
 * the raw response body (real customer PII) — only status codes and
 * generic messages.
 *
 * Retries exactly once, only for a transient failure (timeout, network
 * error, or 5xx) — never for a 4xx or a validation failure.
 */
export async function getCustomerDetails(
  baseUrl: string,
  applywizzId: string,
  apiKey: string | null = null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GetCustomerDetailsResult> {
  const id = applywizzId.trim();
  if (id.length === 0) {
    throw new CrmProviderMisuseError(
      "getCustomerDetails requires a non-empty applywizz_id.",
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/api/get-client-details?applywizz_id=${encodeURIComponent(id)}`;

  let response: Response;
  try {
    response = await fetchOnce(url, apiKey, timeoutMs, fetchImpl);
  } catch (firstError) {
    const retriable =
      firstError instanceof CrmTimeoutError || firstError instanceof TypeError;
    if (!retriable) throw firstError;
    response = await fetchOnce(url, apiKey, timeoutMs, fetchImpl);
  }

  if (!response.ok) {
    if (response.status >= 500) {
      const retryResponse = await fetchOnce(url, apiKey, timeoutMs, fetchImpl);
      if (retryResponse.ok)
        return parseAndNormalize(await retryResponse.json().catch(() => null));
      throw new CrmApiError(
        retryResponse.status,
        `CRM customer-details request failed with status ${retryResponse.status}.`,
      );
    }
    throw new CrmApiError(
      response.status,
      `CRM customer-details request failed with status ${response.status}.`,
    );
  }

  const body = await response.json().catch(() => null);
  return parseAndNormalize(body);
}

function parseAndNormalize(body: unknown): GetCustomerDetailsResult {
  const result = rawCrmResponseSchema.safeParse(body);
  if (!result.success) {
    throw new CrmMalformedResponseError(
      `CRM customer-details response failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return {
    normalized: normalizeCrmResponse(result.data),
    sourceUpdatedAt: result.data.client.update_at?.trim() || null,
  };
}
