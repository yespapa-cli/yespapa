/**
 * Cross-compatibility tests: verifies that the mobile app's pure-JS
 * TOTP and HMAC-SHA256 implementations produce identical output to
 * the core's Node crypto implementations.
 *
 * This ensures codes generated on the mobile app will be accepted
 * by the daemon, and grace tokens signed on mobile will validate.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { generateSeed, generateCode, validateCode } from '../totp/index.js';
import { createGraceToken, validateGraceToken } from '../crypto/grace.js';

// ── Mobile's pure-JS SHA-1 (copied from packages/mobile/src/services/totp.ts) ──

function sha1(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const bitLen = ml * 8;
  const padLen = (((ml + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen, false);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (t << 1) | (t >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  const result = new Uint8Array(20);
  const rv = new DataView(result.buffer);
  rv.setInt32(0, h0, false); rv.setInt32(4, h1, false); rv.setInt32(8, h2, false);
  rv.setInt32(12, h3, false); rv.setInt32(16, h4, false);
  return result;
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha1(k);
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(k);
  const ipad = new Uint8Array(blockSize + message.length);
  const opad = new Uint8Array(blockSize + 20);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }
  ipad.set(message, blockSize);
  const inner = sha1(ipad);
  opad.set(inner, blockSize);
  return sha1(opad);
}

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/[= \n\r]/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

function mobileGenerateHOTP(secret: Uint8Array, counter: number): string {
  const counterBuf = new Uint8Array(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  const hash = hmacSha1(secret, counterBuf);
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

function mobileGenerateCode(seed: string): string {
  const secret = base32Decode(seed);
  const counter = Math.floor(Date.now() / 1000 / 30);
  return mobileGenerateHOTP(secret, counter);
}

// ── Mobile's pure-JS SHA-256 (copied from packages/mobile/src/services/grace.ts) ──

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number { return (x >>> n) | (x << (32 - n)); }

function sha256(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const bitLen = ml * 8;
  const padLen = (((ml + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen, false);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0); rv.setUint32(4, h1); rv.setUint32(8, h2); rv.setUint32(12, h3);
  rv.setUint32(16, h4); rv.setUint32(20, h5); rv.setUint32(24, h6); rv.setUint32(28, h7);
  return result;
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256(k);
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(k);
  const ipad = new Uint8Array(blockSize + message.length);
  const opad = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }
  ipad.set(message, blockSize);
  const inner = sha256(ipad);
  opad.set(inner, blockSize);
  return sha256(opad);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function textEncode(s: string): Uint8Array {
  const arr: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) arr.push(c);
    else if (c < 0x800) { arr.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else { arr.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(arr);
}

function mobileHmacSha256Hex(seed: string, message: string): string {
  const keyBytes = textEncode(seed);
  const msgBytes = textEncode(message);
  return toHex(hmacSha256(keyBytes, msgBytes));
}

// ── Tests ──

describe('mobile ↔ core cross-compatibility', () => {
  describe('TOTP (HMAC-SHA1)', () => {
    it('mobile generateCode matches core generateCode for same seed', () => {
      const seed = generateSeed();
      const coreCode = generateCode(seed);
      const mobileCode = mobileGenerateCode(seed);
      expect(mobileCode).toBe(coreCode);
    });

    it('mobile-generated codes are accepted by core validateCode', () => {
      const seed = generateSeed();
      const mobileCode = mobileGenerateCode(seed);
      expect(validateCode(seed, mobileCode)).toBe(true);
    });

    it('matches across multiple seeds', () => {
      for (let i = 0; i < 10; i++) {
        const seed = generateSeed();
        expect(mobileGenerateCode(seed)).toBe(generateCode(seed));
      }
    });

    it('mobile HMAC-SHA1 matches Node crypto HMAC-SHA1', () => {
      // Direct HMAC comparison with known inputs
      const key = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const msg = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);

      const mobileResult = toHex(hmacSha1(key, msg));
      const nodeResult = createHmac('sha1', Buffer.from(key)).update(Buffer.from(msg)).digest('hex');
      expect(mobileResult).toBe(nodeResult);
    });
  });

  describe('grace token HMAC-SHA256', () => {
    it('mobile HMAC-SHA256 matches Node crypto HMAC-SHA256', () => {
      const seed = 'test-seed-for-grace-tokens';
      const message = 'grace:all:1700000000';

      const mobileHmac = mobileHmacSha256Hex(seed, message);
      const nodeHmac = createHmac('sha256', seed).update(message).digest('hex');
      expect(mobileHmac).toBe(nodeHmac);
    });

    it('mobile grace HMAC validates against core validateGraceToken', () => {
      const seed = 'integration-test-seed-abc123';
      const scope = 'destructive';
      const durationMs = 3600_000;

      // Simulate what mobile does
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationMs);
      const expiresAtUnix = Math.floor(expiresAt.getTime() / 1000);
      const hmacInput = `grace:${scope}:${expiresAtUnix}`;
      const hmac = mobileHmacSha256Hex(seed, hmacInput);

      const mobileToken = {
        id: 'grace_0000000000000000',
        scope,
        expires_at: expiresAt.toISOString(),
        hmac_signature: hmac,
        created_at: now.toISOString(),
      };

      expect(validateGraceToken(seed, mobileToken)).toBe(true);
    });

    it('core-created grace tokens would validate with mobile HMAC', () => {
      const seed = 'another-test-seed-xyz789';
      const token = createGraceToken(seed, 'all', 3600_000);

      // Recompute HMAC using mobile's implementation
      const expiresAtUnix = Math.floor(new Date(token.expires_at).getTime() / 1000);
      const hmacInput = `grace:${token.scope}:${expiresAtUnix}`;
      const mobileHmac = mobileHmacSha256Hex(seed, hmacInput);

      expect(mobileHmac).toBe(token.hmac_signature);
    });

    it('HMAC matches across different seed and scope combinations', () => {
      const cases = [
        { seed: 'short', scope: 'all' },
        { seed: 'a-much-longer-seed-value-with-special-chars!@#$', scope: 'destructive' },
        { seed: 'JBSWY3DPEHPK3PXP', scope: 'git-rewrite' },
        { seed: 'unicode-seed-café', scope: 'network' },
      ];

      for (const { seed, scope } of cases) {
        const message = `grace:${scope}:1700000000`;
        const mobileHmac = mobileHmacSha256Hex(seed, message);
        const nodeHmac = createHmac('sha256', seed).update(message).digest('hex');
        expect(mobileHmac).toBe(nodeHmac);
      }
    });
  });

  describe('QR pairing flow', () => {
    it('otpauth URI seed round-trips through mobile base32 decode', () => {
      // Simulates: core generates seed → QR → mobile scans → mobile decodes base32
      const seed = generateSeed();
      const decoded = base32Decode(seed);
      // Re-encoding isn't needed; what matters is HOTP produces same result
      expect(decoded.length).toBe(20); // 160-bit seed
      // And the code matches
      expect(mobileGenerateCode(seed)).toBe(generateCode(seed));
    });
  });
});
