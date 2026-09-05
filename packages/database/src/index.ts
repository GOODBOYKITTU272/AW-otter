// Root export is type-only on purpose: importing a runtime client here would
// blur the browser/server split. Use `@applywizz/database/browser` or
// `@applywizz/database/server` explicitly.
export type { Database } from "./types";
