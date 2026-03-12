import { createHmac, randomBytes } from 'node:crypto';

export interface GraceToken {
  id: string;
  scope: string;
  expires_at: string;
  hmac_signature: string;
  created_at: string;
}

/**
 * Create a grace period token with HMAC signature.
 * The HMAC ties the token to the TOTP seed, so it cannot be forged without the seed.
 *
 * @param seed - The TOTP seed (hex or base32 string)
 * @param scope - 'all' or a bundle name (e.g., 'destructive', 'git-rewrite')
 * @param durationMs - Duration in milliseconds
 */
export function createGraceToken(
  seed: string,
  scope: string,
  durationMs: number,
): GraceToken {
  const id = `grace_${randomBytes(8).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);
  const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000);

  const hmacInput = `grace:${scope}:${expiresAtUnix}`;
  const hmac = createHmac('sha256', seed).update(hmacInput).digest('hex');

  return {
    id,
    scope,
    expires_at: expiresAt.toISOString(),
    hmac_signature: hmac,
    created_at: now.toISOString(),
  };
}

/**
 * Validate a grace token's HMAC signature and check expiry.
 *
 * @returns true if the token is valid and not expired
 */
export function validateGraceToken(
  seed: string,
  token: GraceToken,
): boolean {
  // Check expiry
  const expiresAt = new Date(token.expires_at);
  if (expiresAt <= new Date()) {
    return false;
  }

  // Verify HMAC
  const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000);
  const hmacInput = `grace:${token.scope}:${expiresAtUnix}`;
  const expectedHmac = createHmac('sha256', seed).update(hmacInput).digest('hex');

  return token.hmac_signature === expectedHmac;
}

/**
 * Get the remaining time for a grace token in human-readable format.
 */
export function getGraceRemaining(token: GraceToken): string {
  const expiresAt = new Date(token.expires_at);
  const now = new Date();
  const remainingMs = expiresAt.getTime() - now.getTime();

  if (remainingMs <= 0) return 'expired';

  const minutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// Duration constants
export const DURATION_1H = 60 * 60 * 1000;
export const DURATION_24H = 24 * 60 * 60 * 1000;
export const DURATION_7D = 7 * 24 * 60 * 60 * 1000;
