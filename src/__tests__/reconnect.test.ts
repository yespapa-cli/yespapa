import { describe, it, expect, vi } from 'vitest';
import { createReconnectManager, type ConnectionState } from '../remote/reconnect.js';

// Mock the sync module
vi.mock('../remote/sync.js', () => ({
  subscribeToHostChannel: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  }),
  fetchGracePeriods: vi.fn().mockResolvedValue(undefined),
  getChannelCount: vi.fn().mockReturnValue(1),
}));

function createMockRemote() {
  return {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn(),
    removeAllChannels: vi.fn(),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('reconnect manager', () => {
  it('starts in disconnected state', () => {
    const mgr = createReconnectManager(createMockRemote(), 'host-1', () => false);
    expect(mgr.getState()).toBe('disconnected');
  });

  it('transitions to connected on connect', () => {
    const states: ConnectionState[] = [];
    const mgr = createReconnectManager(
      createMockRemote(),
      'host-1',
      () => false,
      (s) => states.push(s),
    );
    mgr.connect();
    expect(mgr.getState()).toBe('connected');
  });

  it('transitions to disconnected on disconnect', () => {
    const remote = createMockRemote();
    const mgr = createReconnectManager(remote, 'host-1', () => false);
    mgr.connect();
    mgr.disconnect();
    expect(mgr.getState()).toBe('disconnected');
    expect(remote.removeAllChannels).toHaveBeenCalled();
  });

  it('calls onStateChange callback', () => {
    const callback = vi.fn();
    const mgr = createReconnectManager(createMockRemote(), 'host-1', () => false, callback);
    mgr.connect();
    expect(callback).toHaveBeenCalledWith('connected');
    mgr.disconnect();
    expect(callback).toHaveBeenCalledWith('disconnected');
  });
});
