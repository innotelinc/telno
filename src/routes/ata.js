import { db_ } from '../db/index.js';
import { config } from '../config.js';
import { ATA_PAGES } from '../lib/ata/ht802.js';
import { AtaDevice } from '../lib/ata/device.js';
import { PROFILE_KINDS, provisioningServer, provisioningUrl } from '../lib/provisioning.js';
import { logEvent } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

/**
 * The analog adaptor, from the console.
 *
 * This is not a proxy to the device's web page. The old page is what is being
 * replaced: it is served by a web server that writes malformed HTTP, it has no
 * idea what a Telno extension is, and its only account of a port is a table
 * cell. So the platform reads the box through the client in `lib/ata/ht802.js`
 * and answers with normal JSON — reachability, lockout, ports, SIP account —
 * and the console renders that.
 *
 * Two rules keep this safe to point at real hardware:
 *
 *  - The password never leaves the server. It is read from the environment and
 *    used to open a session; no endpoint echoes it back, and no page renders it.
 *  - Nothing here retries a login. Five refusals cost 15 minutes of console, so
 *    a locked device is reported as locked and the password field is left alone
 *    until its timer runs out.
 */

const PAGE_IDS = new Set(ATA_PAGES.map((page) => page.id));

/** Probe results are short-lived: every request costs a socket to real hardware. */
const cache = new Map();

function deviceFor(host, port) {
  // The facade asks the box which firmware it runs, so one route serves both
  // the mini_httpd units and the TLS ones without an installer picking.
  return new AtaDevice({
    host,
    port,
    password: config.ata.password,
    username: config.ata.username,
    timeoutMs: config.ata.timeoutMs,
  });
}

function targetFromConfig() {
  if (!config.ata.host) return null;
  return { id: 'configured', host: config.ata.host, port: config.ata.port, source: 'environment' };
}

/** Inventory rows of kind `ata`, which is where a named unit lives. */
function ataDevices() {
  return db_
    .all("SELECT * FROM devices WHERE kind = 'ata' ORDER BY name")
    .map((row) => ({ id: row.id, name: row.name, host: row.ip || '', port: config.ata.port, mac: row.mac, model: row.model, status: row.status }));
}

async function probe(target, { refresh = false } = {}) {
  const key = `${target.host}:${target.port}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < config.ata.cacheSeconds * 1000) {
    return { ...hit.value, cached: true };
  }
  const view = await deviceFor(target.host, target.port).overview({ refresh });
  cache.set(key, { at: Date.now(), value: view });
  return { ...view, cached: false };
}

function resolveTarget(id) {
  const devices = ataDevices();
  if (id && id !== 'configured') {
    const row = devices.find((item) => item.id === id);
    if (!row) throw notFound('No analog adaptor with that id');
    if (!row.host) throw badRequest(`${row.name} has no IP address on file`);
    return row;
  }
  const configured = targetFromConfig();
  if (configured) return configured;
  const first = devices.find((row) => row.host);
  if (first) return first;
  throw notFound('No analog adaptor is configured. Set ATA_HOST, or give an ATA row an IP address.');
}

export default async function ataRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  app.get('/ata/targets', async () => {
    const configured = targetFromConfig();
    return {
      items: ataDevices(),
      configured: configured ? { host: configured.host, port: configured.port } : null,
      // Said plainly because it is the one thing that cannot be recovered from
      // the console: a missing password is a deployment edit, not a bug.
      passwordSet: Boolean(config.ata.password),
      cacheSeconds: config.ata.cacheSeconds,
    };
  });

  app.get('/ata/state', async (request) => {
    const target = resolveTarget(request.query?.id);
    return { target, ...(await probe(target, { refresh: request.query?.refresh === '1' })) };
  });

  /**
   * The raw page, for the one case JSON cannot cover: a firmware whose field
   * names differ from every known layout. Staff only, and only for page ids in
   * the known set — the client is not a general fetcher, so this cannot be used
   * to reach anything else on the network.
   */
  app.get('/ata/pages/:id', async (request) => {
    const id = String(request.params.id || '');
    if (!PAGE_IDS.has(id)) throw badRequest(`Unknown page. Known pages: ${[...PAGE_IDS].join(', ')}`);
    // Device pages carry the whole configuration, including the SIP secret, so
    // an API key is not enough to read one: it takes a signed-in operator.
    if (!request.account) throw forbidden('Sign in to read device configuration pages');
    const target = resolveTarget(request.query?.id);
    const page = await deviceFor(target.host, target.port).page(id);
    return { id, status: page.status, junk: page.junk, html: page.html.slice(0, 200_000) };
  });

  app.get('/ata/pages', async () => ({ items: ATA_PAGES }));

  /** The address to type into the device's own provisioning field. */
  app.get('/ata/provisioning', async (request) => {
    const devices = ataDevices();
    const target = request.query?.id ? devices.find((row) => row.id === request.query.id) : devices[0];
    const mac = target?.mac || '';
    return {
      server: provisioningServer(),
      // The Cantus profile stays the default. `compat` is offered for a unit
      // that has no edge in front of it yet, and is the only kind in its own
      // schema — opt-in, never assumed.
      format: PROFILE_KINDS.includes(String(request.query?.format || '')) ? request.query.format : 'terminal',
      formats: PROFILE_KINDS,
      sipDomain: config.provisioning.sipDomain,
      sipPort: config.provisioning.sipPort,
      // The file is named after the MAC, which is why the inventory row needs
      // one before the box can pull anything.
      fileUrl: mac ? provisioningUrl({ mac }, PROFILE_KINDS.includes(String(request.query?.format || '')) ? request.query.format : 'terminal') : null,
      mac: mac || null,
      // The adaptor is a SIP endpoint and Cantus is not SIP, so what it is told
      // to register against depends on whether this deployment has an edge.
      voice: config.cantus.sipEdge || config.cantus.enabled
        ? {
            protocol: 'cantus',
            version: '1.0',
            host: config.cantus.host || null,
            port: config.cantus.port,
            realm: config.cantus.realm,
            sipEdge: config.cantus.sipEdge || null,
            note: config.cantus.sipEdge
              ? `The adaptor speaks SIP to ${config.cantus.sipEdge}; the edge carries the call over Cantus on ${config.cantus.port}/udp. Fax is out of scope on Cantus, so a fax machine needs its own SIP path.`
              : `Cantus is enabled but no SIP edge is configured, so the adaptor falls back to ${config.provisioning.sipDomain}:${config.provisioning.sipPort} over SIP.`,
          }
        : null,
      steps: [
        'Add the unit to the estate with its MAC, then send it this profile.',
        `Point the unit's provisioning server at ${provisioningServer()}.`,
        'Set the requested file name to the MAC in lower case with no separators.',
        'Reboot it: it fetches its line, its reach details and its check-in token in one go.',
      ],
    };
  });

  app.post('/ata/reboot', { preHandler: requireWrite }, async (request) => {
    const target = resolveTarget(request.body?.id || request.query?.id);
    const result = await deviceFor(target.host, target.port).reboot();
    // The cached snapshot is now a lie: the box is going down.
    cache.delete(`${target.host}:${target.port}`);
    logEvent({
      actor: request.account?.email || 'api',
      action: 'estate.ata_rebooted',
      subject: target.name || target.host,
      detail: `reboot requested at ${target.host}:${target.port}`,
      ip: request.ip,
    });
    return result;
  });
}
