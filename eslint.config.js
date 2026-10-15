// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["examples/market/*.ts", "eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `||` on strings is deliberate: an empty value falls back to the default too.
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "it", "test", "suite"] },
          ],
        },
      ],
    },
  },
  {
    // Test doubles: async stubs with nothing to await, empty no-op callbacks and
    // fixtures read back with JSON.parse.
    files: ["src/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
