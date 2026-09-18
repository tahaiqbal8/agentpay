import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone with only the traced dependencies, which is what
  // the Docker runtime stage copies. Without this the image carries the whole
  // node_modules tree.
  output: "standalone",
};
export default nextConfig;
