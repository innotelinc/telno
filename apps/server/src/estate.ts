import type { DatabaseSync } from 'node:sqlite';

/** What the operator asked the port to be, in estate terms. */
export interface PortIdentity {
  /** The extension whose identity the port is being given. */
  extension: string;
  /** The device the port physically belongs to. */
  deviceId: string;
  /** The account slot on that device, 1-based — the port itself. */
  slot: number;
}

/** The answer, and the ownership behind it so the caller can record it. */
export interface LineAssignment {
  /** Why this port should not take the extension, or null when it is its to use. */
  warning: string | null;
  /** Who holds the line today; null when the extension does not exist at all. */
  owner: { deviceId: string | null; slot: number } | null;
}

/**
 * Is this extension this port's to use?
 *
 * The adaptor cannot answer this. It registers whatever identity it is handed
 * and reports itself registered, so a port pointed at `999` looks perfectly
 * healthy on the device sheet — "registered" — and rings nowhere, because
 * nothing behind the switch answers to that number. Worse, a port pointed at
 * another device's line looks equally healthy while quietly taking that phone's
 * calls. Only the platform knows which extension belongs where.
 *
 * The result is a warning rather than a refusal on purpose. The estate's own 201
 * and 202 were put on the hardware before this platform had a line for them, and
 * an operator may be deliberately ahead of the inventory; blocking the write
 * would make the adaptor sheet unable to do the job it was built for.
 */
export function lineAssignment(db: DatabaseSync, asked: PortIdentity): LineAssignment {
  // Bound, never interpolated: the extension comes straight from a form.
  const row = db
    .prepare(
      `SELECT l.extension, l.device_id AS deviceId, l.account_slot AS slot,
              d.label AS deviceLabel, d.location AS deviceLocation
         FROM lines l
         LEFT JOIN devices d ON d.id = l.device_id
        WHERE l.extension = ?`,
    )
    .get(asked.extension) as
    | {
        extension: string;
        deviceId: string | null;
        slot: number;
        deviceLabel: string | null;
        deviceLocation: string | null;
      }
    | undefined;

  if (!row) {
    return {
      owner: null,
      warning: `No line in this estate uses ${asked.extension}, so the port will register and then ring nowhere until one does.`,
    };
  }

  const owner = { deviceId: row.deviceId, slot: row.slot };

  // A line nobody has been given yet is exactly what a port is for.
  if (row.deviceId === null) return { owner, warning: null };

  if (row.deviceId !== asked.deviceId) {
    const holder = describeDevice(row.deviceLabel, row.deviceLocation);
    return {
      owner,
      warning: `Line ${asked.extension} is assigned to ${holder}, so this port and ${holder} would both answer as ${asked.extension} and a call could land on either handset.`,
    };
  }

  if (row.slot !== asked.slot) {
    return {
      owner,
      warning: `Line ${asked.extension} is assigned to port ${row.slot} of this adaptor, so ports ${row.slot} and ${asked.slot} would both answer as ${asked.extension}.`,
    };
  }

  return { owner, warning: null };
}

/** Labels are operator-chosen and occasionally blank; never render "null". */
function describeDevice(label: string | null, location: string | null): string {
  const name = label?.trim() || 'another device';
  const place = location?.trim();
  return place ? `${name} at ${place}` : name;
}
