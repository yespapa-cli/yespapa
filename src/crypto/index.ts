import argon2 from 'argon2';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Argon2id parameters for password hashing
const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
  raw: false,
};

// Argon2id parameters for key derivation (returns raw 32 bytes)
const KDF_OPTIONS: argon2.Options & { raw: true } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  raw: true,
};

/**
 * Hash a master key using Argon2id.
 * Returns the encoded hash string (includes salt, params, hash).
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against an Argon2id hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Encrypt a TOTP seed using AES-256-GCM with a key derived from the password.
 * Returns a string: base64(salt:iv:authTag:ciphertext)
 */
export async function encryptSeed(seed: string, password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await argon2.hash(password, {
    ...KDF_OPTIONS,
    salt,
  });

  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt(16) + iv(12) + authTag(16) + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a TOTP seed using AES-256-GCM with a key derived from the password.
 * Throws on wrong password or tampered data.
 */
export async function decryptSeed(encryptedData: string, password: string): Promise<string> {
  const packed = Buffer.from(encryptedData, 'base64');

  const salt = packed.subarray(0, 16);
  const iv = packed.subarray(16, 28);
  const authTag = packed.subarray(28, 44);
  const ciphertext = packed.subarray(44);

  const key = await argon2.hash(password, {
    ...KDF_OPTIONS,
    salt,
  });

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
