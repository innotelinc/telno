import { config } from '../config.js';

/**
 * Device profiles.
 *
 * This replaces the per-manufacturer template approach, where every handset
 * model got its own key names and its own idea of what a line is. Those files
 * existed to speak three dialects of SIP, and the platform speaks one protocol:
 * Cantus. So there is one profile format now, written by us, and it describes
 * the platform rather than transcribing somebody else's firmware:
 *
 *   telno   — our own JSON document, Cantus-native. This is what a Telno
 *             endpoint (softphone, desk client, edge) consumes.
 *   terminal— the same identity and reach information in XML, for the thing on
 *             the wall: a SIP↔Cantus edge, or a gateway that fronts legacy
 *             analog hardware. No vendor schema, no vendor branding.
 *
 * A device still checks in and still fetches its file by MAC, so nothing about
 * the inventory, the token rotation or the public endpoint changes. What changes
 * is what comes back: a description of the platform, not a transcription of
 * somebody else's firmware.
 */

export const PROFILE_KINDS = ['telno', 'terminal', 'compat'];

/**
 * `compat` is the one deliberate exception to "no vendor schemas".
 *
 * A stock adaptor parses nothing but its own configuration format, and it will
 * not fetch a Telno profile no matter how correct that profile is. So there is a
 * serializer that emits the unit's own schema — opt-in, chosen per device, never
 * the default, and confined to this one function. The Cantus profile remains the
 * profile; this is the adapter that lets a box on a wall join in before it has an
 * edge in front of it.
 *
 * Every parameter written here was read back off the live unit rather than taken
 * from a manual: P271/P401 (port active), P35/P735 (SIP user), P3/P703 (auth
 * password), P47/P747 (SIP server), P40/P740 (local SIP port). Nothing else is
 * emitted, because a P-number nobody verified is a setting that silently blanks
 * something the operator needed.
 */

const base = () => config.publicUrl.replace(/\/$/, '');
const checkInUrl = () => `${base()}/api/devices/heartbeat`;

/** The Cantus endpoint a Telno device registers with. */
export function cantusEndpoint() {
  const host = config.cantus.host || config.provisioning.sipDomain;
  return `cantus://${host}:${config.cantus.port}`;
}

/** URL the device fetches, by MAC. */
export function provisioningUrl(device, kind = 'telno') {
  const mac = String(device?.mac || '').replace(/[^A-Fa-f0-9]/g, '').toLowerCase();
  const ext = kind === 'telno' ? 'json' : 'xml';
  return `${config.provisioning.baseUrl}/provision/${kind}/${mac || 'unknown'}.${ext}`;
}

export const provisioningServer = () => config.provisioning.baseUrl;

// Capability ids are Cantus's, in preference order: the caller's order wins.
const CAPABILITIES = ['opus/48000/2', 'pcmu/8000/1', 'pcma/8000/1'];

function identityBlock({ device, extension }) {
  if (!extension) return null;
  return {
    extension: extension.extension,
    displayName: extension.display_name,
    // The credential is in the profile because the profile is the only thing a
    // fresh endpoint has; the check-in token is separate and rotates.
    secret: extension.secret,
    label: String(device?.name || extension.display_name || 'Telno').slice(0, 40),
  };
}

function voiceBlock() {
  return {
    protocol: 'cantus',
    version: '1.0',
    endpoint: cantusEndpoint(),
    realm: config.cantus.realm,
    capabilities: CAPABILITIES,
    // Reach is always on in Cantus: the relay mapping is kept for the life of
    // the endpoint, so there is no nat_* knob to get wrong here.
    traversal: 'reach',
    media: 'single-socket',
  };
}

/** The SIP side, only when a SIP↔Cantus edge has been configured. */
function edgeBlock() {
  if (!config.cantus.sipEdge) return null;
  return {
    role: 'legacy-terminal',
    register: `sip:${config.cantus.sipEdge}`,
    transport: `udp/${config.provisioning.sipPort}`,
    bridgedTo: cantusEndpoint(),
    // Stated in the profile because an operator will otherwise assume it works.
    fax: 'unsupported-on-cantus',
  };
}

