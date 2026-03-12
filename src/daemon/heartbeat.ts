import { isInterceptorInstalled, injectInterceptor } from '../shell/interceptor.js';
import { existsSync } from 'node:fs';
import { SOCKET_PATH } from './socket.js';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

export interface HeartbeatResult {
  interceptorIntact: boolean;
  socketIntact: boolean;
  repaired: boolean;
  timestamp: string;
}

/**
 * Run a single heartbeat check.
 * Returns what was found and whether repairs were made.
 */
export function runHeartbeatCheck(): HeartbeatResult {
  const timestamp = new Date().toISOString();
  let repaired = false;

  // Check interceptor
  const interceptorIntact = isInterceptorInstalled();
  if (!interceptorIntact) {
    console.log(`[YesPaPa] ${timestamp} Tampering detected: interceptor removed. Re-injecting...`);
    injectInterceptor();
    repaired = true;
  }

  // Check socket
  const socketIntact = existsSync(SOCKET_PATH);

  return { interceptorIntact, socketIntact, repaired, timestamp };
}

/**
 * Start the heartbeat loop.
 * Returns a function to stop it.
 */
export function startHeartbeat(
  onTamperDetected?: (result: HeartbeatResult) => void,
): () => void {
  const interval = setInterval(() => {
    const result = runHeartbeatCheck();
    if (result.repaired && onTamperDetected) {
      onTamperDetected(result);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't prevent process exit
  interval.unref();

  return () => clearInterval(interval);
}
