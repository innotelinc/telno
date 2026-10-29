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
  /** Address the device enrolled from — where its own web console can be reached. */
  addr: string | null;
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
  /**
   * SIP server an analog adaptor registers against, when the deployment has an
   * edge that bridges SIP to cantus. Empty means `domain:sipPort`.
   */
  sipEdge: string;
  sipPort: number;
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
export interface CantusVoice {
  transport: 'cantus/1';
  node: string;
  port: number;
  relay: string | null;
  reachMs: number;
  codecs: string[];
  keepaliveMs: number;
}

export interface SipVoice {
  transport: 'sip';
  /** Host the adaptor sends SIP to: the edge when configured, else the domain. */
  server: string;
  port: number;
  domain: string;
  expiresSec: number;
  /** Local SIP port to bind per FXS port; distinct ports keep NAT paths apart. */
  localPorts: number[];
  codecs: string[];
  note: string;
}

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
  /**
   * Cantus carries signalling and media on one socket, which a desk phone can
   * speak natively. An analog adaptor cannot: its only voice protocol is SIP,
   * so it is told to register against a SIP edge and the edge bridges to cantus.
   * A config that claimed `cantus/1` for an HT802 would be a document the device
   * cannot act on.
   */
  voice: CantusVoice | SipVoice;
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

/* ------------------------------------------------------------- analog adaptor */

/**
 * What the platform could learn from an adaptor's own console.
 *
 * Two HT802 firmwares are in the field and they share no protocol, so every
 * field is nullable: "this firmware does not report a serial" is a fact the
 * console states rather than a blank that looks like a fault.
 */
export type AdaptorState = 'unreachable' | 'locked' | 'auth' | 'reachable' | 'online' | 'stale';

export interface AdaptorTarget {
  host: string;
  port: number;
  label: string;
}

export interface AdaptorLock {
  locked: boolean;
  remainSec: number;
  accessAttempts: number;
  invalidAttempts: number;
}

export interface AdaptorIdentity {
  model: string | null;
  firmware: string | null;
  hardware: string | null;
  bootloader: string | null;
  serial: string | null;
  mac: string | null;
  uptime: string | null;
  ip: string | null;
}

export interface AdaptorPort {
  port: number;
  enabled: boolean | null;
  hook: string | null;
  /**
   * State as the device reports it. The V1 console shows configuration only, so
   * its value is "configured"; the V2 API reports live registration per account
   * and says "registered" or "not registered".
   */
  registration: string | null;
  /**
   * True only when the firmware itself reports a live registration. Absent or
   * null on a V1, where registration is not observable at all — never inferred
   * from a configured user id.
   */
  registered?: boolean | null;
  sipUser: string | null;
}

export interface AdaptorAccount {
  port: number;
  server: string | null;
  user: string | null;
  /** Authenticate id, when the firmware reports it separately from the user id. */
  authId?: string | null;
  name: string | null;
  active: string | null;
  localPort: string | null;
  /** SIP profile index the line is bound to, one-based. */
  profileId?: string | null;
  registration?: string | null;
  registered?: boolean | null;
}

/** The SIP identity one line holds, as the unit reports it. */
export interface AdaptorAccountState {
  user: string | null;
  authId: string | null;
  name: string | null;
  registration: string;
}

/** What a write to one line reports: what the unit holds now, not what was asked for. */
export interface AdaptorAccountWrite {
  account: number;
  applied: boolean;
  user: string | null;
  authId: string | null;
  name: string | null;
  registration: string;
  /**
   * What the line held before the write, read with the same session that
   * replaced it. Null when the unit would not say — which is not the same as an
   * empty slot, and must not be recorded as one.
   */
  previous: AdaptorAccountState | null;
  note: string;
}

/**
 * What the write route answers with: the driver's report, plus the one thing
 * only the platform can know — whether any line in the estate answers to the
 * extension that was just written.
 *
 * A warning, not an error. The unit will register the identity either way; the
 * warning exists because it will then ring nowhere, and "registered" on the
 * device sheet is otherwise indistinguishable from working.
 */
export interface AdaptorWriteResponse extends AdaptorAccountWrite {
  warning: string | null;
}

export interface AdaptorNetwork {
  ip: string | null;
  mask: string | null;
  gateway: string | null;
  dns: string | null;
  mac: string | null;
  dhcp: string | null;
}

export interface AdaptorOverview {
  target: AdaptorTarget;
  firmware: 'v1' | 'v2';
  state: AdaptorState;
  reachable: boolean;
  locked: boolean;
  remainSec: number;
  authenticated: boolean;
  lock: AdaptorLock | null;
  system: { voiceImage: string | null; role: string | null } | null;
  sip: { exists: boolean } | null;
  identity: AdaptorIdentity | null;
  ports: AdaptorPort[];
  accounts: AdaptorAccount[];
  network: AdaptorNetwork | null;
  sources: Record<string, string>;
  notes: string[];
  tookMs: number;
  checkedAt: string;
  /** True when this report came from the platform's short-lived cache. */
  cached?: boolean;
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

/**
 * What a line identity may look like.
 *
 * This is deliberately one rule in one place. The platform is what a Telno line
 * is, not the adaptor: when a number reaches a box, the firmware accepts
 * whatever it is given and simply fails to register, so a typo like `20l` shows
 * up as a silent "not registered" badge with no reason attached. Checking here
 * keeps the lines page, the adaptor sheet and any future provisioning path from
 * disagreeing about the same value.
 *
 * Two to six digits covers a branch extension (`201`), a short code (`55`) and a
 * plenty-long-enough site prefix (`123456`). It is not a SIP URI and not a PSTN
 * number: an external number belongs to a trunk, not to a line.
 */
export const EXTENSION_PATTERN = /^\d{2,6}$/;

/** The digits of an extension, or null when the value is not one. */
export function normalizeExtension(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return EXTENSION_PATTERN.test(text) ? text : null;
}

/**
 * Why a value cannot be an extension, in words an operator can act on — or null
 * when it can. Returned rather than thrown so the browser and the server can ask
 * the same question and show the same sentence.
 */
export function extensionProblem(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!text) return 'An extension is required: it is the SIP user id the line registers as.';
  if (!EXTENSION_PATTERN.test(text)) {
    return `"${text}" cannot be a line identity: an extension is 2 to 6 digits, like 201.`;
  }
  return null;
}
