import { describe, it, expect, vi } from 'vitest';
import {
  generatePairingToken,
  createPairingPayload,
  generatePairingQR,
} from '../supabase/pairing.js';

describe('pairing module', () => {
  describe('generatePairingToken', () => {
    it('generates a 64-char hex string (32 bytes)', () => {
      const token = generatePairingToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates unique tokens', () => {
      const t1 = generatePairingToken();
      const t2 = generatePairingToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('createPairingPayload', () => {
    it('creates a payload with all fields', () => {
      const payload = createPairingPayload(
        'https://test.supabase.co',
        'anon-key-123',
        'host-uuid',
        'token-abc',
      );
      expect(payload.supabase_url).toBe('https://test.supabase.co');
      expect(payload.supabase_anon_key).toBe('anon-key-123');
      expect(payload.host_id).toBe('host-uuid');
      expect(payload.pairing_token).toBe('token-abc');
    });
  });

  describe('generatePairingQR', () => {
    it('generates a QR string from the payload', async () => {
      const payload = createPairingPayload(
        'https://test.supabase.co',
        'key',
        'host-1',
        'token-1',
      );
      const qr = await generatePairingQR(payload);
      expect(qr).toBeTruthy();
      expect(typeof qr).toBe('string');
      // QR should contain the encoded data
      expect(qr.length).toBeGreaterThan(0);
    });
  });
});
