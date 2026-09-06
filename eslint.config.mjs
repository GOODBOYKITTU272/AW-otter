// Lints plain-TypeScript workspace packages (packages/*, workers/*).
// apps/web has its own nearer eslint.config.mjs (Next-flavored) which ESLint
// finds first when linting from within that directory, so it never reaches
// this file.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/web/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
