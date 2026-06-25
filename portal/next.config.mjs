/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // pg is a native/node dependency used only on the server.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
