import { describe, it, expect, vi } from 'vitest';
import {
  generatePairingToken,
  createPairingPayload,
  generatePairingQR,
  createCombinedPayload,
  generateCombinedQR,
  generatePairingUrl,
  generatePairingWebUrl,
} from '../remote/pairing.js';

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
      expect(payload.remote_url).toBe('https://test.supabase.co');
      expect(payload.remote_key).toBe('anon-key-123');
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

  describe('createCombinedPayload', () => {
    it('creates a combined payload with type field and all fields', () => {
      const payload = createCombinedPayload(
        'JBSWY3DPEHPK3PXP',
        'my-host',
        'https://test.supabase.co',
        'anon-key-123',
        'host-uuid',
        'token-abc',
        'refresh-token-xyz',
      );
      expect(payload.type).toBe('yespapa');
      expect(payload.totp_seed).toBe('JBSWY3DPEHPK3PXP');
      expect(payload.host_name).toBe('my-host');
      expect(payload.remote_url).toBe('https://test.supabase.co');
      expect(payload.remote_key).toBe('anon-key-123');
      expect(payload.host_id).toBe('host-uuid');
      expect(payload.pairing_token).toBe('token-abc');
      expect(payload.refresh_token).toBe('refresh-token-xyz');
    });

    it('omits refresh_token when not provided', () => {
      const payload = createCombinedPayload(
        'SEED123',
        'host',
        'https://sb.co',
        'key',
        'hid',
        'tok',
      );
      expect(payload.refresh_token).toBeUndefined();
    });
  });

  describe('generateCombinedQR', () => {
    it('generates a QR string from combined payload', async () => {
      const payload = createCombinedPayload(
        'JBSWY3DPEHPK3PXP',
        'my-host',
        'https://test.supabase.co',
        'anon-key-123',
        'host-uuid',
        'token-abc',
      );
      const qr = await generateCombinedQR(payload);
      expect(qr).toBeTruthy();
      expect(typeof qr).toBe('string');
      expect(qr.length).toBeGreaterThan(0);
    });

    it('payload JSON is within QR capacity', () => {
      const payload = createCombinedPayload(
        'JBSWY3DPEHPK3PXP',
        'my-long-hostname-example',
        'https://izvdpjcqrrcxhokwycgu.supabase.co',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.xxx',
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        'some-refresh-token-value',
      );
      const jsonStr = JSON.stringify(payload);
      // QR code max capacity is 4,296 alphanumeric chars
      expect(jsonStr.length).toBeLessThan(4296);
    });
  });

  describe('generatePairingUrl', () => {
    it('generates a yespapa:// deep-link URL with base64url-encoded data', () => {
      const payload = createCombinedPayload(
        'JBSWY3DPEHPK3PXP',
        'my-host',
        'https://test.supabase.co',
        'anon-key-123',
        'host-uuid',
        'token-abc',
      );
      const url = generatePairingUrl(payload);
      expect(url).toMatch(/^yespapa:\/\/pair\?data=/);

      // Decode and verify round-trip
      const dataParam = new URL(url).searchParams.get('data')!;
      const decoded = JSON.parse(Buffer.from(dataParam, 'base64url').toString());
      expect(decoded.type).toBe('yespapa');
      expect(decoded.totp_seed).toBe('JBSWY3DPEHPK3PXP');
      expect(decoded.host_name).toBe('my-host');
      expect(decoded.host_id).toBe('host-uuid');
    });
  });

  describe('generatePairingWebUrl', () => {
    it('generates a https://yespapa.app/pair URL', () => {
      const payload = createCombinedPayload(
        'SEED',
        'host',
        'https://sb.co',
        'key',
        'hid',
        'tok',
      );
      const url = generatePairingWebUrl(payload);
      expect(url).toMatch(/^https:\/\/yespapa\.app\/pair\?data=/);

      // Verify round-trip
      const dataParam = new URL(url).searchParams.get('data')!;
      const decoded = JSON.parse(Buffer.from(dataParam, 'base64url').toString());
      expect(decoded.type).toBe('yespapa');
      expect(decoded.host_id).toBe('hid');
    });
  });
});
