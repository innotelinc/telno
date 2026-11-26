import { config } from '../config.js';
import { db_, now } from '../db/index.js';

/**
 * The routing document, as a Cantus gateway reads it.
 *
 * A gateway has to answer two questions per call — may this number leave, and
 * where does a number we own go — and until now the answer lived in a JSON file
 * next to the gateway, kept in step by hand. That is a second copy of the
 * switch's own rules, and a second copy is a copy that drifts: a DID moved to
 * another line in this console and a call still landing on the old one, with
 * nothing to compare against.
 *
 * So the document is derived from the same rows the dialplan is generated from:
 * `numbers` (which DID is ours, and whether it is voice or fax), `extensions`
 * (which line behind it), `trunks` (whether the platform may place calls at all)
 * and the operator's `routing.outbound` setting (which numbers an extension may
 * dial). Nothing here decides anything itself; it states the rules, and the
 * gateway evaluates them.
 *
 * `ext:` targets are lines on this platform, `pstn:` means the public network,
 * and a bare `pstn:` in a forward means "the number that was dialled". When
 * this deployment has a Cantus edge (`CANTUS_SIP_EDGE`), an inbound DID names
 * its extension as `sip:` instead: the call is placed over SIP to the switch
 * that holds the extension, which is where a browser softphone lives.
 */

const digitsOf = (value) => String(value || '').replace(/\D/g, '');

/**
 * Where a DID for this extension goes. `ext:` is a line the edge reaches over
 * Cantus; with an edge configured, the extension is answered by a SIP switch
 * (its softphone and its desk phone both ring), so the rule says `sip:`.
 */
export const inboundTarget = (extension) =>
  config.cantus.sipEdge && config.cantus.edgeSecret ? `sip:${extension}` : `ext:${extension}`;

/** Where an extension may dial out to. A setting, because it is a policy. */
export const OUTBOUND_KEY = 'routing.outbound';

/** The operator's outbound patterns, or the two this platform has always had. */
export function outboundPatterns() {
  const raw = db_.get('SELECT value FROM settings WHERE key = ?', [OUTBOUND_KEY])?.value;
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const list = Array.isArray(parsed) && parsed.length ? parsed : [{ to: '1*' }, { to: '+*' }];
  return list
    .map((item) => (typeof item === 'string' ? { to: item } : item || {}))
    .map((item) => ({
      to: String(item.to || '').trim(),
      name: String(item.name || '').trim(),
      destination: String(item.destination || 'pstn:').trim(),
    }))
    // A pattern is a glob over the dialled digits, not a dial plan: anything
    // longer is a typo that would silently match nothing.
    .filter((item) => item.to && item.to.length <= 24);
}

/**
 * Build the document.
 *
 * Route order is the document's meaning: the first match wins, so the numbers
 * this platform owns are listed before the outbound patterns. Dialling one of
 * our own DIDs therefore lands on its line instead of hairpinning out to the
 * carrier and back.
 */
export function routingDocument({ generatedAt = now() } = {}) {
  const trunks = db_.all('SELECT name, host FROM trunks WHERE enabled = 1 ORDER BY name');
  const numbers = db_.all(`
    SELECT n.e164, n.fax_mode, n.status,
           e.extension, e.enabled AS line_enabled
      FROM numbers n
      LEFT JOIN extensions e ON e.number_id = n.id
     WHERE n.status <> 'retired'
     ORDER BY n.e164`);

  const routes = [];
  const names = new Set();
  const add = (route) => {
    // The name is the handle a CDR quotes back at an operator, so two rules may
    // never share one: the second would be unreachable and look like a bug.
    if (!route || names.has(route.name)) return;
    names.add(route.name);
    routes.push(route);
  };

  for (const row of numbers) {
    const digits = digitsOf(row.e164);
    if (!digits) continue;
    // Carriers differ on what they put in the request URI for a North American
    // number: some send eleven digits, some ten. The dialplan aliases the short
    // form for the same reason, so the document does too.
    const forms = [digits, digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : ''].filter(Boolean);

    if (row.fax_mode === 'fax') {
      for (const form of forms) {
        add({ name: `did-${form}-fax`, when: { to: form }, then: [{ reject: 3 }] });
      }
      continue;
    }
    if (!row.extension || !row.line_enabled) {
      // Ours, but nothing answers it. Refusing is honest; answering and then
      // playing silence is a call the caller cannot tell from a bad line.
      for (const form of forms) {
        add({ name: `did-${form}-unrouted`, when: { to: form }, then: [{ reject: 3 }] });
      }
      continue;
    }
    for (const form of forms) {
      add({
        name: `did-${form}`,
        when: { to: form },
        then: [{ answer: {} }, { forward: { to: inboundTarget(row.extension) } }],
      });
    }
  }

  if (trunks.length) {
    for (const rule of outboundPatterns()) {
      add({
        // The pattern itself is the readable name: `outbound-1*` says what it
        // matches, and stays put when another rule is added above it.
        name: `outbound-${rule.name || rule.to}`,
        when: { to: rule.to },
        then: [{ forward: { to: rule.destination } }],
      });
    }
  }

  return {
    version: 1,
    generator: 'telno',
    generated_at: generatedAt,
    // A number nothing claims is refused, not answered: a gateway that answers
    // what no rule covers bills for silence and hides a misrouted DID.
    default: { reject: 3 },
    routes,
  };
}

/** The same document as bytes, so a fetch and an export are identical. */
export const routingDocumentJson = (opts) => `${JSON.stringify(routingDocument(opts), null, 2)}\n`;
