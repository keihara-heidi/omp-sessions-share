import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export served by the local daemon; no Node server at runtime.
  output: "export",
  // Emit out/login/index.html (directory-style paths) instead of login.html.
  trailingSlash: true,
  generateBuildId: async () => "omp-sessions-share-0.1.0",
};

export default nextConfig;
