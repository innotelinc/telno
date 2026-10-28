import { ami } from './ami.js';
import { writeConfigs, generateConfigs } from './provision.js';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from '../lib/audit.js';
import { onFaxEvent } from '../lib/fax.js';
import { asteriskTime, directionFor, DISPOSITIONS, mergeFields } from './call-log.js';

const channels = new Map();
// Every leg of one call carries the same Linkedid: the Local channel wrapper,
// the endpoint that answers it and the trunk leg. That is the identity of the
// call — the leg map is what lets a CDR that arrives after its hangup land on
// the row the hangup opened, even though only one of them names the call.
const legs = new Map();
// MixMonitor reports its file when recording starts and stops; the call row is
// stamped with it so the console can play the audio back after the hangup.
const recordings = new Map();
let started = false;

const AUDIO_EXT = /\.(wav|wav49|gsm|ulaw|alaw|sln|g722|ogg|mp3)$/i;

function recordingName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop()?.trim();
  if (!base) return '';
  return AUDIO_EXT.test(base) ? base : `${base}.wav`;
}

/** Live channel state, populated from AMI events (bounded, oldest dropped). */
function track(uniqueid, patch) {
  const existing = channels.get(uniqueid) || { started: Date.now() };
  channels.set(uniqueid, { ...existing, ...patch });
  if (channels.size > 500) {
    const oldest = channels.keys().next().value;
    channels.delete(oldest);
  }
  return channels.get(uniqueid);
}

/**
 * Write what one event knows about a call, merging it into the row that call
 * already has. Idempotent on the call's identity, which is why a reconnect, a
 * replayed CDR or a second leg cannot add a row to the log.
 */
