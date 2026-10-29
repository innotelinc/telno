import type {
  AdaptorOverview,
  CantusRouteDecision,
  CantusStatus,
  Device,
  DeviceConfig,
  DirectoryEntry,
  Line,
  ModelKey,
  Overview,
  PathProbeResult,
  PlatformEvent,
  ProvisioningProfileSummary,
  RoutingDocument,
  SessionUser,
  Settings,
} from '@telno/shared';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ??
      (res.status === 401 ? 'Please sign in again.' : `Request failed (${res.status}).`);
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  session: () => request<{ user: SessionUser }>('/api/auth/session'),
  login: (username: string, password: string) =>
    post<{ user: SessionUser }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  changePassword: (current: string, next: string) =>
    post<{ ok: true }>('/api/auth/password', { current, next }),

  overview: () => request<Overview>('/api/overview'),

  devices: () => request<{ devices: Device[] }>('/api/devices'),
  createDevice: (body: { model: ModelKey; label: string; location?: string; serial?: string; mac?: string }) =>
    post<{ device: Device; enrollment: { code: string; expiresAt: string } | null }>('/api/devices', body),
  updateDevice: (id: string, body: Partial<Pick<Device, 'label' | 'location' | 'status'>>) =>
    patch<{ device: Device }>(`/api/devices/${id}`, body),
  deleteDevice: (id: string) => del<{ ok: true }>(`/api/devices/${id}`),
  reconfigure: (id: string) =>
    post<{ device: Device; config: DeviceConfig }>(`/api/devices/${id}/reconfigure`),
  rotateToken: (id: string) => post<{ token: string; device: Device }>(`/api/devices/${id}/rotate-token`),
  deviceConfig: (id: string) => request<{ config: DeviceConfig; etag: string }>(`/api/devices/${id}/config`),
  verifyConfig: (id: string) =>
    post<{ keyId: string; version: number; signatureMatches: boolean }>(`/api/devices/${id}/verify-config`),
  deviceAta: (id: string, refresh = false) =>
    request<{ adaptor: AdaptorOverview; passwordConfigured: boolean }>(
      `/api/devices/${id}/ata${refresh ? '?refresh=1' : ''}`,
    ),
  rebootAta: (id: string) =>
    post<{ status: number; accepted: boolean }>(`/api/devices/${id}/ata/reboot`),

  lines: () => request<{ lines: Line[] }>('/api/lines'),
  createLine: (body: Record<string, unknown>) => post<{ line: Line }>('/api/lines', body),
  updateLine: (id: string, body: Record<string, unknown>) => patch<{ line: Line }>(`/api/lines/${id}`, body),
  deleteLine: (id: string) => del<{ ok: true }>(`/api/lines/${id}`),

  directory: () => request<{ entries: DirectoryEntry[] }>('/api/directory'),
  createEntry: (body: Record<string, unknown>) => post<{ entry: DirectoryEntry }>('/api/directory', body),
  updateEntry: (id: string, body: Record<string, unknown>) =>
    patch<{ entry: DirectoryEntry }>(`/api/directory/${id}`, body),
  deleteEntry: (id: string) => del<{ ok: true }>(`/api/directory/${id}`),

  events: (limit = 40) => request<{ events: PlatformEvent[] }>(`/api/events?limit=${limit}`),

  provisioning: () =>
    request<{
      profiles: ProvisioningProfileSummary[];
      routing: { documentId: string; revision: number; document: RoutingDocument };
      codes: Array<{
        id: string;
        code: string;
        model: ModelKey;
        label: string;
        expiresAt: string;
        usedAt: string | null;
        createdAt: string;
      }>;
      settings: Settings;
    }>('/api/provisioning'),
  createCode: (body: { model: ModelKey; label?: string; ttlMinutes?: number }) =>
    post<{ id: string; code: string; model: ModelKey; expiresAt: string }>('/api/provisioning/codes', body),
  deleteCode: (id: string) => del<{ ok: true }>(`/api/provisioning/codes/${id}`),

  cantusStatus: (refresh = false) =>
    request<CantusStatus>(`/api/cantus/status${refresh ? '?refresh=1' : ''}`),
  routingDocument: () =>
    request<{ documentId: string; revision: number; document: RoutingDocument }>(
      '/api/cantus/routing-document',
    ),
  validateRouting: (document?: RoutingDocument) =>
    post<{ ok: boolean; verifiedBy: 'cantus' | 'local'; errors: string[]; output: string }>(
      '/api/cantus/validate',
      document ? { document } : {},
    ),
  routeTest: (body: { to: string; from?: string; hour?: string }) =>
    post<CantusRouteDecision & { raw: string; revision: number }>('/api/cantus/route-test', body),
  probe: (body: { nat?: 'none' | 'cone' | 'symmetric'; rebind?: boolean }) =>
    post<PathProbeResult>('/api/cantus/probe', body),

  settings: () => request<{ settings: Settings }>('/api/settings'),
  updateSettings: (body: Partial<Settings>) => patch<{ settings: Settings }>('/api/settings', body),
};
