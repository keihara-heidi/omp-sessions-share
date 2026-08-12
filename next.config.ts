import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const nextConfig: NextConfig = {
  // Static export served by the local daemon; no Node server at runtime.
  output: "export",
  // Emit out/login/index.html (directory-style paths) instead of login.html.
  trailingSlash: true,
  generateBuildId: async () => `omp-sessions-share-${version}`,
};

export default nextConfig;
