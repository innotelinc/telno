#!/usr/bin/env node
/**
 * Probe the analog adaptor and print what the console would show.
 *
 *   ATA_HOST=192.168.1.45 ATA_PASSWORD=... npm run ata:check
 *   ATA_HOST=192.168.1.45 ATA_PASSWORD=... npm run ata:check -- --json
 *
 * This exists because the device's own web server cannot be talked to with curl
 * (it writes two status lines and leaks its CGI shebang as a header), so a
 * one-line `curl` is not a way to tell "the box is down" from "the box is fine".
 * The client reads the lockout counter first and never spends a password attempt
 * on a device that is counting.
 */
import { Ht802 } from '../src/lib/ata/ht802.js';

const asJson = process.argv.includes('--json');
const host = process.env.ATA_HOST || '';

if (!host) {
  console.error('Set ATA_HOST to the adaptor address, e.g. ATA_HOST=192.168.1.45');
  process.exit(2);
}

const device = new Ht802({
  host,
  port: Number(process.env.ATA_PORT || 80),
  password: process.env.ATA_PASSWORD || '',
  timeoutMs: Number(process.env.ATA_TIMEOUT_MS || 6000),
});

const view = await device.overview();

if (asJson) {
  console.log(JSON.stringify(view, null, 2));
  process.exit(view.reachable ? 0 : 1);
}

const line = (label, value) => console.log(`${label.padEnd(22)} ${value ?? '—'}`);

line('Target', view.target.label);
line('State', view.state);
line('Reachable', view.reachable ? 'yes' : 'no');
if (view.lock) {
  line('Lockout', view.locked ? `locked, ${view.remainSec}s left` : 'not locked');
  line('Failed logins', view.lock.invalidAttempts);
}
line('Signed in', view.authenticated ? 'yes' : 'no');
line('Model', view.identity?.model);
line('Firmware', view.identity?.firmware);
line('Serial', view.identity?.serial);
line('MAC', view.identity?.mac);
line('Uptime', view.identity?.uptime);
line('Voice image', view.system?.voiceImage);
for (const port of view.ports) {
  line(`FXS ${port.port}`, [port.hook, port.registration].filter(Boolean).join(' / ') || 'no state reported');
}
line('Probe time', `${view.tookMs} ms`);
for (const note of view.notes) console.log(`\n! ${note}`);

// A locked or unreachable box is a finding, not a crash: say so in the status.
process.exit(view.reachable ? 0 : 1);
