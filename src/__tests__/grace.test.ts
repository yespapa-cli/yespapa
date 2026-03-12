import { describe, it, expect } from 'vitest';
import {
  createGraceToken,
  validateGraceToken,
  getGraceRemaining,
  DURATION_1H,
  DURATION_24H,
  DURATION_7D,
} from '../crypto/grace.js';

const TEST_SEED = 'test-seed-for-hmac-validation-1234567890';

describe('grace period HMAC tokens', () => {
  describe('createGraceToken', () => {
    it('generates a token with all required fields', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      expect(token.id).toMatch(/^grace_[0-9a-f]{16}$/);
      expect(token.scope).toBe('all');
      expect(token.expires_at).toBeTruthy();
      expect(token.hmac_signature).toMatch(/^[0-9a-f]{64}$/);
      expect(token.created_at).toBeTruthy();
    });

    it('expires in the future by the specified duration', () => {
      const before = Date.now();
      const token = createGraceToken(TEST_SEED, 'destructive', DURATION_1H);
      const expiresAt = new Date(token.expires_at).getTime();
      const after = Date.now();

      // Should expire approximately 1 hour from now
      expect(expiresAt).toBeGreaterThanOrEqual(before + DURATION_1H - 100);
      expect(expiresAt).toBeLessThanOrEqual(after + DURATION_1H + 100);
    });

    it('generates unique IDs', () => {
      const t1 = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      const t2 = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('validateGraceToken', () => {
    it('accepts a valid, non-expired token', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      expect(validateGraceToken(TEST_SEED, token)).toBe(true);
    });

    it('accepts tokens with different scopes', () => {
      const tokenAll = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      const tokenBundle = createGraceToken(TEST_SEED, 'destructive', DURATION_24H);
      expect(validateGraceToken(TEST_SEED, tokenAll)).toBe(true);
      expect(validateGraceToken(TEST_SEED, tokenBundle)).toBe(true);
    });

    it('rejects an expired token', () => {
      // Create a token that expired 1 second ago
      const token = createGraceToken(TEST_SEED, 'all', -1000);
      expect(validateGraceToken(TEST_SEED, token)).toBe(false);
    });

    it('rejects a token with tampered scope', () => {
      const token = createGraceToken(TEST_SEED, 'destructive', DURATION_1H);
      const tampered = { ...token, scope: 'all' }; // Broaden scope
      expect(validateGraceToken(TEST_SEED, tampered)).toBe(false);
    });

    it('rejects a token with tampered expiry', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      // Extend expiry by 24 hours
      const extended = new Date(new Date(token.expires_at).getTime() + DURATION_24H);
      const tampered = { ...token, expires_at: extended.toISOString() };
      expect(validateGraceToken(TEST_SEED, tampered)).toBe(false);
    });

    it('rejects a token with wrong seed', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      expect(validateGraceToken('wrong-seed', token)).toBe(false);
    });

    it('rejects a token with tampered HMAC', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      const tampered = { ...token, hmac_signature: 'a'.repeat(64) };
      expect(validateGraceToken(TEST_SEED, tampered)).toBe(false);
    });
  });

  describe('getGraceRemaining', () => {
    it('returns minutes for short durations', () => {
      const token = createGraceToken(TEST_SEED, 'all', 30 * 60 * 1000); // 30 min
      const remaining = getGraceRemaining(token);
      expect(remaining).toMatch(/^\d+m$/);
    });

    it('returns hours and minutes for longer durations', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_1H);
      const remaining = getGraceRemaining(token);
      expect(remaining).toMatch(/^\d+m$|^\d+h \d+m$/);
    });

    it('returns days for multi-day durations', () => {
      const token = createGraceToken(TEST_SEED, 'all', DURATION_7D);
      const remaining = getGraceRemaining(token);
      expect(remaining).toMatch(/^\d+d \d+h$/);
    });

    it('returns expired for past tokens', () => {
      const token = createGraceToken(TEST_SEED, 'all', -1000);
      expect(getGraceRemaining(token)).toBe('expired');
    });
  });

  describe('duration constants', () => {
    it('has correct values', () => {
      expect(DURATION_1H).toBe(3_600_000);
      expect(DURATION_24H).toBe(86_400_000);
      expect(DURATION_7D).toBe(604_800_000);
    });
  });
});
