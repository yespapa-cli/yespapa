import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { hostname, userInfo, platform } from 'node:os';
import WebSocket from 'ws';

// Polyfill WebSocket for Node.js — required by Supabase Realtime
if (typeof globalThis.WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = WebSocket;
}

export interface SupabaseConfig {
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
 * Initialize the Supabase client. Returns the client instance.
 * Reuses existing client if already initialized with same URL.
 */
export function initializeSupabase(url: string, anonKey: string): SupabaseClient {
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
 * Get the current Supabase client. Throws if not initialized.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    throw new Error('Supabase client not initialized. Call initializeSupabase() first.');
  }
  return client;
}

/**
 * Reset the client (for testing).
 */
export function resetSupabaseClient(): void {
  client = null;
}

/**
 * Authenticate anonymously with Supabase.
 * Returns the anonymous user session.
 */
export async function authenticateAnonymous(): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInAnonymously();
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
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
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
 * Register a host in the Supabase `hosts` table.
 * If a host with the same fingerprint exists, returns the existing record.
 */
export async function registerHost(
  hostName: string,
  fingerprint?: string,
): Promise<HostRecord> {
  const supabase = getSupabaseClient();
  const fp = fingerprint ?? generateHostFingerprint();

  // Try to find an existing host owned by the current user
  const { data: ownedHosts } = await supabase
    .from('hosts')
    .select('*')
    .eq('host_fingerprint', fp);

  // Check if any of the returned hosts are owned by us (we can update them)
  if (ownedHosts && ownedHosts.length > 0) {
    // Try updating the first one — will succeed only if we own it (RLS)
    const candidate = ownedHosts[0];
    const { data: updated, error: updateError } = await supabase
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
  // Use a unique fingerprint suffix if the base fingerprint is taken by another user
  let insertFp = fp;
  if (ownedHosts && ownedHosts.length > 0) {
    // Fingerprint exists but owned by another user — append timestamp to make unique
    insertFp = `${fp}:${Date.now()}`;
  }

  const { data: inserted, error: insertError } = await supabase
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
  const supabase = getSupabaseClient();
  const { error } = await supabase
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
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('hosts')
    .select('*')
    .eq('host_fingerprint', fingerprint)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch host: ${error.message}`);
  }
  return data as HostRecord | null;
}
