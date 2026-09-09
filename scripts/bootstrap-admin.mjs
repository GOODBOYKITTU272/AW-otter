// Creates the first ApplyWizz organization and its first Admin. This is the
// ONLY supported way to provision a new organization — there is no in-app
// "make me admin" endpoint. Run manually by an ApplyWizz operator who holds
// the service-role key; never invoked from the browser or a public route.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... APP_BASE_URL=... \
//     node scripts/bootstrap-admin.mjs \
//     --org-name "ApplyWizz" --org-slug "applywizz" \
//     --admin-email "admin@applywizz.com" --admin-name "Jane Admin"
//
// APP_BASE_URL is required (unless --local) so the invite email's link
// points at this app's own /auth/set-password page — without it, Supabase
// redirects to the project's default site_url, the invited admin never
// sees the set-password page, and (since the on-auth-user-created trigger
// activates their membership immediately at invite time, not at password-
// set time) they'd land on an "already active" home page with no password
// ever set and no way back in once the temporary session expires.
//
// In production this sends a real invite email (via Supabase Auth's
// configured SMTP) so the operator never handles the Admin's password. In
// local development, if there's no SMTP configured, pass --local to create
// the account with a known password instead (see scripts/seed-local-users.mjs
// for the same trick used by the test fixtures).

import { createClient } from "@supabase/supabase-js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appBaseUrl = process.env.APP_BASE_URL;

  if (!supabaseUrl || !serviceRoleKey || (!args.local && !appBaseUrl)) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (and APP_BASE_URL unless --local — the invite link needs to know where /auth/set-password lives).",
    );
  }
  const {
    "org-name": orgName,
    "org-slug": orgSlug,
    "admin-email": adminEmail,
    "admin-name": adminName,
  } = args;
  if (!orgName || !orgSlug || !adminEmail || !adminName) {
    throw new Error(
      "Required: --org-name --org-slug --admin-email --admin-name (optionally --local)",
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: organization, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: orgName, slug: orgSlug })
    .select("id")
    .single();
  if (orgError) throw orgError;

  const { data: adminRole, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("key", "admin")
    .is("organization_id", null)
    .single();
  if (roleError) throw roleError;

  const { error: membershipError } = await supabase
    .from("organization_memberships")
    .insert({
      organization_id: organization.id,
      work_email: adminEmail,
      display_name: adminName,
      role_id: adminRole.id,
      status: "invited",
    });
  if (membershipError) throw membershipError;

  if (args.local) {
    const password = "LocalDevPassword123!";
    const { error } = await supabase.auth.admin.createUser({
      email: adminEmail,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(
      `Created organization "${orgName}" and admin ${adminEmail} (password: ${password}).`,
    );
  } else {
    const { error } = await supabase.auth.admin.inviteUserByEmail(adminEmail, {
      data: { display_name: adminName },
      redirectTo: `${appBaseUrl}/auth/set-password`,
    });
    if (error) throw error;
    console.log(
      `Created organization "${orgName}" and invited admin ${adminEmail}.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
