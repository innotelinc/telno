/**
 * Shared contract between the Telno control plane and the console.
 *
 * Everything here is product-facing vocabulary: devices, lines, directory
 * entries, provisioning revisions and cantus routing. No vendor-specific
 * configuration dialect appears in this file on purpose — provisioning is our
 * own signed JSON document (see apps/server/src/provisioning.ts).
 */

export const CONFIG_SCHEMA = 'telno.device.config/1';
export const ROUTING_SCHEMA = 'telno.routing/1';

/** Hardware profiles this platform ships. */
export type ModelKey = 't750' | 'ht802';

export interface DeviceModel {
  key: ModelKey;
  /** Commercial model name, e.g. "Telno T750 2026". */
  name: string;
  formFactor: 'desk-phone' | 'analog-adapter';
  summary: string;
  /** SIP/voice account slots the hardware can hold. */
  accountSlots: number;
  /** Physical voice ports (FXS lines on an adapter, handset on a phone). */
  voicePorts: number;
  network: { poe: boolean; ports: number; speedMbps: number };
  features: string[];
  /** Keys the device must echo back when it enrolls. */
  enrollmentFields: Array<'serial' | 'mac' | 'firmware'>;
}

export const DEVICE_MODELS: Record<ModelKey, DeviceModel> = {
  t750: {
    key: 't750',
    name: 'Telno T750 2026',
    formFactor: 'desk-phone',
    summary: 'Six-line executive desk phone with a colour display, gigabit switching and PoE.',
    accountSlots: 6,
    voicePorts: 1,
    network: { poe: true, ports: 2, speedMbps: 1000 },
    features: [
      '6 programmable line keys',
      '4.3" colour display',
      'HD handset and speakerphone',
      'Gigabit passthrough port',
      'PoE 802.3af',
      'cantus reach with automatic relay fallback',
    ],
    enrollmentFields: ['serial', 'mac', 'firmware'],
  },
  ht802: {
    key: 'ht802',
    name: 'Telno HT802 2026',
    formFactor: 'analog-adapter',
    summary: 'Two-port analog terminal adapter that puts existing handsets on cantus.',
    accountSlots: 2,
    voicePorts: 2,
    network: { poe: false, ports: 1, speedMbps: 100 },
    features: [
      '2 FXS ports',
      '2 independent voice accounts',
      'cantus reach with automatic relay fallback',
      'Tone and cadence profiles per region',
      'Wall-mount enclosure',
      'Watchdog with signed config rollback',
    ],
    enrollmentFields: ['serial', 'mac', 'firmware'],
  },
};

export const MODEL_KEYS = Object.keys(DEVICE_MODELS) as ModelKey[];

export function isModelKey(value: unknown): value is ModelKey {
  return typeof value === 'string' && value in DEVICE_MODELS;
}

export type DeviceStatus = 'pending' | 'online' | 'offline' | 'revoked';

export interface Device {
  id: string;
  serial: string;
  mac: string | null;
  model: ModelKey;
  label: string;
  location: string;
  status: DeviceStatus;
  firmware: string | null;
  /** Monotonic configuration revision the device has been issued. */
  configVersion: number;
  /** Revision the device last confirmed by polling. */
  appliedVersion: number | null;
  lastSeenAt: string | null;
  lastEnrolledAt: string | null;
  createdAt: string;
  tokenRotatedAt: string | null;
}

export type RoutingMode = 'business-hours' | 'always' | 'forward' | 'voicemail';

export interface Line {
  id: string;
  extension: string;
  /** Address of record the device registers, e.g. alice@t750.telno */
  aor: string;
  displayName: string;
  deviceId: string | null;
  accountSlot: number;
  routingMode: RoutingMode;
  /** Used by `forward` and `voicemail` modes. */
  forwardTo: string | null;
  businessHours: { start: string; end: string; weekdays: string[] };
  enabled: boolean;
  createdAt: string;
}

export interface DirectoryEntry {
  id: string;
  displayName: string;
  number: string;
  extension: string | null;
  email: string | null;
  company: string | null;
  favorite: boolean;
  notes: string | null;
  createdAt: string;
}

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface PlatformEvent {
  id: number;
  kind: string;
  level: EventLevel;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface Settings {
  orgName: string;
  domain: string;
  timezone: string;
  /** Voice node announced to devices, host:port. */
  voiceNode: string;
  voicePort: number;
  relay: string;
  ntp: string;
  /** Enforced on new provisioning revisions. */
  requireSignedConfig: boolean;
  sessionHours: number;
  /** Comma-separated CIDRs allowed to use the console. */
  trustedNetworks: string;
  keyId: string;
}

export interface SessionUser {
  username: string;
  displayName: string;
  role: 'admin' | 'operator';
}

/** Signed configuration body delivered to a device. */
export interface DeviceConfig {
  schema: typeof CONFIG_SCHEMA;
  version: number;
  issuedAt: string;
  device: {
    id: string;
    serial: string;
    mac: string | null;
    model: ModelKey;
    label: string;
    location: string;
  };
  network: { ntp: string; timezone: string };
  voice: {
    transport: 'cantus/1';
    node: string;
    port: number;
    relay: string | null;
    reachMs: number;
    codecs: string[];
    keepaliveMs: number;
  };
  accounts: Array<{
    slot: number;
    aor: string;
    displayName: string;
    routingMode: RoutingMode;
  }>;
  routing: { documentId: string; revision: number };
  /** Public identifier of the signing key the device must verify with. */
  keyId: string;
  /** Hex HMAC-SHA256 over the canonical body. */
  signature: string;
}

export interface ProvisioningProfileSummary {
  model: ModelKey;
  name: string;
  schema: string;
  keyId: string;
  revision: number;
  deviceCount: number;
}

export interface EnrollmentCode {
  id: string;
  code: string;
  model: ModelKey;
  label: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface CantusStatus {
  available: boolean;
  binary: string;
  version: string | null;
  reason: string | null;
  selftest: { ok: boolean; checks: Array<{ name: string; ok: boolean }>; output: string } | null;
}

export interface CantusRouteDecision {
  route: string | null;
  actions: string[];
  matched: boolean;
}

export interface RoutingDocument {
  version: 1;
  default: Record<string, unknown>;
  routes: Array<{
    name: string;
    when: Record<string, unknown>;
    then: Array<Record<string, unknown>>;
  }>;
}

export interface PathProbeResult {
  ok: boolean;
  path: 'direct' | 'relay' | null;
  frames: number;
  peak: number;
  codec: string | null;
  rebind: { requested: boolean; recoveredAtMs: number | null } | null;
  nat: string;
  output: string;
  ranAt: string;
}

export interface Overview {
  devices: { total: number; online: number; pending: number; offline: number };
  lines: { total: number; enabled: number };
  directory: { total: number };
  provisioning: { revisions: number; keyId: string };
  cantus: CantusStatus;
  modelMix: Array<{ model: ModelKey; count: number }>;
  events: PlatformEvent[];
}
