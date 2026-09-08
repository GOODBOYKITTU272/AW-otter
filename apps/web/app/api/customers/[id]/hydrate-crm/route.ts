import { NextResponse } from "next/server";
import { UnauthenticatedError } from "@applywizz/auth";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  CustomerHasNoExternalIdentityError,
  CustomerNotVisibleError,
  hydrateCustomerCrmBaseline,
} from "@applywizz/domain/customer-context";
import { getCustomerDetailsEnv, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M10 amendment: server-only CRM baseline refresh, triggered by an
// explicit AM action (never automatically on every page view — an
// external API call per page load would be wasteful and slow). The
// browser never calls the upstream customer-details API directly and
// never supplies an AWL id — hydrateCustomerCrmBaseline reads it from
// Signal's own customers row, only after proving (via the caller's own
// client) that this user can actually see this customer.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const supabase = await getSupabaseServerClient();
    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );
    const crmEnv = getCustomerDetailsEnv();

    const result = await hydrateCustomerCrmBaseline(
      supabase,
      serviceRoleClient,
      {
        crmBaseUrl: crmEnv.APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL,
        crmApiKey: crmEnv.APPLYWIZZ_CUSTOMER_DETAILS_API_KEY,
      },
      id,
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof CustomerNotVisibleError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof CustomerHasNoExternalIdentityError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // §14 failure behavior: upstream down/malformed never corrupts the
    // existing baseline (this route only ever INSERTs a new snapshot; it
    // never touches an existing one) — surface a clear, safe error so
    // the page can keep showing whatever baseline it already had.
    console.error("CRM hydration failed:", (error as Error)?.name);
    return NextResponse.json(
      { error: "Could not refresh from the CRM right now." },
      { status: 502 },
    );
  }
}
