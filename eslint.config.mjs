import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React 18+ auto-batches setState in useEffect; this rule is overly strict for form initialization
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // CI lint gate (ISSUE-022 口径): changed files must be 0-error. Relax
    // no-explicit-any for tests so touching legacy test files doesn't fail
    // the gate; src/ keeps the strict error level. 收敛节奏见 roadmap §9#4.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
