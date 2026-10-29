#!/usr/bin/env node
/**
 * Starts the TLS terminator (Caddy) for the Telno console.
 *
 *   npm run proxy
 *
 * The control plane stays bound to loopback; Caddy is the only process on the
 * network. It uses its internal CA, which is installed into the *user* trust
 * store on first run — no elevation, and Chromium/Edge honour it immediately.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** .env is authoritative for the keys it defines, same rule as the server. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const vars = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) vars[key] = value;
  }
  return vars;
}

const fileEnv = readEnvFile(resolve(repoRoot, '.env'));
const setting = (key, fallback) => fileEnv[key] ?? process.env[key] ?? fallback;

const portSetting = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
};

function findCaddy() {
  const candidates = [
    process.env.CADDY_BIN,
    resolve(repoRoot, 'tools/caddy/caddy.exe'),
    resolve(repoRoot, 'tools/caddy/caddy'),
    'caddy',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'caddy') {
      const probe = spawnSync('caddy', ['version'], { stdio: 'ignore' });
      if (!probe.error) return 'caddy';
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const caddy = findCaddy();
if (!caddy) {
  console.error('Caddy was not found.');
  console.error('Download it into tools/caddy (no install needed):');
  console.error('  https://github.com/caddyserver/caddy/releases (windows_amd64)');
  console.error('or set CADDY_BIN to an existing caddy binary.');
  process.exit(1);
}

const env = {
  ...process.env,
  APP_PORT: String(portSetting(setting('APP_PORT', setting('PORT', '8791')), 8791)),
  TLS_PORT: String(portSetting(setting('TLS_PORT', '8443'), 8443)),
  TLS_ADDRESSES: setting('TLS_ADDRESSES', 'https://localhost:8443'),
};

if (!env.TLS_ADDRESSES.includes(':8443') && !env.TLS_ADDRESSES.includes(`:${env.TLS_PORT}`)) {
  console.warn(`Note: TLS_ADDRESSES does not include port ${env.TLS_PORT}.`);
}

console.log(`Caddy (${spawnSync(caddy, ['version'], { encoding: 'utf8' }).stdout?.trim() || 'unknown'})`);
console.log(`  addresses  ${env.TLS_ADDRESSES}`);
console.log(`  upstream   http://127.0.0.1:${env.APP_PORT}`);
for (const address of env.TLS_ADDRESSES.split(',').map((entry) => entry.trim())) {
  console.log(`  serving    ${address}`);
}

const child = spawn(
  caddy,
  ['run', '--config', resolve(repoRoot, 'Caddyfile'), '--adapter', 'caddyfile'],
  { cwd: repoRoot, env, stdio: 'inherit' },
);

const stop = () => {
  child.kill();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
