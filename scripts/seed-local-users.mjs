// Creates real Supabase Auth accounts for the fake identities in
// supabase/seed.sql, using the Admin API (service role — never exposed to
// the browser). Each account's email exactly matches an `invited`
// organization_memberships.work_email row, so the handle_new_user trigger
// (supabase/migrations) links and activates the membership automatically,
// exactly like a real employee's first sign-in would.
//
// Local development only. Run after `supabase db reset`:
//   pnpm run seed:users

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_SERVICE_ROLE_KEY (local value from `supabase status`).",
  );
  process.exit(1);
}

export const LOCAL_TEST_PASSWORD = "LocalDevPassword123!";

// Must match supabase/seed.sql work_email values exactly.
const TEST_USERS = [
  "admin@org-a.test",
  "manager@org-a.test",
  "am-a@org-a.test",
  "am-b@org-a.test",
  "admin@org-b.test",
  "am@org-b.test",
];

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const email of TEST_USERS) {
    const { error } = await supabase.auth.admin.createUser({
      email,
      password: LOCAL_TEST_PASSWORD,
      email_confirm: true,
    });

    if (error && !error.message.includes("already been registered")) {
      throw error;
    }

    console.log(`${error ? "already exists" : "created"}: ${email}`);
  }

  console.log(`\nAll test accounts use password: ${LOCAL_TEST_PASSWORD}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
