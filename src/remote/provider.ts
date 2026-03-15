/**
 * RemoteProvider — backend-agnostic interface for all remote server operations.
 *
 * Both SupabaseProvider and SelfHostedProvider implement this interface,
 * allowing the daemon and CLI to work with any backend transparently.
 */

// ── Subscription handle (replaces RealtimeChannel) ────────────

export interface RemoteSubscription {
  unsubscribe(): void;
}

// ── Auth ──────────────────────────────────────────────────────

export interface RemoteSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

// ── Realtime event payloads ───────────────────────────────────

export interface CommandUpdate {
  id: string;
  status: string;
  totp_code?: string;
  message?: string;
}

export interface GracePeriodUpdate {
  [key: string]: unknown;
  id: string;
  scope: string;
  expires_at: string;
  hmac_signature: string;
}

// ── Data records ──────────────────────────────────────────────

export interface HostRecord {
  id: string;
  user_id: string;
  host_name: string;
  host_fingerprint: string;
  push_token: string | null;
  last_seen_at: string;
  created_at: string;
}

// ── Provider interface ────────────────────────────────────────

export interface RemoteProvider {
  // Auth
  signInAnonymously(): Promise<RemoteSession>;
  refreshSession(refreshToken: string): Promise<{ userId: string; accessToken: string }>;

  // Hosts
  findHostsByFingerprint(fingerprint: string): Promise<HostRecord[]>;
  getHostById(hostId: string): Promise<HostRecord | null>;
  insertHost(data: { host_name: string; host_fingerprint: string }): Promise<HostRecord>;
  updateHost(
    hostId: string,
    data: Partial<Pick<HostRecord, 'host_name' | 'last_seen_at' | 'push_token'>>,
  ): Promise<HostRecord | null>;

  // Commands
  insertCommand(record: {
    id: string;
    host_id: string;
    command_display: string;
    justification: string | null;
    status: string;
    timeout_seconds: number;
  }): Promise<void>;
  updateCommand(
    commandId: string,
    data: { status?: string; totp_code?: string; message?: string; resolved_at?: string },
  ): Promise<void>;

  // Grace Periods
  fetchGracePeriods(hostId: string): Promise<Record<string, unknown>[]>;

  // Realtime
  subscribeToHostEvents(
    hostId: string,
    callbacks: {
      onCommandUpdate?: (update: CommandUpdate) => void;
      onGracePeriodUpdate?: (update: GracePeriodUpdate) => void;
      onStatusChange?: (status: string, error?: Error) => void;
    },
  ): RemoteSubscription;

  // Push
  sendPushNotification(record: {
    id: string;
    host_id: string;
    command_display: string;
    justification: string | null;
  }): Promise<void>;

  // Lifecycle
  getActiveSubscriptionCount(): number;
  removeAllSubscriptions(): void;
}
