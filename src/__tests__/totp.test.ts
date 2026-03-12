import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { generateSeed, generateOtpauthUri, validateCode, generateCode } from '../totp/index.js';

describe('TOTP engine', () => {
  it('generates a base32 seed of correct length', () => {
    const seed = generateSeed();
    // 20 bytes = 32 base32 chars
    expect(seed).toMatch(/^[A-Z2-7]+$/);
    expect(seed.length).toBe(32);
  });

  it('generates different seeds each call', () => {
    const a = generateSeed();
    const b = generateSeed();
    expect(a).not.toBe(b);
  });

  it('generates valid otpauth URI', () => {
    const seed = generateSeed();
    const uri = generateOtpauthUri(seed, 'test-host');
    expect(uri).toMatch(/^otpauth:\/\/totp\/YesPaPa:test-host\?/);
    expect(uri).toContain(`secret=${seed}`);
    expect(uri).toContain('issuer=YesPaPa');
  });

  it('validates a correct code', () => {
    const seed = generateSeed();
    const code = generateCode(seed);
    expect(validateCode(seed, code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const seed = generateSeed();
    expect(validateCode(seed, '000000')).toBe(false);
  });

  it('rejects code from different seed', () => {
    const seedA = generateSeed();
    const seedB = generateSeed();
    const codeA = generateCode(seedA);
    expect(validateCode(seedB, codeA)).toBe(false);
  });

  it('generates 6-digit codes', () => {
    const seed = generateSeed();
    const code = generateCode(seed);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('generates RFC 6238-compatible codes (independent implementation)', () => {
    // This test uses a raw HMAC-SHA1 TOTP implementation to verify
    // our codes match what Google Authenticator / Authy would produce.
    // This would have caught the epoch bug where otplib used Date.now()
    // instead of Unix epoch 0.
    const seed = generateSeed();
    const ourCode = generateCode(seed);

    // Independent RFC 6238 implementation
    const rfcCode = generateRFC6238Code(seed);

    expect(ourCode).toBe(rfcCode);
  });

  it('validates codes from independent RFC 6238 implementation', () => {
    const seed = generateSeed();
    const rfcCode = generateRFC6238Code(seed);
    expect(validateCode(seed, rfcCode)).toBe(true);
  });

  it('uses current time for TOTP counter (not frozen epoch)', () => {
    // The TOTP counter should be based on the current Unix time,
    // not a frozen value. Verify the counter is reasonable.
    const counter = Math.floor(Date.now() / 1000 / 30);
    expect(counter).toBeGreaterThan(1000000); // We're well past epoch

    // Our code should match counter-based computation, not counter=0
    const seed = generateSeed();
    const ourCode = generateCode(seed);
    const counterZeroCode = generateHOTP(seed, 0);
    // Extremely unlikely to match (1 in 1M chance)
    // This catches the epoch:0 bug where all codes would equal counter=0
    expect(ourCode).not.toBe(counterZeroCode);
  });
});

// ── Independent RFC 6238 TOTP implementation for cross-validation ──

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of encoded.toUpperCase()) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateHOTP(base32Secret: string, counter: number): string {
  const secret = base32Decode(base32Secret);
  const buf = Buffer.alloc(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

function generateRFC6238Code(base32Secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30); // T0=0, step=30
  return generateHOTP(base32Secret, counter);
}
