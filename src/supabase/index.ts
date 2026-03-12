import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { hostname, userInfo, platform } from 'node:os';

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
export async function authenticateAnonymous(): Promise<{ userId: string; accessToken: string }> {
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

  // Check for existing host with same fingerprint
  const { data: existing, error: fetchError } = await supabase
    .from('hosts')
    .select('*')
    .eq('host_fingerprint', fp)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to check existing host: ${fetchError.message}`);
  }

  if (existing) {
    // Update host name and last_seen_at
    const { data: updated, error: updateError } = await supabase
      .from('hosts')
      .update({ host_name: hostName, last_seen_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateError) {
      throw new Error(`Failed to update host: ${updateError.message}`);
    }
    return updated as HostRecord;
  }

  // Insert new host
  const { data: inserted, error: insertError } = await supabase
    .from('hosts')
    .insert({
      host_name: hostName,
      host_fingerprint: fp,
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
