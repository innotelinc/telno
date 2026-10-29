import { createHmac, randomBytes } from 'node:crypto';
import type { DeviceConfig, Line, ModelKey, RoutingMode } from '@telno/shared';
import { CONFIG_SCHEMA } from '@telno/shared';
import { provisioningKey } from './db.js';

/**
 * Telno provisioning, first revision.
 *
 * This replaces the vendor configuration dialect the previous platform carried
 * (per-MAC config files, vendor-specific parameter trees, hard-coded firmware
 * URLs). A device now gets exactly one artefact: this signed JSON document.
 *
 * Rules that make it verifiable:
 *  - the signature covers a canonical form, so key order cannot change it
 *  - the document carries its own revision, so replay and rollback are visible
 *  - the key id travels with the payload, so rotation is explicit
 *  - a device polls with the revision it holds and receives 304 when current
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function signConfig(body: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
}

export function deviceConfigSignature(config: DeviceConfig): string {
  const { signature: _signature, ...body } = config;
  const { key } = provisioningKey();
  return signConfig(body, key);
}

/** Tokens are shown once, stored as a SHA-256 digest (see auth.tokenDigest). */
export function issueDeviceToken(): string {
  return `tln_${randomBytes(24).toString('base64url')}`;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function issueEnrollmentCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface ConfigInput {
  device: {
    id: string;
    serial: string;
    mac: string | null;
    model: ModelKey;
    label: string;
    location: string;
    config_version: number;
    config_issued_at: string | null;
    created_at?: string | null;
  };
  lines: Line[];
  settings: {
    domain: string;
    timezone: string;
    ntp: string;
    voiceNode: string;
    voicePort: number;
    relay: string | null;
    documentId: string;
    routingRevision: number;
  };
}

/** Last-resort stand-in so a row without timestamps still yields a stable document. */
const EPOCH = new Date(0).toISOString();

export function buildDeviceConfig(input: ConfigInput): DeviceConfig {
  const { device, lines, settings } = input;
  const { keyId } = provisioningKey();
  const accounts = lines
    .filter((line) => line.enabled)
    .slice(0, 6)
    .map((line) => ({
      slot: line.accountSlot,
      aor: line.aor,
      displayName: line.displayName,
      routingMode: line.routingMode as RoutingMode,
    }));

  const body: Omit<DeviceConfig, 'signature'> = {
    schema: CONFIG_SCHEMA,
    version: device.config_version,
    // Stable for a given revision: the signature and the ETag both derive from
    // it, so a device polling an unchanged config must get 304, not a new body.
    // Never fall back to the current clock here — that would change the
    // signature on every request and turn every poll into a full download.
    issuedAt: device.config_issued_at ?? device.created_at ?? EPOCH,
    keyId,
    device: {
      id: device.id,
      serial: device.serial,
      mac: device.mac,
      model: device.model,
      label: device.label,
      location: device.location,
    },
    network: { ntp: settings.ntp, timezone: settings.timezone },
    voice: {
      // One socket for signalling and media: no SDP, no RTP port range, no
      // static NAT knobs to reconcile on the device.
      transport: 'cantus/1',
      node: settings.voiceNode,
      port: settings.voicePort,
      relay: settings.relay,
      reachMs: 300,
      codecs: device.model === 't750' ? ['pcm-s16/8000/1'] : ['pcm-s16/8000/1'],
      keepaliveMs: 15_000,
    },
    accounts,
    routing: { documentId: settings.documentId, revision: settings.routingRevision },
  };

  // The key id is inside the signed body, so it cannot be swapped silently.
  const signature = signConfig(body, provisioningKey().key);
  return { ...body, signature };
}

export function etagFor(config: DeviceConfig): string {
  return `"v${config.version}-${config.signature.slice(0, 16)}"`;
}
