import { createHash } from 'node:crypto';
import type {
  Device,
  DeviceConfig,
  DirectoryEntry,
  Line,
  ModelKey,
  Overview,
  PlatformEvent,
  ProvisioningProfileSummary,
  RoutingMode,
  Settings,
} from '@telno/shared';
import { DEVICE_MODELS, MODEL_KEYS } from '@telno/shared';
import { db, getSetting, now, provisioningKey, type DeviceRow, type LineRow } from './db.js';
import { buildDeviceConfig } from './provisioning.js';
import { buildRoutingDocument, cantusStatus } from './cantus.js';
import { trustedNetworkText } from './security.js';

/* -------------------------------------------------------------------- mappers */

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    serial: row.serial,
    mac: row.mac,
    model: row.model,
    label: row.label,
    location: row.location,
    status: row.status,
    firmware: row.firmware,
    configVersion: row.config_version,
    appliedVersion: row.applied_version,
    lastSeenAt: row.last_seen_at,
    lastEnrolledAt: row.last_enrolled_at,
    createdAt: row.created_at,
    tokenRotatedAt: row.token_rotated_at,
    addr: row.addr ?? null,
  };
}

export function toLine(row: LineRow): Line {
  return {
    id: row.id,
    extension: row.extension,
    aor: row.aor,
    displayName: row.display_name,
    deviceId: row.device_id,
    accountSlot: row.account_slot,
    routingMode: row.routing_mode,
    forwardTo: row.forward_to,
    businessHours: {
      start: row.bh_start,
      end: row.bh_end,
      weekdays: row.bh_days.split(',').filter(Boolean),
    },
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function toDirectoryEntry(row: {
  id: string;
  display_name: string;
  number: string;
  extension: string | null;
  email: string | null;
  company: string | null;
  favorite: number;
  notes: string | null;
  created_at: string;
}): DirectoryEntry {
  return {
    id: row.id,
    displayName: row.display_name,
    number: row.number,
    extension: row.extension,
    email: row.email,
    company: row.company,
    favorite: row.favorite === 1,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function toEvent(row: {
  id: number;
  kind: string;
  level: string;
  message: string;
  meta: string | null;
  created_at: string;
}): PlatformEvent {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    level: row.level as PlatformEvent['level'],
    message: row.message,
    meta,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------- settings */

export function settingsSnapshot(): Settings {
  const { keyId } = provisioningKey();
  return {
    orgName: getSetting('org.name', 'Telno'),
    domain: getSetting('org.domain', 'telno.local'),
    timezone: getSetting('org.timezone', 'Europe/London'),
    voiceNode: getSetting('voice.node', ''),
    voicePort: Number(getSetting('voice.port', '7443')) || 7443,
    relay: getSetting('voice.relay', ''),
    ntp: getSetting('voice.ntp', 'pool.ntp.org'),
    sipEdge: getSetting('voice.sipEdge', ''),
    sipPort: Number(getSetting('voice.sipPort', '5060')) || 5060,
    requireSignedConfig: getSetting('provisioning.requireSignature', '1') === '1',
    sessionHours: Number(getSetting('session.hours', '12')) || 12,
    trustedNetworks: trustedNetworkText(),
    keyId,
  };
}

/* -------------------------------------------------------------------- routing */

export interface RoutingSnapshot {
  documentId: string;
  revision: number;
  document: ReturnType<typeof buildRoutingDocument>;
}

export function routingSnapshot(): RoutingSnapshot {
  const lines = (db.prepare('SELECT * FROM lines ORDER BY extension').all() as unknown as LineRow[]).map(
    toLine,
  );
  const settings = settingsSnapshot();
  const document = buildRoutingDocument({ lines, domain: settings.domain });
  const encoded = JSON.stringify(document);
  const documentId = `rt-${createHash('sha256').update(encoded).digest('hex').slice(0, 12)}`;

  const latest = db
    .prepare('SELECT revision, document FROM routing_revisions ORDER BY revision DESC LIMIT 1')
    .get() as { revision: number; document: string } | undefined;

  if (latest && latest.document === encoded) {
    return { documentId, revision: latest.revision, document };
  }

  const revision = (latest?.revision ?? 0) + 1;
  db.prepare('INSERT INTO routing_revisions (revision, document, created_at) VALUES (?,?,?)').run(
    revision,
    encoded,
    now(),
  );
  return { documentId, revision, document };
}

/* ---------------------------------------------------------------- provisioning */

export function deviceConfigFor(row: DeviceRow): DeviceConfig {
  const settings = settingsSnapshot();
  const routing = routingSnapshot();
  const lines = (
    db
      .prepare('SELECT * FROM lines WHERE device_id = ? AND enabled = 1 ORDER BY account_slot')
      .all(row.id) as unknown as LineRow[]
  ).map(toLine);

  return buildDeviceConfig({
    device: {
      id: row.id,
      serial: row.serial,
      mac: row.mac,
      model: row.model,
      label: row.label,
      location: row.location,
      config_version: row.config_version,
      config_issued_at: row.config_issued_at,
      created_at: row.created_at,
    },
    lines,
    settings: {
      domain: settings.domain,
      timezone: settings.timezone,
      ntp: settings.ntp,
      voiceNode: settings.voiceNode,
      voicePort: settings.voicePort,
      relay: settings.relay || null,
      sipEdge: settings.sipEdge,
      sipPort: settings.sipPort,
      documentId: routing.documentId,
      routingRevision: routing.revision,
    },
  });
}

export function provisioningProfiles(): ProvisioningProfileSummary[] {
  const { keyId } = provisioningKey();
  const routing = routingSnapshot();
  return MODEL_KEYS.map((model: ModelKey) => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE model = ?').get(model) as {
      c: number;
    };
    return {
      model,
      name: DEVICE_MODELS[model].name,
      schema: 'telno.device.config/1',
      keyId,
      revision: routing.revision,
      deviceCount: count.c,
    };
  });
}

/* -------------------------------------------------------------------- overview */

export async function overview(): Promise<Overview> {
  // Establish a routing revision on first boot so the console has a baseline
  // to display before any device or page asks for one.
  routingSnapshot();
  const status = await cantusStatus();
  const devices = db
    .prepare('SELECT status, COUNT(*) AS c FROM devices GROUP BY status')
    .all() as Array<{ status: string; c: number }>;
  const count = (s: string) => devices.find((d) => d.status === s)?.c ?? 0;
  const total = devices.reduce((sum, d) => sum + d.c, 0);

  const lines = db
    .prepare('SELECT SUM(enabled) AS enabled, COUNT(*) AS total FROM lines')
    .get() as { enabled: number | null; total: number };
  const directory = db.prepare('SELECT COUNT(*) AS c FROM directory').get() as { c: number };
  const revisions = db
    .prepare('SELECT COUNT(*) AS c FROM routing_revisions')
    .get() as { c: number };
  const modelMix = db
    .prepare('SELECT model, COUNT(*) AS c FROM devices GROUP BY model')
    .all() as Array<{ model: ModelKey; c: number }>;
  const events = db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 12')
    .all() as unknown as Array<{
    id: number;
    kind: string;
    level: string;
    message: string;
    meta: string | null;
    created_at: string;
  }>;

  return {
    devices: { total, online: count('online'), pending: count('pending'), offline: count('offline') },
    lines: { total: lines.total, enabled: lines.enabled ?? 0 },
    directory: { total: directory.c },
    provisioning: { revisions: revisions.c, keyId: provisioningKey().keyId },
    cantus: status,
    modelMix: modelMix.map((m) => ({ model: m.model, count: m.c })),
    events: events.map(toEvent),
  };
}

export const ROUTING_MODES: RoutingMode[] = ['business-hours', 'always', 'forward', 'voicemail'];
