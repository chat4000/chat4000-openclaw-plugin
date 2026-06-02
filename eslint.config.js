import tseslint from "typescript-eslint";
import neverthrow from "eslint-plugin-neverthrow";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.generated.ts", "scripts/**"],
  },
  {
    files: ["index.ts", "channel-plugin-api.ts", "src/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    linterOptions: { reportUnusedDisableDirectives: true },
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { neverthrow },
    rules: {
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-useless-catch": "error",
      "neverthrow/must-use-result": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests exercise SDK internals and fakes; relax the strictest type-safety
    // rules that fight legitimate test doubles, but keep the no-* bans.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
