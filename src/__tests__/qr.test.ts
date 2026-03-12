import { describe, it, expect } from 'vitest';
import { generateQRString } from '../totp/qr.js';
import { generateSeed, generateOtpauthUri } from '../totp/index.js';

describe('QR code generation', () => {
  it('generates a non-empty QR string for an otpauth URI', async () => {
    const seed = generateSeed();
    const uri = generateOtpauthUri(seed, 'test-host');
    const qr = await generateQRString(uri);
    expect(qr.length).toBeGreaterThan(0);
    // Terminal QR uses block characters
    expect(qr).toContain('▄');
  });

  it('generates different QR for different seeds', async () => {
    const seed1 = generateSeed();
    const seed2 = generateSeed();
    const qr1 = await generateQRString(generateOtpauthUri(seed1, 'host1'));
    const qr2 = await generateQRString(generateOtpauthUri(seed2, 'host2'));
    expect(qr1).not.toBe(qr2);
  });
});
