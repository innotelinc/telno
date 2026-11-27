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

import { normalizeNumber } from '../lib/e164.js';

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

// The endpoint the Cantus gateway rings on its way in. A carrier call reaches
// this switch through it, so the leg says "this came from outside" no matter
// which dialplan context the call is handed to next.
const EDGE_ENDPOINT = 'cantus-edge';

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

// A DID is ten or more digits. Anything shorter is an extension, which is a
// destination of a different kind and never the number a caller dialled.
const DID_DIGITS = /^\d{10,15}$/;

const didDigits = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return DID_DIGITS.test(digits) ? digits : '';
};

/**
 * The number a call was dialled on, in the one form the console stores numbers
 * in: `numbers.e164`, `+14132642700`.
 *
 * A carrier call reaches this switch through the gateway addressed to the number
 * that was dialled — the gateway forwards the DID and `[registry]` maps it to a
 * line — so the number is already the CDR's destination. It is normalised here
 * rather than kept as it arrived because the carrier sends ten digits and the
 * request-URI carries eleven: the same number in two forms is a number the
 * console cannot match against `numbers`, the directory or a carrier export.
 * `normalizeNumber` is the platform's own E.164 rule, so a row written from a
 * call compares equal to the row the DID was bought as.
 *
 * A short number is an extension and is not taken as a DID, so a dialplan label
 * or a stray value cannot invent one.
 */
export function dialledDid(value) {
  const digits = didDigits(value);
  if (!digits) return '';
  const parsed = normalizeNumber(String(value).trim());
  // A number libphonenumber will not vouch for is kept as digits rather than
  // discarded: a DID nobody can parse is still the number the caller dialled.
  return parsed.ok ? parsed.e164 : `+${digits}`;
}

/**
 * The destination to keep when two events describe the same call.
 *
 * The number that was dialled outranks the extension the switch rang in its
 * place, whichever event is heard first, because it is the destination the
 * operator was called on. A dialplan label loses to both.
 */
function destinationFor(existing, patch) {
  const keep = realDestination(existing);
  const next = realDestination(patch);
  if (!keep && !next) return '';
  const chosen = !keep ? next : !next ? keep : !didDigits(keep) && didDigits(next) ? next : keep;
  // A number long enough to be a DID is kept in the console's E.164 form, so the
  // row names the same string `numbers` is keyed on whichever event wrote it.
  return dialledDid(chosen) || chosen;
}

/** A caller worth recording: not the switch's placeholder for "anonymous". */
export function realCaller(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'unknown' || text === '<unknown>' || text === '(null)') return '';
  if (text.includes('/') || text.includes('@')) return '';
  return text;
}

/**
 * The endpoint a channel belongs to: `PJSIP/cantus-edge-0000001a` →
 * `cantus-edge`, `PJSIP/webrtc-101-0000001b` → `webrtc-101`. Asterisk appends
 * an eight-digit sequence number to every channel it creates; without it the
 * name is the endpoint as the config knows it.
 */
export function legFromChannel(channel) {
  const text = String(channel ?? '').trim();
  if (!text) return '';
  const cut = /^(?:PJSIP|SIP|Local|DAHDI|IAX2)\/(.+)$/.exec(text);
  const rest = cut ? cut[1] : text;
  return rest.replace(/-[0-9a-f]{8}$/i, '');
}

/**
 * The trunk column's value for a channel, or '' when the leg is not a trunk.
 *
 * A call that arrived through the gateway is recorded as `cantus-edge` — that
 * is the leg the carrier call landed on. A leg this switch dialled out through
 * keeps naming its trunk (`trunk-voipms-…` → `voipms`). A line's own leg is not
 * a trunk and must not be recorded as one, which is why `webrtc-101` yields ''.
 */
export function trunkForChannel(channel) {
  const leg = legFromChannel(channel);
  if (!leg) return '';
  if (leg === EDGE_ENDPOINT) return EDGE_ENDPOINT;
  const trunk = /^trunk-(.+)$/.exec(leg);
  return trunk ? trunk[1] : '';
}

/**
 * Which way a call went, from the context *and* the leg that spoke.
 *
 * The context alone is not enough. The gateway's edge endpoint carries
 * `context=from-internal`, because that is the context that can ring a line by
 * extension number, so every inbound carrier call used to be logged as an
 * internal call: `direction: internal` with the dialplan's
 * `PJSIP/webrtc-101,25,tT` in the trunk column. The leg is the fact that
 * settles it — a call on `cantus-edge` came from the carrier, whatever the
 * dialplan does with it afterwards.
 */
export function directionFor(context, channel = '') {
  const ctx = String(context ?? '');
  if (ctx.startsWith('outbound')) return 'outbound';
  if (ctx.startsWith('from-trunk') || ctx.startsWith('from-pstn')) return 'inbound';
  if (legFromChannel(channel) === EDGE_ENDPOINT) return 'inbound';
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
    to_number: destinationFor(existing.to_number, patch.to_number),
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