function telnoProfile({ device, extension, token }) {
  const doc = {
    profile: 'telno-device/1',
    issuedAt: new Date().toISOString(),
    device: {
      name: device?.name || 'Telno endpoint',
      mac: device?.mac || null,
      kind: device?.kind || 'handset',
    },
    lines: identityBlock({ device, extension }) ? [identityBlock({ device, extension })] : [],
    voice: voiceBlock(),
    sip: edgeBlock(),
    checkIn: {
      url: checkInUrl(),
      token,
      intervalSec: config.devices.checkInSec,
    },
  };
  return {
    fileName: `${slug(device?.name)}.json`,
    contentType: 'application/json',
    body: `${JSON.stringify(doc, null, 2)}\n`,
  };
}

const xmlEscape = (value) =>
  String(value ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/**
 * The terminal profile.
 *
 * Same facts as the JSON profile, in the shape a firmware on a wall can parse.
 * Deliberately not a vendor schema: `<telno-profile>` is ours, and the element
 * names describe the platform (voice, reach, checkin) rather than a phone menu.
 */
function terminalProfile({ device, extension, token }) {
  const line = identityBlock({ device, extension });
  const lines = line
    ? `\n    <line index="1">
      <extension>${xmlEscape(line.extension)}</extension>
      <display-name>${xmlEscape(line.displayName)}</display-name>
      <secret>${xmlEscape(line.secret)}</secret>
    </line>`
    : '\n    <!-- No extension is attached to this device. -->';
  const edge = edgeBlock();
  const edgeXml = edge
    ? `\n    <edge role="${xmlEscape(edge.role)}">
      <register>${xmlEscape(edge.register)}</register>
      <transport>${xmlEscape(edge.transport)}</transport>
      <bridged-to>${xmlEscape(edge.bridgedTo)}</bridged-to>
      <fax>${xmlEscape(edge.fax)}</fax>
    </edge>`
    : '';
  return {
    fileName: `${slug(device?.name)}.xml`,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<telno-profile version="1">
  <device>
    <name>${xmlEscape(device?.name || 'Telno endpoint')}</name>
    <mac>${xmlEscape(device?.mac || '')}</mac>
    <kind>${xmlEscape(device?.kind || 'handset')}</kind>
  </device>
  <voice>
    <protocol>cantus</protocol>
    <version>1.0</version>
    <endpoint>${xmlEscape(cantusEndpoint())}</endpoint>
    <realm>${xmlEscape(config.cantus.realm)}</realm>
    <traversal>reach</traversal>
    <capability>${CAPABILITIES.join('</capability>\n    <capability>')}</capability>
  </voice>${edgeXml}
  <lines>${lines}
  </lines>
  <checkin url="${xmlEscape(checkInUrl())}" interval="${config.devices.checkInSec}">${xmlEscape(token)}</checkin>
</telno-profile>
`,
  };
}

function compatProfile({ device, extension, token }) {
  const line = identityBlock({ device, extension });
  const server = config.cantus.sipEdge
    ? config.cantus.sipEdge.split(':')[0]
    : config.provisioning.sipDomain;
  const port = String(config.provisioning.sipPort);
  const portTwoOff = '<P401>0</P401>';

  const accountOne = line
    ? `<P271>1</P271>
      <P35>${xmlEscape(line.extension)}</P35>
      <P3>${xmlEscape(line.secret)}</P3>
      <P47>${xmlEscape(server)}</P47>
      <P40>${xmlEscape(port)}</P40>`
    : '<P271>0</P271>';

  return {
    fileName: `${slug(device?.name)}.xml`,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Telno compatibility profile.
     This file exists because a stock adaptor only parses this format. The Telno
     profile (telno-device/1, JSON) is the real one; fetch that when the device
     sits behind a SIP edge instead. Voice on this deployment: Cantus 1.0. -->
<gs_provision version="1">
  <config version="1">
    ${accountOne}
    ${portTwoOff}
    <P140>${xmlEscape(checkInUrl())}</P140>
    <P141>${xmlEscape(token)}</P141>
    <P142>${config.devices.checkInSec}</P142>
  </config>
</gs_provision>
`,
  };
}

export function buildProfile(kind, payload) {
  if (kind === 'compat') return compatProfile(payload);
  return kind === 'terminal' ? terminalProfile(payload) : telnoProfile(payload);
}

const slug = (name) =>
  String(name || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'device';
