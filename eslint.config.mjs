import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // This is an imperative React-Three-Fiber app: the whole point of the
    // Engine (PROJECT.md §임퍼러티브 경계) is to mutate three/rapier objects and
    // refs outside React's render, and R3F code routinely mutates `scene`
    // returned from useThree. Next 16's experimental React-Compiler rules flag
    // those correct patterns as errors, so we relax exactly those rules while
    // keeping rules-of-hooks, exhaustive-deps and unused-vars fully on.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
    },
  },
]);

export default eslintConfig;
