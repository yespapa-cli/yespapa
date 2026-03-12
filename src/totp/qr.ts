import QRCode from 'qrcode';
import { generateOtpauthUri } from './index.js';

/**
 * Display a TOTP QR code in the terminal.
 * Falls back to printing the base32 seed as text.
 */
export async function displayTotpQR(seed: string, hostName: string): Promise<void> {
  const uri = generateOtpauthUri(seed, hostName);

  try {
    const qrText = await QRCode.toString(uri, { type: 'terminal', small: true });
    console.log('\nScan this QR code with your authenticator app:\n');
    console.log(qrText);
  } catch {
    console.log('\n(QR code could not be rendered in this terminal)');
  }

  // Always show the manual entry fallback
  console.log(`\nManual entry — Secret: ${seed}`);
  console.log(`Account: YesPaPa:${hostName}\n`);
}

/**
 * Generate QR code as a UTF-8 string (for testing or alternative display).
 */
export async function generateQRString(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'terminal', small: true });
}
