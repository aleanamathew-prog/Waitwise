import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `pg` must stay a real Node module, not be bundled into the server chunk.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
