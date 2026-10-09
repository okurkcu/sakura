import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';

/**
 * This variant of the shop needs a session secret to build and its own server to run, as its
 * README says. bdiff's detected recipe has neither, so its setup must be repaired.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD && (process.env.SESSION_SECRET ?? '').length < 16) {
    throw new Error('SESSION_SECRET is not set (16+ characters); see README "Setup"');
  }
  if (phase === PHASE_PRODUCTION_SERVER && process.env.SHOP_SERVER !== '1') {
    throw new Error('Start the shop with its own server (pnpm start), not next start');
  }
  return { poweredByHeader: false };
}
