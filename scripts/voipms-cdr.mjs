#!/usr/bin/env node
/**
 * What did the carrier see in the last 24 hours?
 *
 * The platform only knows about calls it answered; the carrier knows about every
 * call that reached the account — including the ones that never rang a phone.
 * This asks VoIP.ms for the CDR and prints the split that matters when someone
 * says "I'm getting a lot of calls":
 *
 *   - how many were inbound and how many outbound
 *   - of those, answered / no answer / busy / failed
 *   - the noisiest inbound callers
 *   - every outbound call, with duration and cost (fraud shows up here, nowhere
 *     else)
 *
 * Credentials come from the environment — the script does not unlock the app's
 * vault, because a diagnostic that reimplements its key derivation would be a
 * second crypto surface to keep correct:
 *
 *   VOIPMS_API_USERNAME  the account email
 *   VOIPMS_API_PASSWORD  the API password from Main Menu → SOAP & REST/JSON API
 *
 *   node scripts/voipms-cdr.mjs                 last 24 hours
 *   node scripts/voipms-cdr.mjs --hours 72      a longer window
 *   node scripts/voipms-cdr.mjs --tz -0600      the account's timezone
 *   node scripts/voipms-cdr.mjs --json          every row, as JSON
 *   node scripts/voipms-cdr.mjs --debug         envelope and first raw row
 *
 * Exit codes: 0 clean, 1 the request or credentials failed, 2 the API answered
 * something this script could not read (so "zero calls" is never a guess),
 * 3 outbound calls were found.
 *
 * A carrier API is not a stable interface. Every way this can come back empty is
 * therefore distinguished: no rows because the window is quiet, rows that were
 * all outside the window, an envelope this script does not recognise, and rows
 * whose fields it could not parse. Only the first is a real zero.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (has('help') || has('h')) {
  console.log('usage: node scripts/voipms-cdr.mjs [--hours N] [--tz -0500] [--json] [--debug]');
  process.exit(0);
}

const hours = Number(flag('hours', '24'));
const tz = flag('tz', process.env.VOIPMS_TZ || '-0500');
const asJson = has('json');
const debug = has('debug');
const base = process.env.VOIPMS_API_BASE || 'https://voip.ms/api/v1/rest.php';

if (!/^-?\d{4}$/.test(tz)) {
  console.error(`--tz must look like -0500 (got "${tz}")`);
  process.exit(1);
}

/* ------------------------------------------------------------------ credentials */

const username = process.env.VOIPMS_API_USERNAME || '';
const password = process.env.VOIPMS_API_PASSWORD || '';

