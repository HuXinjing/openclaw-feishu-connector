/**
 * PlanC Feishu Connector Admin API SDK
 */
export interface ConnectorConfig {
  baseUrl: string;
  token: string;
}

export interface UserRecord {
  id: number;
  spec: {
    feishuOpenId: string;
    userName?: string;
    hooksToken: string;
    tenantKey?: string;
    permissions?: string[];
    poolStrategy?: 'on-demand' | 'warm' | 'cold';
    channelPolicy?: {
      dmPolicy: string;
      groupPolicy: string;
      allowFrom: string[];
      groupAllowFrom: string[];
      requireMention: boolean;
    };
  };
  status: {
    phase: string;
    containerId?: string;
    gatewayAuthToken?: string;
    gatewayUrl?: string;
    port?: number;
    retryCount?: number;
    lastError?: string;
  };
  createdAt: number;
  updatedAt: number;
  lastActive?: number;
}

export interface HealthStatus {
  ok: boolean;
  docker: boolean;
  db: boolean;
  timestamp?: number;
}

export interface DLQStats {
  total: number;
  pending: number;
  resolved: number;
}

export interface DLQEntry {
  id: number;
  eventId: string;
  openId: string;
  message: string;
  error?: string;
  retryCount: number;
  createdAt: number;
  lastRetryAt?: number;
  resolvedAt?: number;
}

export class ConnectorClient {
  constructor(private config: ConnectorConfig) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async login(baseUrl: string, username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);
    const data = await res.json() as { token: string; expiresIn: string };
    return data.token;
  }

  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/healthz');
  }

  async getReadiness(): Promise<{ ok: boolean; activeUsers?: number; reason?: string }> {
    return this.request('/healthz/ready');
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.request<UserRecord[]>('/api/admin/users');
  }

  async getUser(openId: string): Promise<UserRecord> {
    return this.request<UserRecord>(`/api/admin/users/${openId}`);
  }

  async createUser(feishuOpenId: string, userName?: string, autoStart = false): Promise<{ success: boolean; user: Partial<UserRecord> }> {
    return this.request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ feishuOpenId, userName, auto_start: autoStart }),
    });
  }

  async deleteUser(openId: string): Promise<{ success: boolean }> {
    return this.request(`/api/admin/users/${openId}`, { method: 'DELETE' });
  }

  async startContainer(openId: string): Promise<{ success: boolean }> {
    return this.request(`/api/admin/users/${openId}/start`, { method: 'POST' });
  }

  async stopContainer(openId: string): Promise<{ success: boolean }> {
    return this.request(`/api/admin/users/${openId}/stop`, { method: 'POST' });
  }

  async getDLQ(): Promise<{ entries: DLQEntry[]; stats: DLQStats }> {
    return this.request('/api/admin/dlq');
  }

  async resolveDLQ(id: number): Promise<{ success: boolean }> {
    return this.request(`/api/admin/dlq/${id}/resolve`, { method: 'POST' });
  }

  async listContainers(): Promise<unknown[]> {
    return this.request('/api/admin/containers');
  }
}
