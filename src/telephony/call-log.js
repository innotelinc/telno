/**
 * The call log's rules, kept apart from the AMI event loop so they can be read,
 * tested and replayed without a switch.
 *
 * A call is not one event. A Local channel pair, the endpoint that answers it
 * and the trunk leg that leaves the building each report a Newchannel, a Dial,
 * a Hangup and a CDR of their own — four rows per call if every event is taken
 * at face value. They are one call because they share a Linkedid, and each
 * event is a partial view of it: the hangup knows the dialled number, the CDR
 * knows the billable seconds. The row keeps the strongest version of every
 * field, so the order events arrive in cannot change the result and a replay
 * cannot add a row.
 */

export const DISPOSITIONS = {
  ANSWERED: 'answered',
  BUSY: 'busy',
  'NO ANSWER': 'no-answer',
  FAILED: 'failed',
  CONGESTION: 'congestion',
  CANCEL: 'no-answer',
};

// When no leg carried audio, the most specific outcome wins: a failed trunk leg
// must not be hidden behind the Local channel that "answered" it on the way out.
const DISPOSITION_RANK = { unknown: 0, answered: 1, 'no-answer': 2, failed: 3, congestion: 3, busy: 3 };

// A leg in `internal` is the wrapper; the leg that reached the world says what
// happened, so it wins the direction.
const DIRECTION_RANK = { internal: 0, inbound: 1, outbound: 1 };

// Dialplan labels the switch reports where a real number belongs.
const PSEUDO_EXTEN = new Set(['s', 'h', 'i', 't', 'T', 'e', 'o', 'a', 'fax', 'parked']);

const rank = (table, value) => (value in table ? table[value] : -1);

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const earliest = (a, b) => (!a ? b || null : !b ? a : a < b ? a : b);
export const latest = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);

/**
 * A destination worth recording: a number, not a dialplan label.
 *
 * `s` is what the CDR says for every call that walks through the standard
 * extension, so accepting it would replace the real destination with a
 * placeholder. A Local channel reports `Local/1415...@outbound`, which names
 * the route rather than the party, so it is not a destination either.
 */
export function realDestination(value) {
  const text = String(value ?? '').trim();
  if (!text || PSEUDO_EXTEN.has(text)) return '';
  if (text.includes('/') || text.includes('@')) return '';
  return /\d/.test(text) ? text : '';
}

/** A caller worth recording: not the switch's placeholder for "anonymous". */
export function realCaller(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'unknown' || text === '<unknown>' || text === '(null)') return '';
  if (text.includes('/') || text.includes('@')) return '';
  return text;
}

export function directionFor(context) {
  if (!context) return 'internal';
  if (context.startsWith('from-trunk') || context.startsWith('from-pstn')) return 'inbound';
  if (context.startsWith('outbound')) return 'outbound';
  return 'internal';
}

/**
 * Asterisk writes `YYYY-MM-DD HH:MM:SS` with no zone. The generated
 * cdr_manager.conf asks for GMT, so it is read as UTC rather than as whatever
 * the container's clock happens to be set to.
 */
export function asteriskTime(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '(null)' || text === 'None') return null;
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Merge one event's view of a call into the row that already exists.
 *
 * `existing` may be an empty object, in which case the patch is simply
 * normalized. Every column is returned, so the caller can insert or update
 * without deciding what the merge means.
 */
export function mergeFields(existing = {}, patch = {}) {
  const billsec = Math.max(number(existing.billsec), number(patch.billsec));
  const swallowed = billsec > 0
    ? 'answered'
    : rank(DISPOSITION_RANK, patch.disposition) > rank(DISPOSITION_RANK, existing.disposition || 'unknown')
      ? patch.disposition || 'unknown'
      : existing.disposition || 'unknown';

  return {
    direction:
      rank(DIRECTION_RANK, patch.direction) > rank(DIRECTION_RANK, existing.direction)
        ? patch.direction
        : existing.direction || patch.direction || 'inbound',
    from_number: realCaller(existing.from_number) || realCaller(patch.from_number),
    to_number: realDestination(existing.to_number) || realDestination(patch.to_number),
    extension: existing.extension || patch.extension || '',
    trunk: existing.trunk || patch.trunk || '',
    started_at: earliest(existing.started_at, patch.started_at),
    answered_at: earliest(existing.answered_at, patch.answered_at),
    ended_at: latest(existing.ended_at, patch.ended_at),
    duration: Math.max(number(existing.duration), number(patch.duration)),
    billsec,
    disposition: swallowed,
    // The cause belongs to the leg that decided the outcome: a "Normal
    // Clearing" from the wrapper must not describe a trunk that failed.
    hangup_cause: patch.disposition === swallowed && patch.hangup_cause
      ? patch.hangup_cause
      : existing.hangup_cause || '',
    recording: patch.recording || existing.recording || '',
    cost: Math.max(number(existing.cost), number(patch.cost)),
  };
}
