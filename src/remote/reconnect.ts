import type { SupabaseClient } from '@supabase/supabase-js';
import { subscribeToHostChannel, fetchGracePeriods, getChannelCount, type SyncConfig } from './sync.js';
import type { TotpValidator } from '../daemon/socket.js';

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export interface ReconnectManager {
  getState: () => ConnectionState;
  getChannelCount: () => number;
  connect: () => void;
  disconnect: () => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Create a reconnection manager with exponential backoff.
 * Handles Realtime subscriptions with automatic reconnection.
 */
export function createReconnectManager(
  remote: SupabaseClient,
  hostId: string,
  validateTotp: TotpValidator,
  onStateChange?: (state: ConnectionState) => void,
  onCommandResolved?: (commandId: string, status: string, message?: string) => void,
  onGracePeriod?: (data: Record<string, unknown>) => void,
  onLog?: (msg: string) => void,
): ReconnectManager {
  let state: ConnectionState = 'disconnected';
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(newState: ConnectionState): void {
    state = newState;
    onStateChange?.(newState);
  }

  function getBackoffMs(): number {
    const ms = Math.min(BACKOFF_BASE_MS * Math.pow(2, retryCount), BACKOFF_MAX_MS);
    return ms;
  }

  function connect(): void {
    try {
      const syncConfig: SyncConfig = {
        client: remote,
        hostId,
        validateTotp,
        onCommandResolved,
        log: onLog,
      };

      subscribeToHostChannel(syncConfig, onGracePeriod);
      fetchGracePeriods(remote, hostId, onGracePeriod, onLog).catch(() => {});

      setState('connected');
      retryCount = 0;
    } catch (error) {
      console.error('[YesPaPa] Remote connection failed:', error);
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (retryTimer) return;

    setState('reconnecting');
    const delay = getBackoffMs();
    retryCount++;
    console.log(`[YesPaPa] Reconnecting in ${delay}ms (attempt ${retryCount})...`);

    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function disconnect(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    remote.removeAllChannels();
    setState('disconnected');
    retryCount = 0;
  }

  return {
    getState: () => state,
    getChannelCount: () => getChannelCount(remote),
    connect,
    disconnect,
  };
}
