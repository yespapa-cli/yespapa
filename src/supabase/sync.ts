import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { setRemoteResolution, type TotpValidator } from '../daemon/socket.js';

export interface SyncConfig {
  supabase: SupabaseClient;
  hostId: string;
  validateTotp: TotpValidator;
  onCommandResolved?: (commandId: string, status: string, message?: string) => void;
  log?: (msg: string) => void;
}

let channel: RealtimeChannel | null = null;
let syncLog: ((msg: string) => void) | undefined;

/**
 * Push a pending command to the Supabase `commands` table,
 * then invoke the push_notification Edge Function directly.
 */
export async function pushCommand(
  supabase: SupabaseClient,
  hostId: string,
  commandId: string,
  commandDisplay: string,
  justification?: string,
  timeoutSeconds?: number,
): Promise<void> {
  const record = {
    id: commandId,
    host_id: hostId,
    command_display: commandDisplay,
    justification: justification ?? null,
    status: 'pending',
    timeout_seconds: timeoutSeconds ?? 0,
  };

  const { error } = await supabase.from('commands').insert(record);

  if (error) {
    throw new Error(`Supabase insert failed: ${error.message} (code: ${error.code})`);
  }

  // Fire push notification via Edge Function (non-blocking, best-effort)
  sendPushNotification(supabase, record).catch((err) => {
    syncLog?.(`Push notification error: ${err}`);
  });
}

/**
 * Call the push_notification Edge Function directly.
 * This avoids needing a database webhook trigger.
 */
async function sendPushNotification(
  supabase: SupabaseClient,
  record: { id: string; host_id: string; command_display: string; justification: string | null },
): Promise<void> {
  const { data, error } = await supabase.functions.invoke('push_notification', {
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
  const { supabase, hostId, validateTotp, onCommandResolved, log } = config;
  syncLog = log;

  // Unsubscribe from previous channel if any
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }

  channel = supabase
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
          // Validate TOTP — the app must have sent a valid code
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
  supabase: SupabaseClient,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
): RealtimeChannel {
  return supabase
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
 * Update a command's status in Supabase (for syncing locally-resolved commands).
 */
export async function syncCommandResolution(
  supabase: SupabaseClient,
  commandId: string,
  status: string,
  approvalSource?: string,
): Promise<void> {
  const { error } = await supabase
    .from('commands')
    .update({
      status,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', commandId);

  if (error) {
    console.error(`[YesPaPa] Failed to sync command resolution to Supabase: ${error.message}`);
  }
}

/**
 * Fetch all grace periods for this host from Supabase and sync to local DB.
 * Catches up on any missed Realtime events (e.g. revocations during disconnection).
 */
export async function fetchGracePeriods(
  supabase: SupabaseClient,
  hostId: string,
  onGracePeriod?: (data: Record<string, unknown>) => void,
  log?: (msg: string) => void,
): Promise<void> {
  const { data, error } = await supabase
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
export function unsubscribeAll(supabase: SupabaseClient): void {
  supabase.removeAllChannels();
  channel = null;
}