for (const [label, value] of [['VOIPMS_API_USERNAME', username], ['VOIPMS_API_PASSWORD', password]]) {
  if (!value) {
    console.error(`${label} is not set.`);
    console.error('Export it (or prefix this command with it) and run again.');
    console.error('The API credentials come from the portal: Main Menu → SOAP & REST/JSON API.');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------------ API */

async function api(method, params = {}) {
  const query = new URLSearchParams({
    api_username: username,
    api_password: password,
    method,
    content_type: 'json',
    ...params,
  });
  let response;
  try {
    response = await fetch(`${base}?${query}`, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`${method}: could not reach ${base} (${error.cause?.code || error.message})`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: the API answered ${response.status} with ${text.slice(0, 120)}`);
  }
  if (body.status && body.status !== 'success') {
    throw new Error(`${method}: ${body.status}${body.status_text ? ` — ${body.status_text}` : ''}`);
  }
  if (debug) console.error(`[debug] ${method} envelope keys: ${JSON.stringify(Object.keys(body))}`);
  return body;
}

/* ------------------------------------------------- at least say what we looked at */

const isoDay = (d) => d.toISOString().slice(0, 10);
const now = new Date();
// A day of margin: the API filters by calendar day in the account's timezone.
const from = isoDay(new Date(now.getTime() - (hours + 24) * 3600_000));
const to = isoDay(new Date(now.getTime() + 24 * 3600_000));

/**
 * The row list, wherever this build of the API puts it. Returning [] here would
 * be the silent-zero bug: an unrecognised envelope is a failure to read the
 * answer, not an answer of "no calls".
 */
function extractRows(body) {
  const candidates = [
    body?.cdr,
    body?.cdrs,
    body?.data?.cdr,
    body?.data?.cdrs,
    body?.data,
    body?.result?.cdr,
    body?.result,
    body?.records,
    body?.call_detail_records,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

try {
const cdr = await api('getCDR', { from, to, timezone: tz, answered: 1, noanswer: 1, busy: 1, failed: 1 });
const rawRows = extractRows(cdr);

if (rawRows === null) {
  console.error('getCDR answered successfully, but no call list was found in the response.');
  console.error(`Envelope keys: ${JSON.stringify(Object.keys(cdr))}`);
  if (debug) console.error(JSON.stringify(cdr).slice(0, 800));
  console.error('Refusing to report "no calls" from a response this script cannot read.');
  process.exit(2);
}

if (debug && rawRows[0]) console.error(`[debug] first row: ${JSON.stringify(rawRows[0]).slice(0, 600)}`);

// Our own numbers, so a row can be called inbound or outbound even when the API
// does not label the direction. Best effort: the breakdown still prints without it.
const own = new Set();
try {
  const info = await api('getDIDsInfo');
  const list = info.dids?.dids || info.dids || [];
  for (const entry of Array.isArray(list) ? list : []) {
    const number = String(entry.did || entry.number || '').replace(/\D/g, '').slice(-10);
    if (number) own.add(number);
  }
} catch {
  /* direction falls back to what the row itself says */
}

const tenDigits = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/** "2026-11-16 14:03:12" is the account's local time, as the API was asked. */
function parseStamp(value) {
  if (!value) return NaN;
  const text = String(value).trim().replace(' ', 'T');
  if (/T\d{2}:\d{2}(:\d{2})?Z$/.test(text)) return Date.parse(text);
  const offset = `${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
  return Date.parse(`${text.length <= 16 ? `${text}:00` : text}${offset}`);
}

const pick = (row, keys) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== '') return row[key];
  return '';
};

/** Normalise whatever this build calls a disposition, keeping the odd ones visible. */
function dispositionOf(row) {
  const raw = String(pick(row, ['disposition', 'status', 'result']) || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!raw) return 'unknown';
  if (raw.startsWith('answer')) return 'answered';
  if (raw.includes('no answer') || raw === 'noanswer' || raw.includes('unanswered') || raw.includes('missed')) return 'no answer';
  if (raw.includes('busy')) return 'busy';
  if (raw.includes('fail')) return 'failed';
  if (raw.includes('cancel')) return 'cancelled';
  return raw;
}

const cutoff = now.getTime() - hours * 3600_000;
const mapped = rawRows.map((row) => {
  const when = pick(row, ['date', 'date_time', 'datetime', 'start', 'start_time', 'time']);
  const caller = pick(row, ['callerid', 'caller_id', 'source', 'from', 'src']);
  const destination = pick(row, ['destination', 'did', 'to', 'dst']);
  const labelled = String(pick(row, ['type', 'direction', 'call_type', 'calltype']) || '').toLowerCase();
  let direction = 'unknown';
  if (labelled.includes('out')) direction = 'outbound';
  else if (labelled.includes('in')) direction = 'inbound';
  else if (own.size && own.has(tenDigits(destination))) direction = 'inbound';
  else if (own.size && own.has(tenDigits(caller))) direction = 'outbound';
  return {
    at: parseStamp(when),
    when,
    direction,
    caller,
    destination,
    disposition: dispositionOf(row),
    seconds: Number(pick(row, ['duration', 'seconds', 'billsec']) || 0),
    cost: Number(pick(row, ['total', 'cost', 'amount']) || 0),
  };
});

const unreadable = mapped.filter((row) => !Number.isFinite(row.at));
const recent = mapped.filter((row) => Number.isFinite(row.at) && row.at >= cutoff);

// Rows that came back but all fell outside the window usually mean the timezone
// or the date range is wrong — not that the account was quiet.
if (rawRows.length && !recent.length) {
  console.error(`getCDR returned ${rawRows.length} row(s), but none fell inside the last ${hours}h.`);
  console.error(`Window: ${new Date(cutoff).toISOString()} .. ${now.toISOString()} (timezone ${tz}).`);
  if (unreadable.length) {
    console.error(`${unreadable.length} row(s) had a date this script could not parse; first: ${JSON.stringify(unreadable[0].when)}`);
    console.error(`Row keys: ${JSON.stringify(Object.keys(rawRows[0] ?? {}))}`);
  } else {
    console.error('Check --tz (the API returns the account\'s local time) and --hours.');
  }
  console.error('Refusing to report "no calls" from rows that were all excluded.');
  process.exit(2);
}

// Some rows unreadable but others fine: report, but say how many were dropped.
const coverage = rawRows.length
  ? `API ${rawRows.length} row(s) · in window ${recent.length}` + (unreadable.length ? ` · unparsed ${unreadable.length}` : '')
  : 'API returned no rows at all';

if (asJson) {
  console.log(JSON.stringify({ windowHours: hours, timezone: tz, returned: rawRows.length, rows: recent }, null, 2));
} else {
  const inDir = (dir, row) => (dir ? row.direction === dir : true);
  const count = (dir, predicate = () => true) => recent.filter((row) => inDir(dir, row) && predicate(row)).length;
  const answered = (dir) => count(dir, (r) => r.disposition === 'answered');
  const noAnswer = (dir) => count(dir, (r) => r.disposition === 'no answer');
  const busy = (dir) => count(dir, (r) => r.disposition === 'busy');
  const failed = (dir) => count(dir, (r) => r.disposition === 'failed');
  const other = (dir) => count(dir, (r) => !['answered', 'no answer', 'busy', 'failed'].includes(r.disposition));

  console.log(`VoIP.ms CDR — last ${hours}h (timezone ${tz})`);
  console.log(`account ${String(username).replace(/^(.).*(@.*)$/, '$1***$2')} · ${coverage} · ${from}..${to} requested\n`);
  console.log('direction   total  answered  no-answer  busy  failed  other');
  for (const dir of ['inbound', 'outbound', 'unknown']) {
    const total = count(dir);
    if (dir === 'unknown' && total === 0) continue;
    console.log(
      `${dir.padEnd(11)} ${String(total).padStart(5)} ${String(answered(dir)).padStart(9)} ` +
      `${String(noAnswer(dir)).padStart(10)} ${String(busy(dir)).padStart(5)} ${String(failed(dir)).padStart(7)} ${String(other(dir)).padStart(6)}`
    );
  }
  const all = count();
  console.log(
    `${'all'.padEnd(11)} ${String(all).padStart(5)} ${String(answered()).padStart(9)} ` +
    `${String(noAnswer()).padStart(10)} ${String(busy()).padStart(5)} ${String(failed()).padStart(7)} ${String(other()).padStart(6)}`
  );

  if (!recent.length) {
    console.log('\nthe API returned no calls in this window — a real zero, not a parse failure.');
  }

  const callers = new Map();
  for (const row of recent) {
    if (row.direction !== 'inbound' || !row.caller) continue;
    callers.set(row.caller, (callers.get(row.caller) || 0) + 1);
  }
  if (callers.size) {
    const top = [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`\nnoisiest inbound callers (${callers.size} distinct)`);
    for (const [number, n] of top) console.log(`  ${String(n).padStart(4)}  ${number}`);
  }

  const outboundRows = recent.filter((r) => r.direction === 'outbound');
  if (outboundRows.length) {
    const spend = outboundRows.reduce((sum, r) => sum + (Number.isFinite(r.cost) ? r.cost : 0), 0);
    console.log(`\nOUTBOUND — ${outboundRows.length} call(s), ${spend.toFixed(2)} USD`);
    for (const row of outboundRows.slice(0, 20)) {
      console.log(`  ${row.when}  ${row.caller} -> ${row.destination}  ${row.disposition}  ${row.seconds}s  $${row.cost.toFixed(2)}`);
    }
    if (outboundRows.length > 20) console.log(`  … ${outboundRows.length - 20} more (rerun with --json)`);
  } else if (recent.length) {
    console.log('\nno outbound calls — nothing left this account on your trunk');
  }

  if (recent.length && !answered('inbound') && noAnswer('inbound')) {
    console.log('\nverdict: inbound-only traffic that was never answered — a spam/scanning flood, not toll fraud.');
  }
}

process.exit(recent.some((row) => row.direction === 'outbound') ? 3 : 0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
