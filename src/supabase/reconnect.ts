import type { SupabaseClient } from '@supabase/supabase-js';
import { subscribeToApprovals, subscribeToGracePeriods, fetchGracePeriods, type SyncConfig } from './sync.js';
import type { TotpValidator } from '../daemon/socket.js';

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export interface ReconnectManager {
  getState: () => ConnectionState;
  connect: () => void;
  disconnect: () => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Create a reconnection manager with exponential backoff.
 * Handles Supabase Realtime subscriptions with automatic reconnection.
 */
export function createReconnectManager(
  supabase: SupabaseClient,
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
        supabase,
        hostId,
        validateTotp,
        onCommandResolved,
        log: onLog,
      };

      const commandsChannel = subscribeToApprovals(syncConfig);
      const graceChannel = subscribeToGracePeriods(supabase, hostId, onGracePeriod);

      // Catch up on any missed grace period changes (e.g. revocations during disconnect)
      fetchGracePeriods(supabase, hostId, onGracePeriod, onLog).catch(() => {});

      setState('connected');
      retryCount = 0;
    } catch (error) {
      console.error('[YesPaPa] Supabase connection failed:', error);
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
    supabase.removeAllChannels();
    setState('disconnected');
    retryCount = 0;
  }

  return {
    getState: () => state,
    connect,
    disconnect,
  };
}
