import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// M17B: mirrors tsconfig.json's "@/*": ["./*"] path alias — nothing under
// apps/web/lib previously imported anything using the alias from a test's
// dependency graph, so this gap (vitest has its own separate module
// resolution from tsc/Next.js) had never been hit before.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
