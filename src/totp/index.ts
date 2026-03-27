import { authenticator } from 'otplib';

// Configure per PRD: HMAC-SHA1, 6 digits, 30s period, ±1 skew
//
// IMPORTANT: Do NOT set `epoch` here. In otplib, `epoch` means "current time
// in ms" (not the T0 reference). The default calls Date.now() on each
// generate/check call, which correctly implements RFC 6238. Setting epoch: 0
// would mean "current time is 0" (Unix epoch start) → counter always 0 →
// codes incompatible with every authenticator app.
authenticator.options = {
  digits: 6,
  step: 30,
  window: 2, // ±2 periods = 150s total window (tolerates QR scan + typing delay)
};

/**
 * Generate a 160-bit (20-byte) TOTP seed, base32-encoded.
 * Per RFC 4226 recommended minimum.
 */
export function generateSeed(): string {
  // otplib generateSecret defaults to 20 bytes (160 bits)
  return authenticator.generateSecret(20);
}

/**
 * Generate the otpauth:// URI for QR code scanning.
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 */
export function generateOtpauthUri(seed: string, hostName: string): string {
  return authenticator.keyuri(hostName, 'YesPaPa', seed);
}

/**
 * Validate a 6-digit TOTP code against the seed.
 * Accepts ±2 period skew (150-second window total).
 * Returns true if the code is valid.
 */
export function validateCode(seed: string, code: string): boolean {
  return authenticator.check(code, seed);
}

/**
 * Generate the current TOTP code for a seed.
 * Used by the mobile app to send TOTP with approvals.
 */
export function generateCode(seed: string): string {
  return authenticator.generate(seed);
}
