import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { RemoteProvider, RemoteSession, RemoteSubscription, HostRecord, CommandUpdate, GracePeriodUpdate } from './provider.js';

// Polyfill WebSocket for Node.js — required by the Supabase Realtime client
if (typeof globalThis.WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = WebSocket;
}

/**
 * RemoteProvider implementation backed by Supabase.
 * Wraps all @supabase/supabase-js calls — this is the ONLY file that imports Supabase in the core package.
 */
export class SupabaseProvider implements RemoteProvider {
  private client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: false,
      },
    });
  }

  // ── Auth ──────────────────────────────────────────────────

  async signInAnonymously(): Promise<RemoteSession> {
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) {
      throw new Error(`Anonymous auth failed: ${error.message}`);
    }
    if (!data.user || !data.session) {
      throw new Error('Anonymous auth returned no user or session');
    }
    return {
      userId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    };
  }

  async refreshSession(refreshToken: string): Promise<{ userId: string; accessToken: string }> {
    const { data, error } = await this.client.auth.refreshSession({ refresh_token: refreshToken });
    if (error) {
      throw new Error(`Session restore failed: ${error.message}`);
    }
    if (!data.user || !data.session) {
      throw new Error('Session restore returned no user or session');
    }
    return {
      userId: data.user.id,
      accessToken: data.session.access_token,
    };
  }

  // ── Hosts ─────────────────────────────────────────────────

  async findHostsByFingerprint(fingerprint: string): Promise<HostRecord[]> {
    const { data, error } = await this.client
      .from('hosts')
      .select('*')
      .eq('host_fingerprint', fingerprint);

    if (error) {
      throw new Error(`Failed to query hosts: ${error.message}`);
    }
    return (data ?? []) as HostRecord[];
  }

  async getHostById(hostId: string): Promise<HostRecord | null> {
    const { data, error } = await this.client
      .from('hosts')
      .select('*')
      .eq('id', hostId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch host: ${error.message}`);
    }
    return data as HostRecord | null;
  }

  async insertHost(data: { host_name: string; host_fingerprint: string }): Promise<HostRecord> {
    const { data: inserted, error } = await this.client
      .from('hosts')
      .insert({
        host_name: data.host_name,
        host_fingerprint: data.host_fingerprint,
        last_seen_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to insert host: ${error.message}`);
    }
    return inserted as HostRecord;
  }

  async updateHost(
    hostId: string,
    data: Partial<Pick<HostRecord, 'host_name' | 'last_seen_at' | 'push_token'>>,
  ): Promise<HostRecord | null> {
    const { data: updated, error } = await this.client
      .from('hosts')
      .update(data)
      .eq('id', hostId)
      .select()
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update host: ${error.message}`);
    }
    return updated as HostRecord | null;
  }

  // ── Commands ──────────────────────────────────────────────

  async insertCommand(record: {
    id: string;
    host_id: string;
    command_display: string;
    justification: string | null;
    status: string;
    timeout_seconds: number;
  }): Promise<void> {
    const { error } = await this.client.from('commands').insert(record);
    if (error) {
      throw new Error(`Remote insert failed: ${error.message} (code: ${error.code})`);
    }
  }

  async updateCommand(
    commandId: string,
    data: { status?: string; totp_code?: string; message?: string; resolved_at?: string },
  ): Promise<void> {
    const { error } = await this.client
      .from('commands')
      .update(data)
      .eq('id', commandId);

    if (error) {
      throw new Error(`Failed to update command: ${error.message}`);
    }
  }

  // ── Grace Periods ─────────────────────────────────────────

  async fetchGracePeriods(hostId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from('grace_periods')
      .select('*')
      .eq('host_id', hostId);

    if (error) {
      throw new Error(`Failed to fetch grace periods: ${error.message}`);
    }
    return (data ?? []) as Record<string, unknown>[];
  }

  // ── Realtime ──────────────────────────────────────────────

  subscribeToHostEvents(
    hostId: string,
    callbacks: {
      onCommandUpdate?: (update: CommandUpdate) => void;
      onGracePeriodUpdate?: (update: GracePeriodUpdate) => void;
      onStatusChange?: (status: string, error?: Error) => void;
    },
  ): RemoteSubscription {
    const channel: RealtimeChannel = this.client
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
          callbacks.onCommandUpdate?.({
            id: row.id as string,
            status: row.status as string,
            totp_code: row.totp_code as string | undefined,
            message: row.message as string | undefined,
          });
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
          const row = payload.new as Record<string, unknown>;
          callbacks.onGracePeriodUpdate?.(row as GracePeriodUpdate);
        },
      )
      .subscribe((status, err) => {
        callbacks.onStatusChange?.(status, err ? new Error(err.message) : undefined);
      });

    return {
      unsubscribe: () => {
        this.client.removeChannel(channel);
      },
    };
  }

  // ── Push ──────────────────────────────────────────────────

  async sendPushNotification(record: {
    id: string;
    host_id: string;
    command_display: string;
    justification: string | null;
  }): Promise<void> {
    const { error } = await this.client.functions.invoke('push_notification', {
      body: { type: 'INSERT', table: 'commands', record },
    });

    if (error) {
      throw new Error(`Push notification failed: ${error.message}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  getActiveSubscriptionCount(): number {
    return this.client.getChannels().length;
  }

  removeAllSubscriptions(): void {
    this.client.removeAllChannels();
  }
}
