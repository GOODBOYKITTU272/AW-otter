import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@applywizz/auth",
    "@applywizz/database",
    "@applywizz/domain",
    "@applywizz/microsoft",
  ],
};

export default nextConfig;
