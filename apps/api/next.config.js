/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep production builds separate from the cache used by `next dev`.
  // Running a build while the local API is open must not corrupt the dev server.
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
  turbopack: {
    root: require("node:path").resolve(__dirname, "../.."),
  },
  typescript: {
    ignoreBuildErrors: process.env.KALIKA_SKIP_BUILD_TYPECHECK === "1",
  },
};

module.exports = nextConfig;
