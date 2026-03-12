import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateQRString } from '../totp/qr.js';

export interface PairingData {
  supabase_url: string;
  supabase_anon_key: string;
  host_id: string;
  pairing_token: string;
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
  supabaseUrl: string,
  supabaseAnonKey: string,
  hostId: string,
  pairingToken: string,
): PairingData {
  return {
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
    host_id: hostId,
    pairing_token: pairingToken,
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
 * Store the pairing token in Supabase hosts table for validation.
 * The mobile app will present this token when pairing.
 */
export async function storePairingToken(
  supabase: SupabaseClient,
  hostId: string,
  pairingToken: string,
): Promise<void> {
  // Store the pairing token temporarily — it will be cleared after use
  // We use a metadata column or a separate pairing_tokens approach
  // For MVP, we store it as push_token temporarily (will be replaced by real push token)
  const { error } = await supabase
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
  supabase: SupabaseClient,
  hostId: string,
  token: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('hosts')
    .select('push_token')
    .eq('id', hostId)
    .single();

  if (error || !data) return false;

  const storedToken = data.push_token as string | null;
  if (storedToken !== `pairing:${token}`) return false;

  // Clear the pairing token (consumed)
  await supabase
    .from('hosts')
    .update({ push_token: null })
    .eq('id', hostId);

  return true;
}
