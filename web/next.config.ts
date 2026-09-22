import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone with only the traced dependencies, which is what
  // the Docker runtime stage copies. Without this the image carries the whole
  // node_modules tree.
  //
  // Skipped on Vercel, which builds with its own pipeline and does not want a
  // self-hosting output mode chosen for it. `VERCEL` is set during every
  // Vercel build, so the Docker image is byte-for-byte unaffected.
  output: process.env.VERCEL ? undefined : "standalone",
};
export default nextConfig;
