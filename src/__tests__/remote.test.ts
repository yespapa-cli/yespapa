import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initializeRemote,
  resetRemoteClient,
  getRemoteProvider,
  generateHostFingerprint,
  authenticateAnonymous,
  registerHost,
  updateHeartbeat,
  getHostByFingerprint,
} from '../remote/index.js';
import type { RemoteProvider, HostRecord } from '../remote/provider.js';

// Mock the factory to return a mock provider
const mockProvider: RemoteProvider = {
  signInAnonymously: vi.fn(),
  refreshSession: vi.fn(),
  findHostsByFingerprint: vi.fn(),
  getHostById: vi.fn(),
  insertHost: vi.fn(),
  updateHost: vi.fn(),
  insertCommand: vi.fn(),
  updateCommand: vi.fn(),
  fetchGracePeriods: vi.fn(),
  subscribeToHostEvents: vi.fn(),
  sendPushNotification: vi.fn(),
  getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
  removeAllSubscriptions: vi.fn(),
};

vi.mock('../remote/factory.js', () => ({
  createRemoteProvider: vi.fn(() => Promise.resolve(mockProvider)),
}));

describe('remote client module', () => {
  beforeEach(() => {
    resetRemoteClient();
    vi.clearAllMocks();
  });

  describe('initializeRemote', () => {
    it('creates a provider with the given URL and key', async () => {
      const provider = await initializeRemote('https://test.supabase.co', 'test-anon-key');
      expect(provider).toBeDefined();
      expect(provider).toBe(mockProvider);
    });

    it('returns the same provider on repeated calls', async () => {
      const provider1 = await initializeRemote('https://test.supabase.co', 'key1');
      const provider2 = await initializeRemote('https://test.supabase.co', 'key2');
      expect(provider1).toBe(provider2);
    });
  });

  describe('getRemoteProvider', () => {
    it('throws if not initialized', () => {
      expect(() => getRemoteProvider()).toThrow('Remote provider not initialized');
    });

    it('returns provider after initialization', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      expect(() => getRemoteProvider()).not.toThrow();
    });
  });

  describe('generateHostFingerprint', () => {
    it('returns a 64-char hex string (SHA-256)', () => {
      const fp = generateHostFingerprint();
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same value on repeated calls', () => {
      const fp1 = generateHostFingerprint();
      const fp2 = generateHostFingerprint();
      expect(fp1).toBe(fp2);
    });
  });

  describe('authenticateAnonymous', () => {
    it('returns userId and tokens on success', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      (mockProvider.signInAnonymously as ReturnType<typeof vi.fn>).mockResolvedValue({
        userId: 'user-123',
        accessToken: 'token-abc',
        refreshToken: 'refresh-xyz',
      });

      const result = await authenticateAnonymous();
      expect(result.userId).toBe('user-123');
      expect(result.accessToken).toBe('token-abc');
      expect(result.refreshToken).toBe('refresh-xyz');
    });

    it('throws on auth error', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      (mockProvider.signInAnonymously as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Anonymous auth failed'),
      );

      await expect(authenticateAnonymous()).rejects.toThrow('Anonymous auth failed');
    });
  });

  describe('registerHost', () => {
    it('inserts a new host if fingerprint not found', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      const mockHost: HostRecord = {
        id: 'host-uuid',
        user_id: 'user-123',
        host_name: 'my-macbook',
        host_fingerprint: 'fp-abc',
        push_token: null,
        last_seen_at: '2026-03-12T00:00:00Z',
        created_at: '2026-03-12T00:00:00Z',
      };

      (mockProvider.findHostsByFingerprint as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (mockProvider.insertHost as ReturnType<typeof vi.fn>).mockResolvedValue(mockHost);

      const result = await registerHost('my-macbook', 'fp-abc');
      expect(result.id).toBe('host-uuid');
      expect(result.host_name).toBe('my-macbook');
      expect(mockProvider.insertHost).toHaveBeenCalledWith({
        host_name: 'my-macbook',
        host_fingerprint: 'fp-abc',
      });
    });

    it('updates existing host if owned by current user', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      const existingHost: HostRecord = {
        id: 'host-uuid',
        user_id: 'user-123',
        host_name: 'old-name',
        host_fingerprint: 'fp-abc',
        push_token: null,
        last_seen_at: '2026-03-11T00:00:00Z',
        created_at: '2026-03-11T00:00:00Z',
      };
      const updatedHost = { ...existingHost, host_name: 'new-name', last_seen_at: '2026-03-12T00:00:00Z' };

      (mockProvider.findHostsByFingerprint as ReturnType<typeof vi.fn>).mockResolvedValue([existingHost]);
      (mockProvider.updateHost as ReturnType<typeof vi.fn>).mockResolvedValue(updatedHost);

      const result = await registerHost('new-name', 'fp-abc');
      expect(result.host_name).toBe('new-name');
    });
  });

  describe('updateHeartbeat', () => {
    it('updates last_seen_at for the host', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      (mockProvider.updateHost as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'host-uuid',
        last_seen_at: new Date().toISOString(),
      });

      await updateHeartbeat('host-uuid');
      expect(mockProvider.updateHost).toHaveBeenCalledWith('host-uuid', {
        last_seen_at: expect.any(String),
      });
    });

    it('throws on error', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      (mockProvider.updateHost as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(updateHeartbeat('host-uuid')).rejects.toThrow('Failed to update heartbeat');
    });
  });

  describe('getHostByFingerprint', () => {
    it('returns host record when found', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      const mockHost: HostRecord = {
        id: 'host-uuid',
        user_id: 'user-123',
        host_name: 'my-macbook',
        host_fingerprint: 'fp-abc',
        push_token: null,
        last_seen_at: '2026-03-12T00:00:00Z',
        created_at: '2026-03-12T00:00:00Z',
      };

      (mockProvider.findHostsByFingerprint as ReturnType<typeof vi.fn>).mockResolvedValue([mockHost]);

      const result = await getHostByFingerprint('fp-abc');
      expect(result?.host_name).toBe('my-macbook');
    });

    it('returns null when not found', async () => {
      await initializeRemote('https://test.supabase.co', 'key');
      (mockProvider.findHostsByFingerprint as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await getHostByFingerprint('nonexistent');
      expect(result).toBeNull();
    });
  });
});
