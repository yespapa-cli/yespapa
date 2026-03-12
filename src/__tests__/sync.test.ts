import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushCommand, syncCommandResolution } from '../supabase/sync.js';

describe('supabase sync module', () => {
  const mockInsert = vi.fn().mockResolvedValue({ error: null });
  const mockUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  });
  const mockSupabase = {
    from: vi.fn().mockImplementation(() => ({
      insert: mockInsert,
      update: mockUpdate,
    })),
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
      await pushCommand(mockSupabase, 'host-123', 'cmd_abc', 'rm -rf ./dist');
      expect(mockSupabase.from).toHaveBeenCalledWith('commands');
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
      await pushCommand(mockSupabase, 'host-123', 'cmd_def', 'rm -rf ./dist', 'clearing build');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ justification: 'clearing build' }),
      );
    });

    it('includes timeout when provided', async () => {
      await pushCommand(mockSupabase, 'host-123', 'cmd_ghi', 'rm -rf ./test', undefined, 120);
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ timeout_seconds: 120 }),
      );
    });

    it('logs error on insert failure', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'Insert failed' } });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await pushCommand(mockSupabase, 'host-123', 'cmd_fail', 'rm -rf /');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Insert failed'));
      consoleSpy.mockRestore();
    });
  });

  describe('syncCommandResolution', () => {
    it('updates the command status in Supabase', async () => {
      await syncCommandResolution(mockSupabase, 'cmd_abc', 'approved', 'totp_stdin');
      expect(mockSupabase.from).toHaveBeenCalledWith('commands');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
      );
    });

    it('logs error on update failure', async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue({ error: { message: 'Update failed' } }),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await syncCommandResolution(mockSupabase, 'cmd_fail', 'denied');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Update failed'));
      consoleSpy.mockRestore();
    });
  });
});
