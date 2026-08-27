import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  // ffmpeg-static exports a filesystem path computed from its module
  // location; if Next bundles it, the path points into .next/server/ where
  // no binary exists. Keep it external so it resolves from node_modules.
  serverExternalPackages: ["ffmpeg-static"],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["three"],
  // Avoid the 200-800ms cold-start cost of barrel-file imports.
  // react-icons re-exports thousands of icon components from /fa, etc.;
  // recharts and @huggingface/hub also have wide entry surfaces.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts", "@huggingface/hub"],
  },
  generateBuildId: () => packageJson.version,
};

export default nextConfig;
