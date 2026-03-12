import { describe, it, expect } from 'vitest';
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
});
