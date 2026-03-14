import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initializeRemote,
  resetRemoteClient,
  getRemoteClient,
  generateHostFingerprint,
  authenticateAnonymous,
  registerHost,
  updateHeartbeat,
  getHostByFingerprint,
} from '../remote/index.js';

// Mock @supabase/supabase-js
vi.mock('@supabase/supabase-js', () => {
  const mockFrom = vi.fn();
  const mockAuth = {
    signInAnonymously: vi.fn(),
  };
  const mockClient = {
    from: mockFrom,
    auth: mockAuth,
  };
  return {
    createClient: vi.fn(() => mockClient),
  };
});

describe('remote client module', () => {
  beforeEach(() => {
    resetRemoteClient();
  });

  describe('initializeRemote', () => {
    it('creates a client with the given URL and key', () => {
      const client = initializeRemote('https://test.supabase.co', 'test-anon-key');
      expect(client).toBeDefined();
      expect(client.from).toBeDefined();
      expect(client.auth).toBeDefined();
    });

    it('returns the same client on repeated calls', () => {
      const client1 = initializeRemote('https://test.supabase.co', 'key1');
      const client2 = initializeRemote('https://test.supabase.co', 'key2');
      expect(client1).toBe(client2);
    });
  });

  describe('getRemoteClient', () => {
    it('throws if not initialized', () => {
      expect(() => getRemoteClient()).toThrow('Remote client not initialized');
    });

    it('returns client after initialization', () => {
      initializeRemote('https://test.supabase.co', 'key');
      expect(() => getRemoteClient()).not.toThrow();
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
    it('returns userId and accessToken on success', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      (client.auth.signInAnonymously as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          user: { id: 'user-123' },
          session: { access_token: 'token-abc' },
        },
        error: null,
      });

      const result = await authenticateAnonymous();
      expect(result.userId).toBe('user-123');
      expect(result.accessToken).toBe('token-abc');
    });

    it('throws on auth error', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      (client.auth.signInAnonymously as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Auth disabled' },
      });

      await expect(authenticateAnonymous()).rejects.toThrow('Anonymous auth failed');
    });
  });

  describe('registerHost', () => {
    it('inserts a new host if fingerprint not found', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      const mockHost = {
        id: 'host-uuid',
        user_id: 'user-123',
        host_name: 'my-macbook',
        host_fingerprint: 'fp-abc',
        push_token: null,
        last_seen_at: '2026-03-12T00:00:00Z',
        created_at: '2026-03-12T00:00:00Z',
      };

      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockHost, error: null }),
          }),
        }),
      });

      const result = await registerHost('my-macbook', 'fp-abc');
      expect(result.id).toBe('host-uuid');
      expect(result.host_name).toBe('my-macbook');
    });

    it('updates existing host if owned by current user', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      const existingHost = {
        id: 'host-uuid',
        user_id: 'user-123',
        host_name: 'old-name',
        host_fingerprint: 'fp-abc',
        push_token: null,
        last_seen_at: '2026-03-11T00:00:00Z',
        created_at: '2026-03-11T00:00:00Z',
      };
      const updatedHost = { ...existingHost, host_name: 'new-name', last_seen_at: '2026-03-12T00:00:00Z' };

      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [existingHost], error: null }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: updatedHost, error: null }),
            }),
          }),
        }),
      });

      const result = await registerHost('new-name', 'fp-abc');
      expect(result.host_name).toBe('new-name');
    });
  });

  describe('updateHeartbeat', () => {
    it('updates last_seen_at for the host', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      const updateFn = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({ update: updateFn });

      await updateHeartbeat('host-uuid');
      expect(updateFn).toHaveBeenCalled();
    });

    it('throws on error', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: { message: 'Not found' } }),
        }),
      });

      await expect(updateHeartbeat('host-uuid')).rejects.toThrow('Failed to update heartbeat');
    });
  });

  describe('getHostByFingerprint', () => {
    it('returns host record when found', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      const mockHost = {
        id: 'host-uuid',
        host_name: 'my-macbook',
        host_fingerprint: 'fp-abc',
      };

      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: mockHost, error: null }),
          }),
        }),
      });

      const result = await getHostByFingerprint('fp-abc');
      expect(result?.host_name).toBe('my-macbook');
    });

    it('returns null when not found', async () => {
      const client = initializeRemote('https://test.supabase.co', 'key');
      (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      });

      const result = await getHostByFingerprint('nonexistent');
      expect(result).toBeNull();
    });
  });
});
