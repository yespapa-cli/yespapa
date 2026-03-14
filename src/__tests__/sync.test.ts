import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushCommand, syncCommandResolution, getChannelCount, subscribeToHostChannel } from '../remote/sync.js';

describe('remote sync module', () => {
  const mockInsert = vi.fn().mockResolvedValue({ error: null });
  const mockUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  });
  const mockFunctionsInvoke = vi.fn().mockResolvedValue({ data: { status: 'ok' }, error: null });
  const mockRemote = {
    from: vi.fn().mockImplementation(() => ({
      insert: mockInsert,
      update: mockUpdate,
    })),
    functions: {
      invoke: mockFunctionsInvoke,
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn(),
    removeAllChannels: vi.fn(),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pushCommand', () => {
    it('inserts a command into the commands table', async () => {
      await pushCommand(mockRemote, 'host-123', 'cmd_abc', 'rm -rf ./dist');
      expect(mockRemote.from).toHaveBeenCalledWith('commands');
      expect(mockInsert).toHaveBeenCalledWith({
        id: 'cmd_abc',
        host_id: 'host-123',
        command_display: 'rm -rf ./dist',
        justification: null,
        status: 'pending',
        timeout_seconds: 0,
      });
    });

    it('includes justification when provided', async () => {
      await pushCommand(mockRemote, 'host-123', 'cmd_def', 'rm -rf ./dist', 'clearing build');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ justification: 'clearing build' }),
      );
    });

    it('includes timeout when provided', async () => {
      await pushCommand(mockRemote, 'host-123', 'cmd_ghi', 'rm -rf ./test', undefined, 120);
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ timeout_seconds: 120 }),
      );
    });

    it('throws on insert failure', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'Insert failed' } });
      await expect(
        pushCommand(mockRemote, 'host-123', 'cmd_fail', 'rm -rf /'),
      ).rejects.toThrow('Insert failed');
    });

    it('calls push_notification edge function after insert', async () => {
      await pushCommand(mockRemote, 'host-123', 'cmd_push', 'rm -rf ./dist');
      // Wait for the async push notification call
      await vi.waitFor(() => {
        expect(mockFunctionsInvoke).toHaveBeenCalledWith('push_notification', {
          body: expect.objectContaining({
            type: 'INSERT',
            table: 'commands',
            record: expect.objectContaining({ id: 'cmd_push' }),
          }),
        });
      });
    });
  });

  describe('getChannelCount', () => {
    it('returns channel count from remote client', () => {
      const mockClient = {
        getChannels: vi.fn().mockReturnValue([{ name: 'ch1' }, { name: 'ch2' }]),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;
      expect(getChannelCount(mockClient)).toBe(2);
    });
  });

  describe('subscribeToHostChannel', () => {
    it('creates a single consolidated channel for both tables', () => {
      const onFn = vi.fn().mockReturnThis();
      const subscribeFn = vi.fn().mockReturnThis();
      const channelFn = vi.fn().mockReturnValue({ on: onFn, subscribe: subscribeFn });
      const client = {
        channel: channelFn,
        removeChannel: vi.fn(),
        removeAllChannels: vi.fn(),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;

      subscribeToHostChannel(
        { client, hostId: 'host-1', validateTotp: () => true },
        () => {},
      );

      // Should create ONE channel
      expect(channelFn).toHaveBeenCalledTimes(1);
      expect(channelFn).toHaveBeenCalledWith('host:host-1');
      // Should subscribe to both commands and grace_periods via .on() calls
      expect(onFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('syncCommandResolution', () => {
    it('updates the command status on remote', async () => {
      await syncCommandResolution(mockRemote, 'cmd_abc', 'approved', 'totp_stdin');
      expect(mockRemote.from).toHaveBeenCalledWith('commands');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
      );
    });

    it('logs error on update failure', async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({ error: { message: 'Update failed' } }),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await syncCommandResolution(mockRemote, 'cmd_fail', 'denied');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Update failed'));
      consoleSpy.mockRestore();
    });
  });
});
