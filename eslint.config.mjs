import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next/**", ".next-e2e/**", ".next-single/**", "tmp/**", "node_modules/**", "docs/**", "playwright-report/**", "test-results/**", "db/migrations/**", "tools/**"] },
  // The open Bike (plan.md §10b): open code never imports the hosted service's; it asks "@/edition".
  {
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: ["hosted/**", "app/site/**", "app/ws/[[]ws]/(app)/credits/**", "scripts/credits.ts", "scripts/ai-cost.ts", "scripts/site-shots.ts", "tests/e2e/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@/hosted/*", "**/hosted/*", "@/app/site/*"], message: "Open code doesn't import the hosted service's: use @/edition." }] }],
    },
  },
];

export default config;