function mergeCall(callId, patch) {
  const existing = db_.get('SELECT * FROM calls WHERE call_id = ?', [callId]);
  const fields = mergeFields(existing || {}, patch);

  if (!existing) {
    const id = newId('cal_');
    db_.run(
      `INSERT INTO calls (id, call_id, direction, from_number, to_number, extension, trunk,
                          started_at, answered_at, ended_at, duration, billsec, disposition,
                          hangup_cause, recording, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        callId,
        fields.direction,
        fields.from_number,
        fields.to_number,
        fields.extension,
        fields.trunk,
        fields.started_at || now(),
        fields.answered_at,
        fields.ended_at,
        fields.duration,
        fields.billsec,
        fields.disposition,
        fields.hangup_cause,
        fields.recording,
        fields.cost,
      ]
    );
    return id;
  }

  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === existing[key]) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length) {
    db_.run(`UPDATE calls SET ${sets.join(', ')} WHERE call_id = ?`, [...values, callId]);
  }
  return existing.id;
}

function rememberLeg(leg, key) {
  if (!leg || !key) return;
  legs.set(leg, key);
  if (legs.size > 2000) legs.delete(legs.keys().next().value);
}

/**
 * The call a leg belongs to: its Linkedid when the switch sends one, the leg's
 * own recorded root after that, and its Uniqueid as the last resort.
 */
function callKey(msg) {
  const leg = String(msg.Uniqueid || '').trim();
  const linked = String(msg.Linkedid || '').trim();
  const shared = linked && linked !== '(none)' ? linked : '';
  const key = shared || legs.get(leg) || leg;
  rememberLeg(leg, key);
  if (shared) rememberLeg(shared, shared);
  return key;
}

const digits = (value) => String(value ?? '').replace(/\D/g, '').slice(-10);

/**
 * The row a nameless CDR belongs to.
 *
 * cdr_manager only sends the leg's identity when the switch is told to log it,
 * and until it was, a record arrived carrying little more than a source and a
 * start time — which is why every call opened a second, third and fourth row.
 * Matching such a record to a call that began within the same few seconds is
 * what keeps it attached to that call instead of starting a new one; when more
 * than one call is close enough to be the answer, it declines to guess.
 */
function existingCallFor(patch) {
  const at = Date.parse(patch.started_at || '');
  if (Number.isNaN(at)) return '';
  const near = db_.all(
    'SELECT call_id, from_number, to_number FROM calls WHERE started_at BETWEEN ? AND ?',
    [new Date(at - 5000).toISOString(), new Date(at + 5000).toISOString()]
  );
  if (!near.length) return '';
  const parties = [digits(patch.from_number), digits(patch.to_number)].filter(Boolean);
  const sharing = near.filter((row) =>
    [digits(row.from_number), digits(row.to_number)].some((party) => party && parties.includes(party))
  );
  if (sharing.length === 1) return sharing[0].call_id;
  if (!sharing.length && near.length === 1) return near[0].call_id;
  return '';
}

/**
 * One AMI event. Exported so the ingest can be replayed from a recording of a
 * real call instead of only being exercised by dialling it.
 */
export function ingestEvent(msg) {
  try {
    // Fax rides the same session: res_fax reports an originate and a result, and
    // the hangup that follows a silent transmission is a failure, not a lost row.
    // The switch spells these `FAXStatus`, `SendFAX` and `ReceiveFAX`; a filter
    // listing `FaxStatus` hears none of them and every send looks hung.
    if (/^(originate(response)?|faxstatus|sendfax|receivefax|hangup)$/i.test(msg.Event || '')) {
      // The fax handler needs the call's own state to name an inbound document:
      // the event says what arrived, the channel says who sent it and to which
      // number.
      onFaxEvent(msg, channels.get(msg.Uniqueid) || null);
    }
    switch (msg.Event) {
      case 'Newchannel': {
        track(msg.Uniqueid, {
          from: msg.CallerIDNum || 'unknown',
          to: msg.Exten || '',
          context: msg.Context || '',
          channel: msg.Channel || '',
          started: Date.now(),
          call: callKey(msg),
        });
        break;
      }
      case 'Dial': {
        if (msg.SubEvent === 'Begin') {
          track(msg.Uniqueid, { dialed: msg.Destination || '' });
        } else if (msg.SubEvent === 'End' && msg.DialStatus === 'ANSWER') {
          track(msg.Uniqueid, { answered: Date.now() });
        }
        break;
      }
      case 'Bridge': {
        track(msg.Uniqueid, { answered: channels.get(msg.Uniqueid)?.answered || Date.now() });
        break;
      }
      case 'Hangup': {
        const info = channels.get(msg.Uniqueid);
        if (!info) break;
        const endedAt = Date.now();
        const answered = info.answered ? new Date(info.answered).toISOString() : null;
        const duration = Math.max(0, Math.round((endedAt - (info.started || endedAt)) / 1000));
        const billsec = info.answered ? Math.max(0, Math.round((endedAt - info.answered) / 1000)) : 0;
        const context = msg.Context || info.context;
        mergeCall(callKey(msg), {
          direction: directionFor(context),
          from_number: info.from,
          to_number: info.dialed || info.to,
          extension: context === 'internal' ? info.to : '',
          trunk: (info.channel.match(/trunk-([A-Za-z0-9_.-]+)-/)?.[1] || ''),
          started_at: new Date(info.started || endedAt).toISOString(),
          answered_at: answered,
          ended_at: new Date(endedAt).toISOString(),
          duration,
          billsec,
          disposition: !info.answered ? (msg.Cause === '16' ? 'no-answer' : 'failed') : billsec > 0 ? 'answered' : 'no-answer',
          hangup_cause: msg['Cause-txt'] || '',
          recording: recordings.get(msg.Uniqueid) || '',
        });
        channels.delete(msg.Uniqueid);
        break;
      }
      case 'MixMonitorStart':
      case 'MixMonitorStop': {
        const name = recordingName(msg.Filename);
        if (!name) break;
        recordings.set(msg.Uniqueid, name);
        if (recordings.size > 500) recordings.delete(recordings.keys().next().value);
        break;
      }
      case 'Cdr': {
        // cdr_manager gives us authoritative values; they win over estimates.
        const patch = {
          direction: directionFor(msg.DestinationContext),
          from_number: msg.Source || '',
          to_number: msg.Destination || '',
          trunk: msg.LastApplication === 'Dial' ? msg.LastData || '' : '',
          started_at: asteriskTime(msg.StartTime) || now(),
          answered_at: asteriskTime(msg.AnswerTime),
          ended_at: asteriskTime(msg.EndTime),
          duration: Number(msg.Duration) || 0,
          billsec: Number(msg.BillableSeconds) || 0,
          disposition: DISPOSITIONS[msg.Disposition] || 'unknown',
          hangup_cause: msg['Cause-txt'] || '',
          cost: Number(msg.Cost) || 0,
          // Undefined, not empty: a CDR arriving after the Hangup must not wipe
          // the recording the MixMonitor event already attached.
          recording: recordings.get(msg.Uniqueid) || undefined,
        };
        // The record names its leg only when the switch logs Uniqueid, and even
        // then only after the leg was heard from. Either way the call it belongs
        // to may already have a row, and that row is the one to write into.
        let key = callKey(msg);
        if (!key || !db_.get('SELECT 1 AS hit FROM calls WHERE call_id = ?', [key])) {
          key = existingCallFor(patch) || key || `${msg.Source || 'unknown'}-${msg.StartTime || now()}`;
        }
        mergeCall(key, patch);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Never let a malformed event take the API down.
    console.error('[telephony] event handling failed', msg.Event, err.message);
  }
}

export function startTelephony() {
  if (started) return;
  started = true;
  const client = ami();
  client.on('event', (msg) => ingestEvent(msg));
  client.on('connected', () => console.log('[telephony] AMI connected'));
  client.on('disconnected', () => console.warn('[telephony] AMI disconnected, retrying'));
}

export async function telephonyStatus() {
  const client = ami();
  const base = await client.status();
  const active = liveChannels().slice(0, 25).map((c) => ({
    from: c.from,
    to: c.dialed || c.to,
    context: c.context,
    seconds: Math.round((Date.now() - (c.started || Date.now())) / 1000),
  }));
  return {
    ...base,
    activeChannels: base.connected ? active : [],
    transport: 'AMI',
    configDir: config.telephony.configDir || null,
  };
}

export async function applyConfiguration(actor = 'system') {
  const write = writeConfigs();
  let reload = null;
  if (write.written && config.telephony.reloadOnApply) {
    reload = await ami().reload('all');
  }
  db_.run('INSERT INTO events (actor, action, subject, detail) VALUES (?, ?, ?, ?)', [
    actor,
    'telephony.apply',
    'asterisk',
    JSON.stringify({ write, reloaded: !!reload }),
  ]);
  return { ...write, reloaded: !!reload };
}

/**
 * Write the switch configuration and reload it after a saved change.
 *
 * The database is the source of truth and every generated file is derived from
 * it, so a saved change is a live change: there is no Apply button to forget,
 * and the UI cannot disagree with the switch. A write that cannot reach the
 * switch is reported to the caller rather than rolling the row back — the row
 * is already committed and the next change, or the next boot, regenerates the
 * files from it anyway.
 */
export async function applyAfterChange(request) {
  if (!config.telephony.configDir) return null;
  const actor = request?.account?.email || request?.apiKey?.label || 'api';
  try {
    const result = await applyConfiguration(actor);
    return { written: result.written, dir: result.dir, reloaded: result.reloaded };
  } catch (err) {
    logEvent({
      actor,
      action: 'telephony.apply_failed',
      subject: 'asterisk',
      detail: err.message,
      ip: request?.ip,
    });
    return { error: err.message };
  }
}

export const previewConfiguration = () => generateConfigs();
/**
 * One entry per call, not per channel: a bridged call has two legs and a Local
 * channel has a wrapper, and neither is a second call in progress.
 */
export const liveChannels = () => {
  const byCall = new Map();
  for (const [leg, info] of channels) {
    const key = info.call || leg;
    const current = byCall.get(key);
    if (!current || (info.started || 0) < (current.started || 0)) byCall.set(key, info);
  }
  return [...byCall.values()];
};
