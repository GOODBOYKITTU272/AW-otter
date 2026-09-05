import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@applywizz/auth",
    "@applywizz/database",
    "@applywizz/domain",
  ],
};

export default nextConfig;
