import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Anchored at the repository root rather than the process cwd: npm workspaces
 * run scripts with the package directory as cwd, and a relative database or
 * vendor path must not depend on which package started the server.
 */
export const repoRoot = resolve(import.meta.dirname, '../../..');

const fromRoot = (value: string): string => (isAbsolute(value) ? value : resolve(repoRoot, value));

function loadDotEnv(): void {
  const file = resolve(repoRoot, '.env');
  if (!existsSync(file)) return;
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
    // .env is authoritative for the keys it defines. Launchers and shells
    // routinely export placeholder PORT values ("0", ""), and a service that
    // must be reachable at a fixed address cannot honour those silently.
    if (value !== '') process.env[key] = value;
  }
}

loadDotEnv();

const num = (value: string | undefined, fallback: number): number => {
  const text = value?.trim();
  if (!text) return fallback; // "" and "  " mean "unset", not zero
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
};

/** A port is a fixed address here: 0 would bind an ephemeral one and break devices and the proxy. */
const port = (value: string | undefined, fallback: number): number => {
  const n = num(value, fallback);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
};

export const env = {
  port: port(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: fromRoot(process.env.TELNO_DB ?? '.data/telno.db'),
  /**
   * Where a release archive waits for the installer. Next to the database by
   * default, so both live on the volume rather than inside the image.
   */
  releasesDir: fromRoot(process.env.TELNO_RELEASES ?? '.data/releases'),
  adminUser: process.env.TELNO_ADMIN_USER ?? 'admin',
  /** Empty means "generate one on first boot and print it once". */
  adminPassword: process.env.TELNO_ADMIN_PASSWORD?.trim() ?? '',
  provisioningKey: process.env.TELNO_PROVISIONING_KEY ?? '',
  cantusDir: fromRoot(process.env.TELNO_CANTUS_DIR ?? 'vendor/cantus'),
  perl: process.env.TELNO_PERL ?? 'perl',
  voiceNode: process.env.TELNO_VOICE_NODE ?? '',
  voicePort: port(process.env.TELNO_VOICE_PORT, 7443),
  voiceRelay: process.env.TELNO_VOICE_RELAY ?? '',
  /**
   * Admin password for analog adaptors' own web consoles. Never leaves the
   * server: it is used to open a session and is never returned by an endpoint.
   */
  ataPassword: process.env.TELNO_ATA_PASSWORD ?? '',
  ataUser: process.env.TELNO_ATA_USER ?? 'admin',
  ataTimeoutMs: num(process.env.TELNO_ATA_TIMEOUT_MS, 6000),
  isProduction: process.env.NODE_ENV === 'production',
  /**
   * Console allowlist. Defaults to loopback plus the RFC 1918 ranges: the
   * console is an administrative surface, and "anywhere on the internet" is
   * never a sane default. Tighten it in Settings.
   */
  trustedNetworks:
    process.env.TELNO_TRUSTED_NETWORKS ??
    '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  /** True when the deployment set the allowlist explicitly, rather than the default. */
  trustedNetworksExplicit: Boolean(process.env.TELNO_TRUSTED_NETWORKS?.trim()),
  /** Port the bundled TLS terminator listens on. */
  tlsPort: port(process.env.TLS_PORT, 8443),
};
