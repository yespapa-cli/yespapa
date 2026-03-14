import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateQRString } from '../totp/qr.js';

export interface PairingData {
  remote_url: string;
  remote_key: string;
  host_id: string;
  pairing_token: string;
  refresh_token?: string;
}

/**
 * Combined pairing payload — includes TOTP seed so the mobile app
 * can pair AND receive the TOTP secret in a single QR scan.
 */
export interface CombinedPairingData {
  type: 'yespapa';
  totp_seed: string;        // Base32
  host_name: string;
  remote_url: string;
  remote_key: string;
  host_id: string;
  pairing_token: string;
  refresh_token?: string;
}

/**
 * Generate a one-time pairing token (32 random bytes, hex-encoded).
 */
export function generatePairingToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Create the pairing payload for QR encoding.
 */
export function createPairingPayload(
  remoteUrl: string,
  remoteKey: string,
  hostId: string,
  pairingToken: string,
  refreshToken?: string,
): PairingData {
  return {
    remote_url: remoteUrl,
    remote_key: remoteKey,
    host_id: hostId,
    pairing_token: pairingToken,
    refresh_token: refreshToken,
  };
}

/**
 * Generate a QR code for the pairing payload.
 * The QR encodes the JSON payload as a string.
 */
export async function generatePairingQR(payload: PairingData): Promise<string> {
  const jsonStr = JSON.stringify(payload);
  return generateQRString(jsonStr);
}

/**
 * Create a combined pairing payload that includes the TOTP seed.
 * This allows the mobile app to pair and receive the TOTP secret in one scan.
 */
export function createCombinedPayload(
  totpSeed: string,
  hostName: string,
  remoteUrl: string,
  remoteKey: string,
  hostId: string,
  pairingToken: string,
  refreshToken?: string,
): CombinedPairingData {
  return {
    type: 'yespapa',
    totp_seed: totpSeed,
    host_name: hostName,
    remote_url: remoteUrl,
    remote_key: remoteKey,
    host_id: hostId,
    pairing_token: pairingToken,
    refresh_token: refreshToken,
  };
}

/**
 * Generate a QR code for the combined pairing payload.
 */
export async function generateCombinedQR(payload: CombinedPairingData): Promise<string> {
  const jsonStr = JSON.stringify(payload);
  return generateQRString(jsonStr);
}

/**
 * Generate a deep-link pairing URL for the YesPaPa mobile app.
 * Uses `yespapa://pair?data={base64}` custom scheme.
 * The base64 payload contains the same data as CombinedPairingData.
 */
export function generatePairingUrl(payload: CombinedPairingData): string {
  const jsonStr = JSON.stringify(payload);
  const base64 = Buffer.from(jsonStr).toString('base64url');
  return `yespapa://pair?data=${base64}`;
}

/**
 * Generate a HTTPS fallback pairing URL (for universal links / no-app-installed case).
 */
export function generatePairingWebUrl(payload: CombinedPairingData): string {
  const jsonStr = JSON.stringify(payload);
  const base64 = Buffer.from(jsonStr).toString('base64url');
  return `https://yespapa.app/pair?data=${base64}`;
}

/**
 * Store the pairing token in the remote hosts table for validation.
 * The mobile app will present this token when pairing.
 */
export async function storePairingToken(
  remote: SupabaseClient,
  hostId: string,
  pairingToken: string,
): Promise<void> {
  const { error } = await remote
    .from('hosts')
    .update({ push_token: `pairing:${pairingToken}` })
    .eq('id', hostId);

  if (error) {
    throw new Error(`Failed to store pairing token: ${error.message}`);
  }
}

/**
 * Validate and consume a pairing token.
 * Returns true if the token matches, and clears it (one-time use).
 */
export async function consumePairingToken(
  remote: SupabaseClient,
  hostId: string,
  token: string,
): Promise<boolean> {
  const { data, error } = await remote
    .from('hosts')
    .select('push_token')
    .eq('id', hostId)
    .single();

  if (error || !data) return false;

  const storedToken = data.push_token as string | null;
  if (storedToken !== `pairing:${token}`) return false;

  await remote
    .from('hosts')
    .update({ push_token: null })
    .eq('id', hostId);

  return true;
}
