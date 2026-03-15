import type { RemoteProvider, RemoteSubscription } from './provider.js';
import { setRemoteResolution, type TotpValidator } from '../daemon/socket.js';

export interface SyncConfig {
  client: RemoteProvider;
  hostId: string;
  validateTotp: TotpValidator;
  onCommandResolved?: (commandId: string, status: string, message?: string) => void;
  log?: (msg: string) => void;
}

let subscription: RemoteSubscription | null = null;
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

/** Number of active Realtime subscriptions. */
export function getChannelCount(remote: RemoteProvider): number {
  return remote.getActiveSubscriptionCount();
}

/**
 * Push a pending command to the remote `commands` table,
 * then send a push notification.
 * Rate-limited to max 10 commands/minute per host — excess is queued.
 */
export async function pushCommand(
  remote: RemoteProvider,
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

    await remote.insertCommand(record);

    // Fire push notification (non-blocking, best-effort)
    remote.sendPushNotification(record).catch((err) => {
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
 * Subscribe to Realtime updates on the `commands` table for this host.
 * When an approval/denial arrives from the mobile app, validate TOTP (for approvals)
 * and set the remote resolution so the poll-check handler can pick it up.
 */
export function subscribeToApprovals(config: SyncConfig): RemoteSubscription {
  const { client: remote, hostId, validateTotp, onCommandResolved, log } = config;
  syncLog = log;

  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
  }

  subscription = remote.subscribeToHostEvents(hostId, {
    onCommandUpdate: (update) => {
      const { id: commandId, status, totp_code: totpCode, message } = update;

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
    onStatusChange: (status, err) => {
      syncLog?.(`Realtime subscription status: ${status}${err ? ` (error: ${err.message})` : ''}`);
    },
  });

  return subscription;
}

/**
 * Subscribe to Realtime updates on the `grace_periods` table for this host.
 */
export function subscribeToGracePeriods(
  remote: RemoteProvider,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
): RemoteSubscription {
  return remote.subscribeToHostEvents(hostId, {
    onGracePeriodUpdate: (data) => {
      onGracePeriod?.(data);
    },
  });
}

/**
 * Subscribe to BOTH commands and grace_periods on a single consolidated subscription.
 */
export function subscribeToHostChannel(
  config: SyncConfig,
  onGracePeriod?: (data: Record<string, unknown>) => void,
): RemoteSubscription {
  const { client: remote, hostId, validateTotp, onCommandResolved, log } = config;
  syncLog = log;

  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
  }

  subscription = remote.subscribeToHostEvents(hostId, {
    onCommandUpdate: (update) => {
      const { id: commandId, status, totp_code: totpCode, message } = update;

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
    onGracePeriodUpdate: (data) => {
      onGracePeriod?.(data);
    },
    onStatusChange: (status, err) => {
      syncLog?.(`Realtime subscription status: ${status}${err ? ` (error: ${err.message})` : ''}`);
    },
  });

  return subscription;
}

/**
 * Update a command's status on the remote server (for syncing locally-resolved commands).
 */
export async function syncCommandResolution(
  remote: RemoteProvider,
  commandId: string,
  status: string,
  _approvalSource?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<void> {
  try {
    await remote.updateCommand(commandId, {
      status,
      resolved_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[YesPaPa] Failed to sync command resolution to remote: ${err}`);
  }
}

/**
 * Fetch all grace periods for this host from remote and sync to local DB.
 * Catches up on any missed Realtime events (e.g. revocations during disconnection).
 */
export async function fetchGracePeriods(
  remote: RemoteProvider,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    const data = await remote.fetchGracePeriods(hostId);
    for (const row of data) {
      onGracePeriod?.(row);
    }
    log?.(`Synced ${data.length} grace period(s) from remote`);
  } catch (err) {
    log?.(`Failed to fetch grace periods: ${err}`);
  }
}

/**
 * Unsubscribe from all subscriptions.
 */
export function unsubscribeAll(remote: RemoteProvider): void {
  remote.removeAllSubscriptions();
  subscription = null;
}
