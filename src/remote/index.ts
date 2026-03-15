import { createHash } from 'node:crypto';
import { hostname, userInfo, platform } from 'node:os';
import type { RemoteProvider } from './provider.js';
import { createRemoteProvider, type RemoteProviderType } from './factory.js';

export type { HostRecord } from './provider.js';
export type { RemoteProvider } from './provider.js';
export type { RemoteProviderType } from './factory.js';

export interface RemoteConfig {
  url: string;
  anonKey: string;
}

let provider: RemoteProvider | null = null;

/**
 * Initialize the remote provider. Returns the provider instance.
 * Reuses existing provider if already initialized.
 */
export async function initializeRemote(url: string, key: string, type?: RemoteProviderType): Promise<RemoteProvider> {
  if (provider) return provider;
  provider = await createRemoteProvider(type ?? 'supabase', url, key);
  return provider;
}

/**
 * Get the current remote provider. Throws if not initialized.
 */
export function getRemoteProvider(): RemoteProvider {
  if (!provider) {
    throw new Error('Remote provider not initialized. Call initializeRemote() first.');
  }
  return provider;
}

/**
 * Reset the provider (for testing).
 */
export function resetRemoteClient(): void {
  provider = null;
}

/**
 * Authenticate anonymously with the remote server.
 * Returns the anonymous user session.
 */
export async function authenticateAnonymous(): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  return getRemoteProvider().signInAnonymously();
}

/**
 * Restore a session using a stored refresh token.
 * This allows the daemon to authenticate as the same user across restarts.
 */
export async function restoreSession(refreshToken: string): Promise<{ userId: string; accessToken: string }> {
  return getRemoteProvider().refreshSession(refreshToken);
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
 * Register a host with the remote server.
 * If a host with the same fingerprint exists, returns the existing record.
 */
export async function registerHost(
  hostName: string,
  fingerprint?: string,
): Promise<import('./provider.js').HostRecord> {
  const remote = getRemoteProvider();
  const fp = fingerprint ?? generateHostFingerprint();

  // Try to find an existing host owned by the current user
  const ownedHosts = await remote.findHostsByFingerprint(fp);

  // Check if any of the returned hosts are owned by us (we can update them)
  if (ownedHosts.length > 0) {
    // Try updating the first one — will succeed only if we own it (RLS)
    const candidate = ownedHosts[0];
    const updated = await remote.updateHost(candidate.id, {
      host_name: hostName,
      last_seen_at: new Date().toISOString(),
    });

    if (updated) {
      return updated;
    }
    // If update failed (different owner), fall through to insert
  }

  // Insert new host for the current user (new fingerprint or different owner)
  let insertFp = fp;
  if (ownedHosts.length > 0) {
    insertFp = `${fp}:${Date.now()}`;
  }

  return remote.insertHost({
    host_name: hostName,
    host_fingerprint: insertFp,
  });
}

/**
 * Update the host heartbeat timestamp.
 */
export async function updateHeartbeat(hostId: string): Promise<void> {
  const remote = getRemoteProvider();
  const result = await remote.updateHost(hostId, { last_seen_at: new Date().toISOString() });
  if (!result) {
    throw new Error('Failed to update heartbeat: host not found or not owned');
  }
}

/**
 * Get a host by its fingerprint.
 */
export async function getHostByFingerprint(fingerprint: string): Promise<import('./provider.js').HostRecord | null> {
  const remote = getRemoteProvider();
  const hosts = await remote.findHostsByFingerprint(fingerprint);
  return hosts.length > 0 ? hosts[0] : null;
}
