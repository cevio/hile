import type { NextConfig } from 'next';

const actionOrigin = process.env.RSC_DEMO_ORIGIN ?? 'http://127.0.0.1:3200';

const config: NextConfig = {
  allowedDevOrigins: [new URL(actionOrigin).hostname],
};

export default config;
