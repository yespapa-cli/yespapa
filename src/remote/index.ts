import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { hostname, userInfo, platform } from 'node:os';
import WebSocket from 'ws';

// Polyfill WebSocket for Node.js — required by the Realtime client
if (typeof globalThis.WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = WebSocket;
}

export interface RemoteConfig {
  url: string;
  anonKey: string;
}

export interface HostRecord {
  id: string;
  user_id: string;
  host_name: string;
  host_fingerprint: string;
  push_token: string | null;
  last_seen_at: string;
  created_at: string;
}

let client: SupabaseClient | null = null;

/**
 * Initialize the remote client. Returns the client instance.
 * Reuses existing client if already initialized with same URL.
 */
export function initializeRemote(url: string, anonKey: string): SupabaseClient {
  if (client) return client;
  client = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
    },
  });
  return client;
}

/**
 * Get the current remote client. Throws if not initialized.
 */
export function getRemoteClient(): SupabaseClient {
  if (!client) {
    throw new Error('Remote client not initialized. Call initializeRemote() first.');
  }
  return client;
}

/**
 * Reset the client (for testing).
 */
export function resetRemoteClient(): void {
  client = null;
}

/**
 * Authenticate anonymously with the remote server.
 * Returns the anonymous user session.
 */
export async function authenticateAnonymous(): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  const remote = getRemoteClient();
  const { data, error } = await remote.auth.signInAnonymously();
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

/**
 * Restore a session using a stored refresh token.
 * This allows the daemon to authenticate as the same user across restarts.
 */
export async function restoreSession(refreshToken: string): Promise<{ userId: string; accessToken: string }> {
  const remote = getRemoteClient();
  const { data, error } = await remote.auth.refreshSession({ refresh_token: refreshToken });
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

/**
 * Generate a unique host fingerprint from machine identifiers.
 * SHA-256 of hostname + username + platform.
 */
export function generateHostFingerprint(): string {
  const parts = [hostname(), userInfo().username, platform()];
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Register a host in the remote `hosts` table.
 * If a host with the same fingerprint exists, returns the existing record.
 */
export async function registerHost(
  hostName: string,
  fingerprint?: string,
): Promise<HostRecord> {
  const remote = getRemoteClient();
  const fp = fingerprint ?? generateHostFingerprint();

  // Try to find an existing host owned by the current user
  const { data: ownedHosts } = await remote
    .from('hosts')
    .select('*')
    .eq('host_fingerprint', fp);

  // Check if any of the returned hosts are owned by us (we can update them)
  if (ownedHosts && ownedHosts.length > 0) {
    // Try updating the first one — will succeed only if we own it (RLS)
    const candidate = ownedHosts[0];
    const { data: updated, error: updateError } = await remote
      .from('hosts')
      .update({ host_name: hostName, last_seen_at: new Date().toISOString() })
      .eq('id', candidate.id)
      .select()
      .maybeSingle();

    if (!updateError && updated) {
      return updated as HostRecord;
    }
    // If update failed (different owner), fall through to insert
  }

  // Insert new host for the current user (new fingerprint or different owner)
  let insertFp = fp;
  if (ownedHosts && ownedHosts.length > 0) {
    insertFp = `${fp}:${Date.now()}`;
  }

  const { data: inserted, error: insertError } = await remote
    .from('hosts')
    .insert({
      host_name: hostName,
      host_fingerprint: insertFp,
      last_seen_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to register host: ${insertError.message}`);
  }
  return inserted as HostRecord;
}

/**
 * Update the host heartbeat timestamp.
 */
export async function updateHeartbeat(hostId: string): Promise<void> {
  const remote = getRemoteClient();
  const { error } = await remote
    .from('hosts')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', hostId);

  if (error) {
    throw new Error(`Failed to update heartbeat: ${error.message}`);
  }
}

/**
 * Get a host by its fingerprint.
 */
export async function getHostByFingerprint(fingerprint: string): Promise<HostRecord | null> {
  const remote = getRemoteClient();
  const { data, error } = await remote
    .from('hosts')
    .select('*')
    .eq('host_fingerprint', fingerprint)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch host: ${error.message}`);
  }
  return data as HostRecord | null;
}
