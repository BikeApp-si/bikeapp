import type { NextConfig } from "next";

const config: NextConfig = {
  // Playwright runs its own dev server beside yours, with its own build folder (playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // CLAUDE.md and .claude/rules already guide agents in this repo.
  agentRules: false,
  // Keep the dev badge off the screens we compare with docs/screens.
  devIndicators: false,
  // Workspace hosts are subdomains of ROOT_HOST; server actions are posted from them. Uploads go through a
  // server action, so its body may be a 25 MB file (server/files/limits.ts) plus the form around it.
  experimental: { serverActions: { allowedOrigins: [`*.${process.env.ROOT_HOST ?? "localhost:3000"}`], bodySizeLimit: "26mb" } },
};

export default config;
