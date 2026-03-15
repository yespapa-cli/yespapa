import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushCommand, syncCommandResolution, getChannelCount, subscribeToHostChannel } from '../remote/sync.js';
import type { RemoteProvider, RemoteSubscription } from '../remote/provider.js';

describe('remote sync module', () => {
  const mockSubscription: RemoteSubscription = { unsubscribe: vi.fn() };

  const mockProvider: RemoteProvider = {
    signInAnonymously: vi.fn(),
    refreshSession: vi.fn(),
    findHostsByFingerprint: vi.fn(),
    getHostById: vi.fn(),
    insertHost: vi.fn(),
    updateHost: vi.fn(),
    insertCommand: vi.fn().mockResolvedValue(undefined),
    updateCommand: vi.fn().mockResolvedValue(undefined),
    fetchGracePeriods: vi.fn().mockResolvedValue([]),
    subscribeToHostEvents: vi.fn().mockReturnValue(mockSubscription),
    sendPushNotification: vi.fn().mockResolvedValue(undefined),
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
    removeAllSubscriptions: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pushCommand', () => {
    it('inserts a command via provider', async () => {
      await pushCommand(mockProvider, 'host-123', 'cmd_abc', 'rm -rf ./dist');
      expect(mockProvider.insertCommand).toHaveBeenCalledWith({
        id: 'cmd_abc',
        host_id: 'host-123',
        command_display: 'rm -rf ./dist',
        justification: null,
        status: 'pending',
        timeout_seconds: 0,
      });
    });

    it('includes justification when provided', async () => {
      await pushCommand(mockProvider, 'host-123', 'cmd_def', 'rm -rf ./dist', 'clearing build');
      expect(mockProvider.insertCommand).toHaveBeenCalledWith(
        expect.objectContaining({ justification: 'clearing build' }),
      );
    });

    it('includes timeout when provided', async () => {
      await pushCommand(mockProvider, 'host-123', 'cmd_ghi', 'rm -rf ./test', undefined, 120);
      expect(mockProvider.insertCommand).toHaveBeenCalledWith(
        expect.objectContaining({ timeout_seconds: 120 }),
      );
    });

    it('throws on insert failure', async () => {
      (mockProvider.insertCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Insert failed'),
      );
      await expect(
        pushCommand(mockProvider, 'host-123', 'cmd_fail', 'rm -rf /'),
      ).rejects.toThrow('Insert failed');
    });

    it('calls sendPushNotification after insert', async () => {
      await pushCommand(mockProvider, 'host-123', 'cmd_push', 'rm -rf ./dist');
      await vi.waitFor(() => {
        expect(mockProvider.sendPushNotification).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'cmd_push' }),
        );
      });
    });
  });

  describe('getChannelCount', () => {
    it('returns subscription count from provider', () => {
      (mockProvider.getActiveSubscriptionCount as ReturnType<typeof vi.fn>).mockReturnValue(2);
      expect(getChannelCount(mockProvider)).toBe(2);
    });
  });

  describe('subscribeToHostChannel', () => {
    it('subscribes to host events via provider', () => {
      subscribeToHostChannel(
        { client: mockProvider, hostId: 'host-1', validateTotp: () => true },
        () => {},
      );

      expect(mockProvider.subscribeToHostEvents).toHaveBeenCalledTimes(1);
      expect(mockProvider.subscribeToHostEvents).toHaveBeenCalledWith(
        'host-1',
        expect.objectContaining({
          onCommandUpdate: expect.any(Function),
          onGracePeriodUpdate: expect.any(Function),
          onStatusChange: expect.any(Function),
        }),
      );
    });
  });

  describe('syncCommandResolution', () => {
    it('updates the command status via provider', async () => {
      await syncCommandResolution(mockProvider, 'cmd_abc', 'approved', 'totp_stdin');
      expect(mockProvider.updateCommand).toHaveBeenCalledWith('cmd_abc', {
        status: 'approved',
        resolved_at: expect.any(String),
      });
    });

    it('logs error on update failure', async () => {
      (mockProvider.updateCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Update failed'),
      );
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await syncCommandResolution(mockProvider, 'cmd_fail', 'denied');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Update failed'));
      consoleSpy.mockRestore();
    });
  });
});
