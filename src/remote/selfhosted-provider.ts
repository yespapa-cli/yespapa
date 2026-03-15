import type {
  RemoteProvider,
  RemoteSession,
  RemoteSubscription,
  HostRecord,
  CommandUpdate,
  GracePeriodUpdate,
} from './provider.js';

/**
 * RemoteProvider implementation for self-hosted YesPaPa servers.
 * Communicates via REST API + WebSocket (no Supabase dependency).
 */
export class SelfHostedProvider implements RemoteProvider {
  private baseUrl: string;
  private apiKey: string;
  private accessToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, {
    onCommandUpdate?: (update: CommandUpdate) => void;
    onGracePeriodUpdate?: (update: GracePeriodUpdate) => void;
    onStatusChange?: (status: string, error?: Error) => void;
  }>();

  constructor(baseUrl: string, apiKey: string) {
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      h['X-API-Key'] = this.apiKey;
    }
    if (this.accessToken) {
      h['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && this.refreshTokenValue) {
      // Try refresh and retry once
      await this.refreshSession(this.refreshTokenValue);
      const retry = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!retry.ok) {
        throw new Error(`Request failed: ${retry.status} ${retry.statusText}`);
      }
      return retry.json() as Promise<T>;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Auth ──────────────────────────────────────────────────

  async signInAnonymously(): Promise<RemoteSession> {
    const result = await this.request<RemoteSession>('POST', '/api/auth/anonymous');
    this.accessToken = result.accessToken;
    this.refreshTokenValue = result.refreshToken;
    return result;
  }

  async refreshSession(refreshToken: string): Promise<{ userId: string; accessToken: string }> {
    const result = await this.request<{ userId: string; accessToken: string }>(
      'POST',
      '/api/auth/refresh',
      { refreshToken },
    );
    this.accessToken = result.accessToken;
    return result;
  }

  // ── Hosts ─────────────────────────────────────────────────

  async findHostsByFingerprint(fingerprint: string): Promise<HostRecord[]> {
    return this.request<HostRecord[]>('GET', `/api/hosts/by-fingerprint/${encodeURIComponent(fingerprint)}`);
  }

  async getHostById(hostId: string): Promise<HostRecord | null> {
    try {
      return await this.request<HostRecord>('GET', `/api/hosts/${encodeURIComponent(hostId)}`);
    } catch {
      return null;
    }
  }

  async insertHost(data: { host_name: string; host_fingerprint: string }): Promise<HostRecord> {
    return this.request<HostRecord>('POST', '/api/hosts', data);
  }

  async updateHost(
    hostId: string,
    data: Partial<Pick<HostRecord, 'host_name' | 'last_seen_at' | 'push_token'>>,
  ): Promise<HostRecord | null> {
    try {
      return await this.request<HostRecord>('PATCH', `/api/hosts/${encodeURIComponent(hostId)}`, data);
    } catch {
      return null;
    }
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
    await this.request<void>('POST', '/api/commands', record);
  }

  async updateCommand(
    commandId: string,
    data: { status?: string; totp_code?: string; message?: string; resolved_at?: string },
  ): Promise<void> {
    await this.request<void>('PATCH', `/api/commands/${encodeURIComponent(commandId)}`, data);
  }

  // ── Grace Periods ─────────────────────────────────────────

  async fetchGracePeriods(hostId: string): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>(
      'GET',
      `/api/grace-periods?host_id=${encodeURIComponent(hostId)}`,
    );
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
    this.subscriptions.set(hostId, callbacks);

    // Open WebSocket if not already open
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
    }

    // Send subscribe message
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ subscribe: hostId }));
    }

    return {
      unsubscribe: () => {
        this.subscriptions.delete(hostId);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ unsubscribe: hostId }));
        }
        if (this.subscriptions.size === 0) {
          this.ws?.close();
          this.ws = null;
        }
      },
    };
  }

  private connectWebSocket(): void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws');
    const token = this.accessToken ?? '';
    this.ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`);

    this.ws.onopen = () => {
      // Re-subscribe all active subscriptions
      for (const [hostId, cbs] of this.subscriptions) {
        this.ws?.send(JSON.stringify({ subscribe: hostId }));
        cbs.onStatusChange?.('SUBSCRIBED');
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        const hostId = msg.host_id as string;
        const cbs = this.subscriptions.get(hostId);
        if (!cbs) return;

        if (msg.type === 'command_update') {
          cbs.onCommandUpdate?.(msg.data as CommandUpdate);
        } else if (msg.type === 'grace_period_update') {
          cbs.onGracePeriodUpdate?.(msg.data as GracePeriodUpdate);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onerror = (err) => {
      for (const cbs of this.subscriptions.values()) {
        cbs.onStatusChange?.('CHANNEL_ERROR', new Error(String(err)));
      }
    };

    this.ws.onclose = () => {
      for (const cbs of this.subscriptions.values()) {
        cbs.onStatusChange?.('CLOSED');
      }
    };
  }

  // ── Push ──────────────────────────────────────────────────

  async sendPushNotification(record: {
    id: string;
    host_id: string;
    command_display: string;
    justification: string | null;
  }): Promise<void> {
    try {
      await this.request<void>('POST', '/api/push', record);
    } catch {
      // Push is best-effort for self-hosted — may not be configured
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  getActiveSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  removeAllSubscriptions(): void {
    this.subscriptions.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
