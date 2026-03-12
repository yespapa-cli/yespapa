import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, encryptSeed, decryptSeed } from '../crypto/index.js';

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('test-password-123');
    expect(hash).toContain('$argon2id$');
    expect(await verifyPassword('test-password-123', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('generates different hashes for same password (unique salt)', async () => {
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    expect(h1).not.toBe(h2);
  });
});

describe('seed encryption', () => {
  const testSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('encrypts and decrypts round-trip', async () => {
    const encrypted = await encryptSeed(testSeed, 'my-password');
    const decrypted = await decryptSeed(encrypted, 'my-password');
    expect(decrypted).toBe(testSeed);
  });

  it('produces different ciphertext each time (unique salt + IV)', async () => {
    const e1 = await encryptSeed(testSeed, 'password');
    const e2 = await encryptSeed(testSeed, 'password');
    expect(e1).not.toBe(e2);
  });

  it('fails to decrypt with wrong password', async () => {
    const encrypted = await encryptSeed(testSeed, 'correct-password');
    await expect(decryptSeed(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('fails to decrypt tampered data', async () => {
    const encrypted = await encryptSeed(testSeed, 'password');
    // Flip a byte in the base64 data
    const tampered =
      encrypted.slice(0, 10) +
      (encrypted[10] === 'A' ? 'B' : 'A') +
      encrypted.slice(11);
    await expect(decryptSeed(tampered, 'password')).rejects.toThrow();
  });
});
