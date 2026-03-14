import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { setRemoteResolution, type TotpValidator } from '../daemon/socket.js';

export interface SyncConfig {
  client: SupabaseClient;
  hostId: string;
  validateTotp: TotpValidator;
  onCommandResolved?: (commandId: string, status: string, message?: string) => void;
  log?: (msg: string) => void;
}

let channel: RealtimeChannel | null = null;
let syncLog: ((msg: string) => void) | undefined;

// ── Rate limiter ────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const pushTimestamps: number[] = [];
const pushQueue: Array<() => Promise<void>> = [];
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function isRateLimited(): boolean {
  const now = Date.now();
  while (pushTimestamps.length > 0 && pushTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    pushTimestamps.shift();
  }
  return pushTimestamps.length >= RATE_LIMIT_MAX;
}

function drainQueue(): void {
  if (drainTimer) return;
  if (pushQueue.length === 0) return;
  if (isRateLimited()) {
    const waitMs = pushTimestamps[0] + RATE_LIMIT_WINDOW_MS - Date.now() + 100;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drainQueue();
    }, Math.max(waitMs, 500));
    return;
  }
  const next = pushQueue.shift();
  if (next) {
    pushTimestamps.push(Date.now());
    next().catch(() => {}).finally(() => drainQueue());
  }
}

/** Number of active Realtime channels. */
export function getChannelCount(remote: SupabaseClient): number {
  return remote.getChannels().length;
}

/**
 * Push a pending command to the remote `commands` table,
 * then invoke the push_notification Edge Function directly.
 * Rate-limited to max 10 commands/minute per host — excess is queued.
 */
export async function pushCommand(
  remote: SupabaseClient,
  hostId: string,
  commandId: string,
  commandDisplay: string,
  justification?: string,
  timeoutSeconds?: number,
): Promise<void> {
  const doPush = async () => {
    const record = {
      id: commandId,
      host_id: hostId,
      command_display: commandDisplay,
      justification: justification ?? null,
      status: 'pending',
      timeout_seconds: timeoutSeconds ?? 0,
    };

    const { error } = await remote.from('commands').insert(record);

    if (error) {
      throw new Error(`Remote insert failed: ${error.message} (code: ${error.code})`);
    }

    // Fire push notification via Edge Function (non-blocking, best-effort)
    sendPushNotification(remote, record).catch((err) => {
      syncLog?.(`Push notification error: ${err}`);
    });
  };

  if (isRateLimited()) {
    syncLog?.(`Rate limited: queuing command ${commandId} (${pushQueue.length + 1} in queue)`);
    pushQueue.push(doPush);
    drainQueue();
    return;
  }

  pushTimestamps.push(Date.now());
  await doPush();
}

/**
 * Call the push_notification Edge Function directly.
 */
async function sendPushNotification(
  remote: SupabaseClient,
  record: { id: string; host_id: string; command_display: string; justification: string | null },
): Promise<void> {
  const { data, error } = await remote.functions.invoke('push_notification', {
    body: { type: 'INSERT', table: 'commands', record },
  });

  if (error) {
    syncLog?.(`Push notification failed: ${error.message}`);
  } else {
    syncLog?.(`Push notification sent: ${JSON.stringify(data)}`);
  }
}

/**
 * Subscribe to Realtime updates on the `commands` table for this host.
 * When an approval/denial arrives from the mobile app, validate TOTP (for approvals)
 * and set the remote resolution so the poll-check handler can pick it up.
 */
