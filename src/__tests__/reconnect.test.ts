import { describe, it, expect, vi } from 'vitest';
import { createReconnectManager, type ConnectionState } from '../remote/reconnect.js';
import type { RemoteProvider, RemoteSubscription } from '../remote/provider.js';

// Mock the sync module
vi.mock('../remote/sync.js', () => ({
  subscribeToHostChannel: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
  fetchGracePeriods: vi.fn().mockResolvedValue(undefined),
  getChannelCount: vi.fn().mockReturnValue(1),
}));

function createMockProvider(): RemoteProvider {
  return {
    signInAnonymously: vi.fn(),
    refreshSession: vi.fn(),
    findHostsByFingerprint: vi.fn(),
    getHostById: vi.fn(),
    insertHost: vi.fn(),
    updateHost: vi.fn(),
    insertCommand: vi.fn(),
    updateCommand: vi.fn(),
    fetchGracePeriods: vi.fn(),
    subscribeToHostEvents: vi.fn().mockReturnValue({ unsubscribe: vi.fn() } as RemoteSubscription),
    sendPushNotification: vi.fn(),
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
    removeAllSubscriptions: vi.fn(),
  };
}

describe('reconnect manager', () => {
  it('starts in disconnected state', () => {
    const mgr = createReconnectManager(createMockProvider(), 'host-1', () => false);
    expect(mgr.getState()).toBe('disconnected');
  });

  it('transitions to connected on connect', () => {
    const states: ConnectionState[] = [];
    const mgr = createReconnectManager(
      createMockProvider(),
      'host-1',
      () => false,
      (s) => states.push(s),
    );
    mgr.connect();
    expect(mgr.getState()).toBe('connected');
  });

  it('transitions to disconnected on disconnect', () => {
    const provider = createMockProvider();
    const mgr = createReconnectManager(provider, 'host-1', () => false);
    mgr.connect();
    mgr.disconnect();
    expect(mgr.getState()).toBe('disconnected');
    expect(provider.removeAllSubscriptions).toHaveBeenCalled();
  });

  it('calls onStateChange callback', () => {
    const callback = vi.fn();
    const mgr = createReconnectManager(createMockProvider(), 'host-1', () => false, callback);
    mgr.connect();
    expect(callback).toHaveBeenCalledWith('connected');
    mgr.disconnect();
    expect(callback).toHaveBeenCalledWith('disconnected');
  });
});
