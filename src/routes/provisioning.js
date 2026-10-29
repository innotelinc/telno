import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { buildProfile, cantusEndpoint, provisioningServer } from '../lib/provisioning.js';
import { newDeviceToken } from '../lib/security.js';
import { logEvent } from '../lib/audit.js';

/**
 * Auto-provisioning, at the root rather than under /api.
 *
 * A desk phone has no session and no cookie: it boots, asks DHCP for Option 66
 * (or dials the URL somebody typed into its web page) and fetches a file named
 * after its own MAC. So this has to be reachable without authentication, which
 * is exactly why the only thing it will answer for is a MAC that is already in
 * the inventory — a stranger cannot enumerate extensions here.
 *
 * `telno.tel` is the address handed out. The same name is the SIP domain in the
 * generated config, so the URI a handset registers is sip:<extension>@telno.tel
 * whether it came from this file or was typed in by hand.
 */

const KIND_BY_EXT = { json: 'telno', xml: 'terminal' };

function resolveKind(kind, file) {
  const clean = String(kind || '').toLowerCase();
  if (['telno', 'terminal', 'compat'].includes(clean)) return clean;
  const ext = String(file || '').toLowerCase().split('.').pop();
  return KIND_BY_EXT[ext] || 'telno';
}

/** A phone asks with whatever its firmware prefers; compare on hex only. */
function deviceByMac(raw) {
  const hex = String(raw || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return db_.get('SELECT * FROM devices WHERE UPPER(REPLACE(mac, \':\', \'\')) = ?', [hex]) || null;
}

function serve(request, reply, kindParam, file) {
  if (!config.provisioning.enabled) {
    reply.status(404).type('text/plain');
    return 'Provisioning is disabled on this deployment.\n';
  }
  // A terminal may ask for a shared file before its own; the MAC decides what is
  // served, so an unknown name simply falls through to the 404 below.
  const base = String(file || '').replace(/\.(cfg|xml|boot)$/i, '');
  const device = deviceByMac(base);
  if (!device) {
    request.log.info({ file }, 'provisioning request for an unknown MAC');
    reply.status(404).type('text/plain');
    return 'This MAC is not in the device inventory.\n';
  }

  const kind = resolveKind(kindParam, file);
  const extension = device.extension_id
    ? db_.get('SELECT * FROM extensions WHERE id = ?', [device.extension_id])
    : null;
  // The config is the only copy of the token, so fetching it rotates the token.
  // A handset that has the file can check in; one that never fetched it cannot.
  const token = newDeviceToken();
  db_.run('UPDATE devices SET token_hash = ?, status = ?, updated_at = ? WHERE id = ?', [
    token.hash,
    device.status === 'online' ? 'online' : 'provisioning',
    now(),
    device.id,
  ]);

  const built = buildProfile(kind, {
    device: { name: device.name, mac: device.mac, kind: device.kind, label: extension?.extension || device.name },
    extension,
    token: token.secret,
  });

  logEvent({
    actor: 'device',
    action: 'estate.device_provisioned',
    subject: device.name,
    detail: `${kind} profile fetched by ${device.mac} from ${request.ip}`,
    ip: request.ip,
  });

  reply
    .type(built.contentType)
    .header('Cache-Control', 'no-store')
    .header('Content-Disposition', `attachment; filename="${device.mac.replace(/:/g, '').toLowerCase()}.${kind === 'terminal' ? 'xml' : 'json'}"`);
  return built.body;
}

export async function registerProvisioning(app) {
  app.get(
    '/provision',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.type('text/plain');
      return [
        'Telno device profiles',
        '',
        `Point the device (or DHCP option 66) at: ${provisioningServer()}`,
        '',
        'It then fetches its own profile by MAC:',
        `  Telno endpoint   ${provisioningServer()}/provision/telno/<mac>.json`,
        `  Terminal         ${provisioningServer()}/provision/terminal/<mac>.xml`,
        `  Stock unit       ${provisioningServer()}/provision/compat/<mac>.xml`,
        '    (the last one is the device\'s own schema, for a box with no edge in front of it)',
        '',
        `Voice protocol in every profile: Cantus 1.0 at ${cantusEndpoint()}.`,
        config.cantus.sipEdge
          ? `Legacy terminals register over SIP against ${config.cantus.sipEdge}, which bridges to Cantus.`
          : 'No SIP edge is configured, so profiles carry no SIP registration block.',
        'A MAC that is not in the inventory gets 404, so this cannot be used to enumerate extensions.',
        '',
      ].join('\n');
    }
  );

  app.get(
    '/provision/:vendor/:file',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => serve(request, reply, request.params.vendor, request.params.file)
  );

  app.get(
    '/provision/:file',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => serve(request, reply, '', request.params.file)
  );
}

export default registerProvisioning;