export function subscribeToApprovals(config: SyncConfig): RealtimeChannel {
  const { client: remote, hostId, validateTotp, onCommandResolved, log } = config;
  syncLog = log;

  if (channel) {
    remote.removeChannel(channel);
    channel = null;
  }

  channel = remote
    .channel(`commands:host_id=eq.${hostId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'commands',
        filter: `host_id=eq.${hostId}`,
      },
      (payload) => {
        const row = payload.new as Record<string, unknown>;
        const commandId = row.id as string;
        const status = row.status as string;
        const totpCode = row.totp_code as string | undefined;
        const message = row.message as string | undefined;

        syncLog?.(`Realtime UPDATE received: ${commandId} → ${status}`);

        if (status === 'approved') {
          if (!totpCode || !validateTotp(totpCode)) {
            syncLog?.(`Ignoring remote approval for ${commandId}: invalid TOTP (code=${totpCode ? 'present' : 'missing'})`);
            return;
          }
          setRemoteResolution(commandId, {
            status: 'approved',
            message,
            source: 'app_approve',
          });
          onCommandResolved?.(commandId, 'approved', message);
        } else if (status === 'denied') {
          setRemoteResolution(commandId, {
            status: 'denied',
            message,
            source: 'app_approve',
          });
          onCommandResolved?.(commandId, 'denied', message);
        }
      },
    )
    .subscribe((status, err) => {
      syncLog?.(`Realtime subscription status: ${status}${err ? ` (error: ${err.message})` : ''}`);
    });

  return channel;
}

/**
 * Subscribe to Realtime updates on the `grace_periods` table for this host.
 */
export function subscribeToGracePeriods(
  remote: SupabaseClient,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
): RealtimeChannel {
  return remote
    .channel(`grace_periods:host_id=eq.${hostId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'grace_periods',
        filter: `host_id=eq.${hostId}`,
      },
      (payload) => {
        onGracePeriod?.(payload.new as Record<string, unknown>);
      },
    )
    .subscribe();
}

/**
 * Subscribe to BOTH commands and grace_periods on a single consolidated channel.
 * Uses one Realtime connection per host instead of two, reducing connection usage.
 */
export function subscribeToHostChannel(
  config: SyncConfig,
  onGracePeriod?: (data: Record<string, unknown>) => void,
): RealtimeChannel {
  const { client: remote, hostId, validateTotp, onCommandResolved, log } = config;
  syncLog = log;

  if (channel) {
    remote.removeChannel(channel);
    channel = null;
  }

  channel = remote
    .channel(`host:${hostId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'commands',
        filter: `host_id=eq.${hostId}`,
      },
      (payload) => {
        const row = payload.new as Record<string, unknown>;
        const commandId = row.id as string;
        const status = row.status as string;
        const totpCode = row.totp_code as string | undefined;
        const message = row.message as string | undefined;

        syncLog?.(`Realtime UPDATE received: ${commandId} → ${status}`);

        if (status === 'approved') {
          if (!totpCode || !validateTotp(totpCode)) {
            syncLog?.(`Ignoring remote approval for ${commandId}: invalid TOTP`);
            return;
          }
          setRemoteResolution(commandId, { status: 'approved', message, source: 'app_approve' });
          onCommandResolved?.(commandId, 'approved', message);
        } else if (status === 'denied') {
          setRemoteResolution(commandId, { status: 'denied', message, source: 'app_approve' });
          onCommandResolved?.(commandId, 'denied', message);
        }
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'grace_periods',
        filter: `host_id=eq.${hostId}`,
      },
      (payload) => {
        onGracePeriod?.(payload.new as Record<string, unknown>);
      },
    )
    .subscribe((status, err) => {
      syncLog?.(`Realtime subscription status: ${status}${err ? ` (error: ${err.message})` : ''}`);
    });

  return channel;
}

/**
 * Update a command's status on the remote server (for syncing locally-resolved commands).
 */
export async function syncCommandResolution(
  remote: SupabaseClient,
  commandId: string,
  status: string,
  approvalSource?: string,
): Promise<void> {
  const { error } = await remote
    .from('commands')
    .update({
      status,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', commandId);

  if (error) {
    console.error(`[YesPaPa] Failed to sync command resolution to remote: ${error.message}`);
  }
}

/**
 * Fetch all grace periods for this host from remote and sync to local DB.
 * Catches up on any missed Realtime events (e.g. revocations during disconnection).
 */
export async function fetchGracePeriods(
  remote: SupabaseClient,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
  log?: (msg: string) => void,
): Promise<void> {
  const { data, error } = await remote
    .from('grace_periods')
    .select('*')
    .eq('host_id', hostId);

  if (error) {
    log?.(`Failed to fetch grace periods: ${error.message}`);
    return;
  }

  if (data) {
    for (const row of data) {
      onGracePeriod?.(row as Record<string, unknown>);
    }
    log?.(`Synced ${data.length} grace period(s) from remote`);
  }
}

/**
 * Unsubscribe from all channels.
 */
export function unsubscribeAll(remote: SupabaseClient): void {
  remote.removeAllChannels();
  channel = null;
}
