import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async rewrites() {
    return [
      {
        source: "/api/runtime/:path*",
        destination: "http://localhost:4000/:path*"
      }
    ];
  }
};

export default nextConfig;
